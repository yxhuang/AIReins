import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo } from "../types";
import { createTerminal, fetchTerminals, killTerminal } from "../api";
import {
  TERM_DEFAULT_WIDTH,
  TERM_SHORTCUT_KEYS,
  buildTerminalWsUrl,
  clampPanelWidth,
  initialTermState,
  pickAttachTarget,
  pickTerminalCwd,
  reduceTermFrame,
  type TermSessionState,
} from "../terminal";
import { store } from "../store";

const WIDTH_STORAGE_KEY = "workbench-term-width";

// localStorage 与主题/草稿同一纪律：typeof 判定 + try/catch，失败无声降级
function readSavedWidth(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSavedWidth(width: number): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
}

/** xterm 主题字段 ← --term-* 令牌（深浅两套在 styles.css，运行时读计算样式跟随主题切换）。 */
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
  const styles = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const [key, varName] of TERM_THEME_VARS) {
    const value = styles.getPropertyValue(varName).trim();
    if (value) theme[key] = value;
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
  fit: () => void;
  sendInput: (data: string) => void;
  createNew: () => Promise<void>;
  reconnectNow: () => void;
}

/**
 * 终端面板（工作区级，不绑会话）。挂载后常驻：隐藏只是 CSS display:none，
 * xterm 实例、WS 连接与服务端 PTY 全部保留。首次挂载完成引导：
 * GET /api/terminals 有未退出的 attach 第一个，没有就 POST 新建。
 */
export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() =>
    clampPanelWidth(readSavedWidth() ?? TERM_DEFAULT_WIDTH, window.innerWidth),
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  /** null = 运行中；否则已退出（exitCode 可能为 null = 服务端没给码） */
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [omitted, setOmitted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const runtimeRef = useRef<TermRuntime | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // ── 挂载一次：xterm + 专用 WS + 引导。面板之后只 CSS 隐藏，不走卸载。 ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: readTermTheme(),
      fontFamily: readTermFontFamily(),
      fontSize: 13,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = 1000;
    let attachedId: string | null = null;
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

    const attach = (id: string) => {
      attachedId = id;
      termState = initialTermState();
      setOmitted(0);
      setExit(null);
      setConfirmKill(false);
      sendFrame({ type: "attach", terminalId: id });
    };

    const createNew = async () => {
      const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
      const current = store.currentId ? store.session(store.currentId) : undefined;
      const cwd = pickTerminalCwd(current?.cwd, store.meta?.defaultCwd);
      const created = await createTerminal({
        ...(cwd ? { cwd } : {}),
        cols: dims.cols,
        rows: dims.rows,
      });
      if (disposed) return;
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
      if (attachedId && !termState.exited) {
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

    // 引导：有未退出的 attach 第一个，没有就新建
    void (async () => {
      try {
        const target = pickAttachTarget(await fetchTerminals());
        if (disposed) return;
        if (target) {
          setInfo(target);
          attach(target.id);
        } else {
          await createNew();
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    connect();

    runtimeRef.current = {
      fit,
      sendInput: (data) => {
        if (attachedId && !termState.exited) {
          sendFrame({ type: "input", terminalId: attachedId, data });
        }
      },
      createNew: async () => {
        setError(null);
        try {
          await createNew();
        } catch (e) {
          if (!disposed) setError(e instanceof Error ? e.message : String(e));
        }
      },
      reconnectNow: onVisibilityChange,
    };

    return () => {
      disposed = true;
      runtimeRef.current = null;
      clearTimeout(reconnectTimer);
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
    const raf = requestAnimationFrame(() => runtimeRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 宽度变化：面板尺寸变了要重新 fit；持久化到 localStorage
  useEffect(() => {
    writeSavedWidth(width);
    const raf = requestAnimationFrame(() => runtimeRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [width]);

  // 窗口尺寸变化：宽度重新 clamp（视口变窄时别让面板把主区挤没）
  useEffect(() => {
    const onResize = () => setWidth((w) => clampPanelWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const draggingRef = useRef(false);
  const onSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    document.body.classList.add("resizing");
  };
  const onSplitPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    // 面板在右侧：宽度 = 工作区右缘 − 指针 x
    const workspace = e.currentTarget.parentElement;
    if (!workspace) return;
    const right = workspace.getBoundingClientRect().right;
    setWidth(clampPanelWidth(right - e.clientX, window.innerWidth));
  };
  const endSplitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove("resizing");
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

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

  return (
    <>
      {open && (
        <div
          className="term-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整终端面板宽度"
          aria-valuenow={width}
          aria-valuemin={320}
          aria-valuemax={Math.max(320, window.innerWidth - 480)}
          tabIndex={0}
          title="拖动调整宽度，双击复位"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={endSplitDrag}
          onPointerCancel={endSplitDrag}
          onDoubleClick={() => setWidth(clampPanelWidth(TERM_DEFAULT_WIDTH, window.innerWidth))}
          onKeyDown={(e) => {
            const delta = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
            if (delta === 0) return;
            e.preventDefault();
            setWidth((w) => clampPanelWidth(w + delta, window.innerWidth));
          }}
        />
      )}
      <div
        className={`term-panel${open ? "" : " term-hidden"}`}
        role="region"
        aria-label="终端"
        style={{ width: `${width}px` }}
      >
        <div className="term-titlebar">
          <button type="button" className="btn term-back" aria-label="返回" onClick={onClose}>
            ‹ 返回
          </button>
          <span className="term-cwd mono" title={info?.cwd ?? ""}>
            {info?.cwd ?? "…"}
          </span>
          {exit && <span className="term-exited">已退出（码 {exit.code ?? "未知"}）</span>}
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
              <span className="term-confirm-text">结束该终端进程？</span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={killBusy}
                onClick={() => void kill()}
              >
                {killBusy ? "结束中…" : "确认结束"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={killBusy}
                title="取消（Esc）"
                onClick={() => setConfirmKill(false)}
              >
                取消
              </button>
            </span>
          ) : exit ? (
            <button
              type="button"
              className="btn"
              onClick={() => void runtimeRef.current?.createNew()}
            >
              新建终端
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              aria-label="结束终端进程"
              onClick={() => setConfirmKill(true)}
            >
              结束
            </button>
          )}
          <button type="button" className="btn" aria-label="隐藏终端面板" onClick={onClose}>
            隐藏
          </button>
        </div>
        {omitted > 0 && (
          <div className="term-omitted" role="status">
            已省略较早输出
          </div>
        )}
        {error && (
          <div className="term-error" role="alert">
            <span className="term-error-text">{error}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭终端错误提示"
              onClick={() => setError(null)}
            >
              知道了
            </button>
          </div>
        )}
        <div className="term-host" ref={hostRef} />
        <div className="term-keys" role="toolbar" aria-label="终端快捷键">
          {TERM_SHORTCUT_KEYS.map((key) => (
            <button
              key={key.id}
              type="button"
              className="term-key"
              aria-label={key.ariaLabel}
              onClick={() => runtimeRef.current?.sendInput(key.seq)}
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
