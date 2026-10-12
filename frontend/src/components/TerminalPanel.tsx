import { t } from "../i18n";
import { useStore } from "../useStore";
import { Fragment, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";
import { Segmented } from "./Segmented";
import "@xterm/xterm/css/xterm.css";
import type { ShellKind, TerminalInfo } from "../types";
import { createTerminal, fetchTerminals, killTerminal } from "../api";
import {
  isTerminalToggleKey,
  isTerminalPasteKey,
  isTerminalCopyKey,
  createTermTitlebarGesture,
  terminalShellOptions,
  TERM_ACTIVE_STORAGE_KEY,
  TERM_SHORTCUT_KEYS,
  buildTerminalWsUrl,
  buildTermTabs,
  initialTermState,
  pickBootTerminal,
  pickRecentTerminal,
  pickAdjacentTerminal,
  pickTerminalCwd,
  reduceTermFrame,
  type TermSessionState,
} from "../terminal";
import { store } from "../store";
import { FONT_SCALE_EVENT } from "../font-scale";
import { readTermFontSize } from "../body-font";

/** xterm 主题字段 ← --term-* 令牌；通过 color 属性解析 light-dark()。 */
const TERM_THEME_VARS: [keyof ITheme, string][] = [
  ["foreground", "--term-fg"],
  ["background", "--term-bg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-bg"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"],
];

function readTermTheme(): ITheme {
  const theme: Record<string, string> = {};
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(probe);
  try {
    for (const [key, varName] of TERM_THEME_VARS) {
      probe.style.color = `var(${varName})`;
      theme[key] = getComputedStyle(probe).color;
    }
  } finally {
    probe.remove();
  }
  return theme as ITheme;
}

// shell 提示符（starship 等）用 Nerd Font 图标；先列用户 VSCode 终端同款（Maple Mono NF CN）与本机已装的
// JetBrainsMono Nerd Font，没装的浏览器自动落到 --font-mono，图标显示成方框但文字不受影响
const NERD_FONTS = '"Maple Mono NF CN", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font"';

function readTermFontFamily(): string {
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return mono ? `${NERD_FONTS}, ${mono}` : `${NERD_FONTS}, monospace`;
}

interface TermRuntime {
  focus: () => void;
  fit: () => void;
  isAtTop: () => boolean;
  sendInput: (data: string) => void;
  paste: (text: string) => void;
  /** 复制选区到剪贴板并清除选区；没有选区返回 false。 */
  copySelection: () => boolean;
  createNew: (kind: ShellKind) => Promise<void>;
  switchTo: (id: string) => void;
  switchShell: (kind: ShellKind) => Promise<void>;
  closeExited: (id: string) => void;
  reconnectNow: () => void;
}

function readSavedActiveTerminalId(): string | null {
  try {
    return localStorage.getItem(TERM_ACTIVE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSavedActiveTerminalId(id: string | null): void {
  try {
    if (id) localStorage.setItem(TERM_ACTIVE_STORAGE_KEY, id);
    else localStorage.removeItem(TERM_ACTIVE_STORAGE_KEY);
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

/**
 * 终端面板（工作区级，不绑会话）。挂载后常驻：隐藏只是 CSS display:none，
 * xterm 实例、WS 连接与服务端 PTY 全部保留。标签条列出服务端全部未退出终端
 * （当前激活的已退出终端也保留，看输出与退出码）；「＋」新建当前 kind 的终端。
 * 切标签 = detach 旧的 + attach 新的（服务端回放 scrollback）；刷新后优先重连
 * localStorage 记的激活 id，其次第一个未退出终端，都没有就新建 bash。
 */
export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const powershell = useStore(value => value.meta?.capabilities.powershell === true);
  const shellOptions = terminalShellOptions(powershell);
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useSidePanelWidth();
  const [maximized, setMaximized] = useState(false);
  const [titlebarHidden, setTitlebarHidden] = useState(false);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  /** 服务端注册表快照（含已退出记录）；标签条按 buildTermTabs 过滤 */
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const terminalsRef = useRef<TerminalInfo[]>([]);
  /** null = 运行中；否则已退出（exitCode 可能为 null = 服务端没给码） */
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [omitted, setOmitted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const runtimeRef = useRef<TermRuntime | null>(null);

  const setTerminalList = (list: TerminalInfo[]) => {
    terminalsRef.current = list;
    setTerminals(list);
  };

  // 右键（无选区时）/ 粘贴按钮读剪贴板；拒绝授权、不支持或非安全上下文时退回手动粘贴。
  const pasteClipboard = async () => {
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = window.prompt(t("ui.TerminalPanel.paste_into_terminal"));
    }
    if (text) {
      runtimeRef.current?.paste(text);
      if (window.matchMedia("(pointer: fine)").matches) runtimeRef.current?.focus();
    }
  };
  const openRef = useRef(open);
  openRef.current = open;

  // ── 挂载一次：xterm + 专用 WS + 引导。面板之后只 CSS 隐藏，不走卸载。 ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: readTermTheme(),
      fontFamily: readTermFontFamily(),
      fontSize: readTermFontSize(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    // 返回 false 只跳过 xterm；保留浏览器默认粘贴，再由 xterm 的 paste 监听处理。
    // 键盘粘贴无需 readText 授权，也不会重复发送或破坏 bracketed paste。
    const copySelection = () => {
      const text = term.getSelection();
      if (!text) return false;
      void navigator.clipboard.writeText(text).catch(() => window.prompt(t("ui.TerminalPanel.copy_manually"), text));
      term.clearSelection();
      return true;
    };
    term.attachCustomKeyEventHandler((event) => {
      if (isTerminalCopyKey(event, term.hasSelection())) {
        if (event.type === "keydown") copySelection();
        return false;
      }
      return !isTerminalToggleKey(event) && !isTerminalPasteKey(event);
    });

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = 1000;
    let attachedId: string | null = null;
    let activationOrder: string[] = [];
    let termState: TermSessionState = initialTermState();
    let lastSentCols = 0;
    let lastSentRows = 0;

    const sendFrame = (frame: Record<string, unknown>): boolean => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
        return true;
      }
      return false;
    };

    const fit = () => {
      if (disposed || !openRef.current) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (!dims || !attachedId || termState.exited) return;
      if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
      if (sendFrame({ type: "resize", terminalId: attachedId, cols: dims.cols, rows: dims.rows })) {
        lastSentCols = dims.cols;
        lastSentRows = dims.rows;
      }
    };

    const applyFontScale = () => {
      if (disposed) return;
      term.options.fontSize = readTermFontSize();
      fit();
    };
    window.addEventListener(FONT_SCALE_EVENT, applyFontScale);

    const remeasureFont = () => {
      if (disposed) return;
      // Assign a different value first: assigning the same family may be a no-op.
      const family = readTermFontFamily();
      term.options.fontFamily = "monospace";
      term.options.fontFamily = family;
      fit();
    };
    // Never block opening/PTY setup on local font availability. Also retry on a
    // late resolution after the timeout; unmounted instances are guarded above.
    const fontTimer = window.setTimeout(remeasureFont, 1500);
    try {
      void document.fonts.load(`${term.options.fontSize}px "Maple Mono NF CN"`, "M汉\uE0B0").then(() => {
        clearTimeout(fontTimer);
        remeasureFont();
      }, () => {
        clearTimeout(fontTimer);
        remeasureFont();
      });
    } catch {
      clearTimeout(fontTimer);
      remeasureFont();
    }

    const attach = (id: string) => {
      // 单面板只看一个终端：切走的解除订阅（PTY 与 scrollback 仍在服务端），免得后台输出挤占这条 WS
      if (attachedId && attachedId !== id) sendFrame({ type: "detach", terminalId: attachedId });
      attachedId = id;
      activationOrder = [...activationOrder.filter((previous) => previous !== id), id];
      writeSavedActiveTerminalId(id);
      termState = initialTermState();
      // 尺寸缓存按终端失效：切回的终端 PTY 可能还是旧尺寸，attached 后的 fit 必须重发
      lastSentCols = 0;
      lastSentRows = 0;
      setOmitted(0);
      setExit(null);
      setConfirmKill(false);
      sendFrame({ type: "attach", terminalId: id });
    };

    const createNew = async (kind: ShellKind) => {
      const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
      const current = store.currentId ? store.session(store.currentId) : undefined;
      const cwd = pickTerminalCwd(current?.cwd, store.meta?.defaultCwd);
      const created = await createTerminal({
        ...(cwd ? { cwd } : {}),
        shell: kind,
        cols: dims.cols,
        rows: dims.rows,
      });
      if (disposed) return;
      setTerminalList([...terminalsRef.current, created]);
      setInfo(created);
      attach(created.id);
    };

    const connect = () => {
      if (disposed) return;
      if (socket && socket.readyState <= WebSocket.OPEN) return;
      const ws = new WebSocket(buildTerminalWsUrl(window.location.protocol, window.location.host));
      socket = ws;
      ws.addEventListener("open", () => {
        if (socket !== ws || disposed) return;
        reconnectDelay = 1000;
        // （重）连后对当前终端重新 attach：服务端先回 attached 再回放 scrollback
        if (attachedId) sendFrame({ type: "attach", terminalId: attachedId });
      });
      ws.addEventListener("message", (messageEvent) => {
        if (socket !== ws || disposed) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(messageEvent.data));
        } catch {
          return; // 无法解析的帧直接忽略
        }
        const { state, effects } = reduceTermFrame(termState, attachedId ?? "", frame);
        termState = state;
        for (const effect of effects) {
          if (effect.type === "reset") {
            term.reset();
            setOmitted(state.omitted);
            // attach 到已有终端时面板尺寸未必等于 PTY 尺寸：回放落定后补一次 fit/resize
            requestAnimationFrame(fit);
          } else if (effect.type === "write") {
            term.write(effect.data);
          } else if (effect.type === "exited") {
            setExit({ code: effect.exitCode });
            // 同步标签条状态（kill 的退出也走这条路）；exited 标签在切走后由 buildTermTabs 过滤掉
            setTerminalList(
              terminalsRef.current.map((t) =>
                t.id === attachedId ? { ...t, exited: true, exitCode: effect.exitCode } : t,
              ),
            );
          } else {
            setError(effect.message);
          }
        }
      });
      ws.addEventListener("close", () => {
        if (socket !== ws) return; // 已被 reconnectNow 换掉的旧连接
        socket = null;
        if (disposed) return;
        // 与全局 WS 同一纪律：指数退避 1s 起、封顶 15s
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
      });
      ws.addEventListener("error", () => ws.close());
    };

    // 手机锁屏回前台：连接已断就立即重连，不等退避计时器
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || disposed) return;
      if (socket && socket.readyState <= WebSocket.OPEN) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      reconnectDelay = 1000;
      socket?.close();
      socket = null;
      connect();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    term.onData((data) => {
      // attached 之前屏幕还是上一个终端的内容，输入不发（切换 / 重连的窗口期）
      if (attachedId && termState.attached && !termState.exited) {
        sendFrame({ type: "input", terminalId: attachedId, data });
      }
    });

    // 主题跟随三态主题：data-theme 属性变化 + 系统深浅切换
    const applyTheme = () => {
      term.options.theme = readTermTheme();
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", applyTheme);

    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(host);

    // 引导 / 新建串行：在途时按钮禁用、再点忽略，杜绝重复 POST 与晚到响应覆盖新选择
    let busy = false;
    const runGuarded = async (task: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      setSwitching(true);
      setError(null);
      try {
        await task();
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
        if (!disposed) setSwitching(false);
      }
    };

    // 引导：持久化的激活 id 仍存活优先重连，其次第一个未退出终端，都没有新建 bash
    const boot = async () => {
      const list = await fetchTerminals();
      if (disposed) return;
      setTerminalList(list);
      const target = pickBootTerminal(list, readSavedActiveTerminalId());
      if (target) {
        setInfo(target);
        attach(target.id);
      } else {
        await createNew("bash");
      }
    };

    // 切标签：detach 旧的、attach 新的（服务端回放 scrollback）；无 REST，不占用 busy
    const switchTo = (id: string) => {
      if (busy || id === attachedId) return;
      const target = terminalsRef.current.find((t) => t.id === id);
      if (!target) return;
      setInfo(target);
      attach(target.id);
      // 触屏不把焦点还给 xterm（会弹起键盘）；桌面点标签后可以直接敲
      if (window.matchMedia("(pointer: fine)").matches) term.focus();
    };
    const showShell = async (kind: ShellKind) => {
      const list = await fetchTerminals();
      if (disposed) return;
      setTerminalList(list);
      const target = pickRecentTerminal(list, kind, activationOrder);
      if (target) {
        setInfo(target);
        attach(target.id);
      } else await createNew(kind);
    };
    const closeExited = (id: string) => {
      if (busy) return;
      const target = terminalsRef.current.find((terminal) => terminal.id === id);
      if (!target?.exited) return;
      const neighbor = pickAdjacentTerminal(terminalsRef.current, id);
      if (neighbor) switchTo(neighbor.id);
      else {
        if (attachedId) sendFrame({ type: "detach", terminalId: attachedId });
        attachedId = null;
        writeSavedActiveTerminalId(null);
        termState = initialTermState();
        term.reset();
        setInfo(null);
        setExit(null);
        setConfirmKill(false);
        setOmitted(0);
      }
      setTerminalList(terminalsRef.current.filter((terminal) => terminal.id !== id));
    };
    void runGuarded(boot);
    connect();

    runtimeRef.current = {
      focus: () => term.focus(),
      fit,
      isAtTop: () => term.buffer.active.viewportY === 0,
      sendInput: (data) => {
        if (attachedId && termState.attached && !termState.exited) {
          sendFrame({ type: "input", terminalId: attachedId, data });
        }
      },
      // 走 term.paste：bracketed paste 与换行归一由 xterm 处理，再经 onData 上行
      paste: (text) => term.paste(text),
      copySelection,
      createNew: (kind) => runGuarded(() => createNew(kind)),
      switchTo,
      switchShell: (kind) => runGuarded(() => showShell(kind)),
      closeExited,
      reconnectNow: onVisibilityChange,
    };

    return () => {
      disposed = true;
      runtimeRef.current = null;
      clearTimeout(reconnectTimer);
      clearTimeout(fontTimer);
      window.removeEventListener(FONT_SCALE_EVENT, applyFontScale);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      themeObserver.disconnect();
      colorScheme.removeEventListener("change", applyTheme);
      resizeObserver.disconnect();
      socket?.close();
      socket = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 面板从隐藏变为可见：等 CSS 生效后 fit 一次（ResizeObserver 也会补，这里是确定性兜底）
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      runtimeRef.current?.fit();
      runtimeRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 只观察触摸，不阻止默认事件；xterm 继续处理输出滚动及终端鼠标协议。
  useEffect(() => {
    setTitlebarHidden(false);
    const host = hostRef.current;
    if (!host || !open || confirmKill) return;
    const mobile = window.matchMedia("(max-width: 720px)");
    const gesture = createTermTitlebarGesture({
      isMobile: () => mobile.matches,
      isAtTop: () => runtimeRef.current?.isAtTop() ?? false,
      onHiddenChange: setTitlebarHidden,
    });
    const start = (event: TouchEvent) => gesture.start(event.touches);
    const move = (event: TouchEvent) => gesture.move(event.touches);
    const options = { capture: true, passive: true };
    host.addEventListener("touchstart", start, options);
    host.addEventListener("touchmove", move, options);
    host.addEventListener("touchend", gesture.end, options);
    host.addEventListener("touchcancel", gesture.end, options);
    mobile.addEventListener("change", gesture.reset);
    return () => {
      host.removeEventListener("touchstart", start, options);
      host.removeEventListener("touchmove", move, options);
      host.removeEventListener("touchend", gesture.end, options);
      host.removeEventListener("touchcancel", gesture.end, options);
      mobile.removeEventListener("change", gesture.reset);
    };
  }, [open, info?.id, confirmKill]);

  // 宽度变化：面板尺寸变了要重新 fit
  useEffect(() => {
    const raf = requestAnimationFrame(() => runtimeRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [width, maximized, titlebarHidden]);

  const kill = async () => {
    if (killBusy || !info) return;
    setKillBusy(true);
    setError(null);
    try {
      await killTerminal(info.id);
      // 退出态以 WS exit 帧为准（带退出码）；REST 成功只解除确认态
      setConfirmKill(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmKill(false);
    } finally {
      setKillBusy(false);
    }
  };

  const tabs = buildTermTabs(terminals, info?.id ?? null);

  return (
    <>
      {open && !maximized && <SidePanelResize label={t("ui.common.terminal")} width={width} setWidth={setWidth} />}
      <div
        className={`term-panel${open ? "" : " term-hidden"}${maximized ? " term-maximized" : ""}${titlebarHidden ? " term-titlebar-hidden" : ""}`}
        role="region"
        aria-label={t("ui.common.terminal")}
        style={{ width: maximized ? undefined : `${width}px` }}
      >
        <div className="term-titlebar">
          <PanelBackButton onClick={onClose} />
          <Segmented
            className="term-shells"
            buttonClassName="term-shell"
            options={shellOptions}
            value={info?.kind ?? null}
            ariaLabel={t("ui.TerminalPanel.switch_shell")}
            disabled={confirmKill || switching || killBusy}
            onChange={(kind) => { if (info?.kind !== kind) void runtimeRef.current?.switchShell(kind); }}
          />
          <span className="term-cwd mono" title={info?.cwd ?? ""}>
            {info?.cwd ?? "…"}
          </span>
          <span className="panel-titlebar-actions">
            {exit && <span className="term-exited">{t("ui.TerminalPanel.exited_code_sentence", { p0: (exit.code ?? t("ui.common.unknown")) })}</span>}
            {confirmKill && !exit ? (
              <span
                className="term-confirm"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (!killBusy) setConfirmKill(false);
                  }
                }}
              >
                <span className="term-confirm-text">{t("ui.TerminalPanel.end_this_terminal_process")}</span>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={killBusy}
                  onClick={() => void kill()}
                >
                  {killBusy ? t("ui.TerminalPanel.ending") : t("ui.TerminalPanel.confirm_end")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={killBusy}
                  title={t("ui.common.cancel_esc")}
                  onClick={() => setConfirmKill(false)}
                >{t("ui.common.cancel")}</button>
              </span>
            ) : exit ? (
              <button
                type="button"
                className="btn"
                disabled={switching || killBusy}
                onClick={() => void runtimeRef.current?.createNew(info?.kind ?? "bash")}
              >{t("ui.TerminalPanel.new_terminal")}</button>
            ) : (
              <button
                type="button"
                className="btn chrome-icon-btn panel-icon-button panel-kill-button"
                aria-label={t("ui.TerminalPanel.end_terminal_process")}
                title={t("ui.TerminalPanel.end_terminal_process")}
                disabled={!info || switching || killBusy}
                onClick={() => setConfirmKill(true)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10" /></svg>
              </button>
            )}
            <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label={t("ui.TerminalPanel.hide_terminal_panel")} title={t("ui.common.collapse_panel")} onClick={onClose}>
              <PanelRightIcon />
            </button>
          </span>
        </div>
        <div className="term-tabs">
          <div className="term-tab-list" role="tablist" aria-label={t("ui.TerminalPanel.terminal_tabs")}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!direction) return;
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)"));
              const index = items.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              const next = items[(index + direction + items.length) % items.length];
              next?.focus();
              next?.click();
            }}>
            {tabs.map((tab) => {
              const active = tab.id === info?.id;
              return <div key={tab.id} className={`term-tab${active ? " active" : ""}${tab.exited ? " exited" : ""}`}>
                <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
                  className="term-tab-select" title={tab.cwd} disabled={switching || killBusy}
                  onClick={() => runtimeRef.current?.switchTo(tab.id)}>
                  <svg className="term-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {tab.kind === "bash" ? <path d="m4 6 6 6-6 6m9 0h7" /> : <><path d="m7 5 7 7-9 7M15 19h5" /><path d="M3 2h18l-3 20H0z" /></>}
                  </svg>
                  <span className="term-tab-label">{tab.label}{tab.exited ? t("ui.TerminalPanel.exited") : ""}</span>
                </button>
                <button type="button" className="term-tab-close" aria-label={t("ui.TerminalPanel.message", { p0: (tab.exited ? t("ui.TerminalPanel.remove_detail") : t("ui.TerminalPanel.end_detail")), p1: (tab.label) })}
                  title={tab.exited ? t("ui.TerminalPanel.remove_exited_tab") : t("ui.TerminalPanel.end_terminal_confirmation_required")} disabled={switching || killBusy}
                  onClick={() => {
                    if (tab.exited) runtimeRef.current?.closeExited(tab.id);
                    else {
                      runtimeRef.current?.switchTo(tab.id);
                      setConfirmKill(true);
                    }
                  }}>×</button>
              </div>;
            })}
          </div>
          <button type="button" className="term-tab-new" aria-label={t("ui.TerminalPanel.new_terminal")}
            title={t("ui.TerminalPanel.new_terminal_2", { p0: (info?.kind === "powershell" ? "PowerShell" : "bash") })} disabled={switching || killBusy || confirmKill}
            onClick={() => void runtimeRef.current?.createNew(info?.kind ?? "bash")}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
          </button>
          <button type="button" className="term-tab-maximize" aria-label={maximized ? t("ui.TerminalPanel.restore_terminal_window") : t("ui.TerminalPanel.maximize_terminal_window")}
            title={maximized ? t("ui.TerminalPanel.restore_terminal_window") : t("ui.TerminalPanel.maximize_terminal_window_while_keeping_the_left")} aria-pressed={maximized}
            onClick={() => setMaximized((value) => !value)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {maximized ? <><path d="M8 8V4h12v12h-4" /><rect x="4" y="8" width="12" height="12" rx="1" /></> : <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />}
            </svg>
          </button>
        </div>
        {omitted > 0 && (
          <div className="term-omitted" role="status">{t("ui.TerminalPanel.earlier_output_omitted")}</div>
        )}
        {error && (
          <div className="term-error" role="alert">
            <span className="term-error-text">{error}</span>
            <button
              type="button"
              className="toast-close"
              aria-label={t("ui.TerminalPanel.dismiss_terminal_error")}
              onClick={() => setError(null)}
            >{t("ui.TerminalPanel.got_it")}</button>
          </div>
        )}
        <div className="term-host" ref={hostRef}
          onContextMenuCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
            // 右键：有选区复制，否则粘贴（同 Windows Terminal）
            if (!runtimeRef.current?.copySelection()) void pasteClipboard();
          }} />
        <div className="term-keys" role="toolbar" aria-label={t("ui.TerminalPanel.terminal_shortcuts")}>
          {TERM_SHORTCUT_KEYS.map((key, index) => (
            <Fragment key={key.id}>
              {index === 2 && (
                <button type="button" className="term-key" aria-label={t("ui.TerminalPanel.paste_clipboard")} onClick={() => void pasteClipboard()}>{t("ui.TerminalPanel.paste")}</button>
              )}
            <button
              type="button"
              className="term-key"
              aria-label={key.ariaLabel}
              onClick={() => runtimeRef.current?.sendInput(key.seq)}
            >
              {key.label}
            </button>
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}
