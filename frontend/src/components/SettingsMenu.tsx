import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modalKeyDown, useAnchoredMenu } from "./useAnchoredMenu";
import { Segmented } from "./Segmented";
import { WorkbenchStorage } from "./WorkbenchStorage";
import { OPEN_HOST_MENU_EVENT } from "./HostSwitcher";
import { BODY_FONT_MAX, BODY_FONT_MIN, BODY_FONT_STEP, BODY_FONT_STORAGE_KEY, TERM_FONT_MAX, TERM_FONT_MIN, TERM_FONT_STORAGE_KEY, applyBodyFontSize, bodyFontSize, readBodyFontSize, readTermFontSize, termFontSize } from "../body-font";
import { fetchClaudeStartupSettings, fetchPrefs, fetchSessions, powerOff, restartWorkbench, saveClaudeStartupSettings, savePrefs, type PowerOffStatus } from "../api";
import { restartAndReconnect, restartBusyCount } from "../restart";
import { store } from "../store";
import {
  FONT_SCALE_EVENT,
  FONT_SCALE_STORAGE_KEY,
  fontScale,
  fontScaleChoice,
  readFontScaleChoice,
  type FontScaleChoice,
} from "../font-scale";

type ThemeChoice = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "workbench-theme";

interface SettingOption {
  value: string;
  label: string;
}

interface SettingItem {
  id: string;
  label: string;
  options: SettingOption[];
}

interface SettingGroup {
  id: string;
  label: string;
  items: SettingItem[];
}

/* 分组 + 条目结构，后续加条目只动这两张表；渲染顺序见 SettingsMenu 的面板 */
const APPEARANCE_GROUP: SettingGroup = {
  id: "appearance",
  label: "外观",
  items: [
    {
      id: "theme",
      label: "主题",
      options: [
        { value: "system", label: "跟随系统" },
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
      ],
    },
    {
      id: "font-scale",
      label: "字号",
      options: [
        { value: "small", label: "小" },
        { value: "default", label: "默认" },
        { value: "large", label: "大" },
        { value: "xlarge", label: "特大" },
      ],
    },
    {
      id: "body-font",
      label: "正文字号",
      options: [],
    },
    {
      id: "term-font",
      label: "终端字号",
      options: [],
    },
  ],
};

const SESSIONS_GROUP: SettingGroup = {
  id: "sessions",
  label: "会话",
  items: [
    {
      id: "remote-control-startup",
      label: "Remote Control 默认开启",
      options: [],
    },
    {
      id: "idle-release",
      label: "空闲自动释放（分钟）",
      options: [
        { value: "0", label: "关闭" },
        { value: "15", label: "15" },
        { value: "30", label: "30" },
        { value: "60", label: "60" },
        { value: "120", label: "120" },
      ],
    },
  ],
};

/* 隐私模式下 localStorage 访问器本身就会抛异常，读写都必须 try/catch；
   取不到一律按跟随系统渲染，不能白屏。index.html 的内联脚本用同一个 key。 */
function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* 按跟随系统渲染 */
  }
  return "system";
}

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
  }
}

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const [scaleChoice, setScaleChoice] = useState<FontScaleChoice>(readFontScaleChoice);
  const [bodySize, setBodySize] = useState(readBodyFontSize);
  const [termSize, setTermSize] = useState(() => Math.round(readTermFontSize()));
  const [idleRelease, setIdleRelease] = useState("30");
  const [rcStartup, setRcStartup] = useState<boolean | null>(null);
  const [rcSaving, setRcSaving] = useState(false);
  const [rcError, setRcError] = useState<string | null>(null);
  const rcPending = useRef(false);
  const rcVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [restartState, setRestartState] = useState<"idle" | "checking" | "restarting" | "failed">("idle");
  const [restartError, setRestartError] = useState("");
  const restartPending = useRef(false);
  const restartAbort = useRef<AbortController | null>(null);
  const restartDialog = useRef<HTMLDivElement>(null);
  const [power, setPower] = useState<PowerOffStatus | null>(null);
  const [powerError, setPowerError] = useState("");
  const powerPending = useRef(false);
  /** 关机确认弹层打开时存当时的忙会话数，关闭为 null。 */
  const [powerConfirm, setPowerConfirm] = useState<number | null>(null);
  const powerButton = useRef<HTMLButtonElement>(null);
  const powerDialog = useRef<HTMLDivElement>(null);
  /** 重启确认弹层打开时存当时的忙会话数，关闭为 null。 */
  const [restartConfirm, setRestartConfirm] = useState<number | null>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const restartConfirmDialog = useRef<HTMLDivElement>(null);
  const dialogOpen = storageDialogOpen || powerConfirm !== null || restartConfirm !== null;
  const powerActive = power !== null && power.state !== "idle";
  /** 已排定关机的本地时刻：按服务端给的剩余毫秒折算，避开手机与电脑时钟差。 */
  const [powerDeadline, setPowerDeadline] = useState<number | null>(null);
  const [powerNow, setPowerNow] = useState(() => Date.now());
  const applyPower = (status: PowerOffStatus) => {
    setPower(status);
    setPowerDeadline(status.remainingMs === undefined ? null : Date.now() + status.remainingMs);
  };

  useEffect(() => () => restartAbort.current?.abort(), []);
  useEffect(() => {
    if (restartState === "restarting" || restartState === "failed") restartDialog.current?.focus();
  }, [restartState]);

  /** confirmed = 已在弹层里确认中断忙会话，不再重查。 */
  const restart = async (confirmed = false) => {
    if (restartPending.current) return;
    restartPending.current = true;
    setRestartState("checking");
    setRestartError("");
    const controller = new AbortController();
    restartAbort.current = controller;
    try {
      if (!confirmed) {
        const count = restartBusyCount(await fetchSessions());
        if (controller.signal.aborted) return;
        if (count > 0) {
          setRestartState("idle");
          setRestartConfirm(count);
          return;
        }
      }
      close(false);
      setRestartState("restarting");
      await restartAndReconnect(store, () => restartWorkbench(controller.signal), controller.signal);
      setRestartState("idle");
      gearRef.current?.focus();
    } catch (error) {
      if (controller.signal.aborted) return;
      setRestartError(error instanceof Error ? error.message : String(error));
      setRestartState("failed");
    } finally {
      controller.abort();
      restartPending.current = false;
    }
  };

  // 空闲自动释放存在服务端（/api/prefs），打开面板时对齐一次
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const version = ++rcVersion.current;
    setRcStartup(null);
    setRcError(null);
    // 两个独立设置并行读取。
    fetchClaudeStartupSettings()
      .then((settings) => {
        if (!cancelled && version === rcVersion.current) setRcStartup(settings.remoteControlAtStartup);
      })
      .catch((error: unknown) => {
        if (!cancelled && version === rcVersion.current) setRcError(error instanceof Error ? error.message : String(error));
      });
    fetchPrefs()
      .then((prefs) => {
        if (!cancelled) setIdleRelease(String(prefs.idleReleaseMinutes));
      })
      .catch(() => { /* 拉取失败保持当前显示 */ });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 关机状态在服务端；打开菜单读一次，等待/已排定时每 3 秒刷新
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => powerOff().then((status) => { if (!cancelled) applyPower(status); }).catch(() => { /* 保持当前显示 */ });
    void load();
    const timer = powerActive ? setInterval(load, 3000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, powerActive]);

  // 倒计时每秒走一格；到点后的复位由上面的 3 秒刷新从服务端拿
  useEffect(() => {
    if (!open || powerDeadline === null) return;
    setPowerNow(Date.now());
    const timer = setInterval(() => setPowerNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, powerDeadline]);
  const powerSeconds = powerDeadline === null ? null : Math.max(0, Math.ceil((powerDeadline - powerNow) / 1000));

  const togglePowerOff = async () => {
    if (powerPending.current) return;
    powerPending.current = true;
    setPowerError("");
    try {
      if (powerActive) {
        applyPower(await powerOff("DELETE"));
        return;
      }
      setPowerConfirm((await powerOff()).busy);
    } catch (error) {
      setPowerError(error instanceof Error ? error.message : String(error));
    } finally {
      powerPending.current = false;
    }
  };

  useEffect(() => {
    if (powerConfirm !== null) powerDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [powerConfirm !== null]);
  useEffect(() => {
    if (restartConfirm !== null) restartConfirmDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [restartConfirm !== null]);

  const closeRestartConfirm = () => {
    setRestartConfirm(null);
    requestAnimationFrame(() => restartButton.current?.focus());
  };

  const closePowerConfirm = () => {
    setPowerConfirm(null);
    // 等设置面板的 inert 移除后，把焦点交回关机按钮。
    requestAnimationFrame(() => powerButton.current?.focus());
  };

  const confirmPowerOff = async () => {
    if (powerPending.current) return;
    powerPending.current = true;
    try {
      applyPower(await powerOff("POST"));
    } catch (error) {
      setPowerError(error instanceof Error ? error.message : String(error));
    } finally {
      powerPending.current = false;
      closePowerConfirm();
    }
  };

  const openHostMenu = () => {
    close(false);
    window.dispatchEvent(new Event(OPEN_HOST_MENU_EVENT));
  };

  const close = (returnFocus: boolean) => {
    setStorageDialogOpen(false);
    setPowerConfirm(null);
    setOpen(false);
    if (returnFocus) gearRef.current?.focus();
  };

  useAnchoredMenu({
    open: open && !dialogOpen, rootRef, buttonRef: gearRef, panelRef, close,
    initialFocus: 'button[aria-checked="true"]', trapFocus: true,
  });

  const chooseTheme = (value: string) => {
    const next: ThemeChoice = value === "light" || value === "dark" ? value : "system";
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* localStorage 不可用时仅本次会话生效 */
    }
  };

  const chooseFontScale = (value: string) => {
    const next = fontScaleChoice(value);
    setScaleChoice(next);
    document.documentElement.style.setProperty("--font-scale", String(fontScale(next)));
    try {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
    } catch {
      /* localStorage 不可用时仅本次会话生效 */
    }
    window.dispatchEvent(new Event(FONT_SCALE_EVENT));
    // 终端字号没单独设过时跟着界面字号走，滑块显示同步刷新
    setTermSize(Math.round(readTermFontSize()));
  };

  const chooseIdleRelease = (value: string) => {
    const previous = idleRelease;
    setIdleRelease(value);
    savePrefs({ idleReleaseMinutes: Number(value) }).catch(() => setIdleRelease(previous));
  };

  const toggleRcStartup = async () => {
    if (rcStartup === null || rcPending.current) return;
    rcPending.current = true;
    ++rcVersion.current;
    setRcSaving(true);
    setRcError(null);
    try {
      const settings = await saveClaudeStartupSettings(!rcStartup);
      setRcStartup(settings.remoteControlAtStartup);
    } catch (error) {
      setRcError(error instanceof Error ? error.message : String(error));
    } finally {
      rcPending.current = false;
      setRcSaving(false);
    }
  };

  const choose = (id: string, value: string) => {
    if (id === "theme") chooseTheme(value);
    else if (id === "font-scale") chooseFontScale(value);
    else if (id === "body-font") {
      const next = bodyFontSize(value);
      setBodySize(next);
      applyBodyFontSize(next);
      try { localStorage.setItem(BODY_FONT_STORAGE_KEY, String(next)); } catch { /* 仅本次生效 */ }
    }
    else if (id === "term-font") {
      const next = termFontSize(value);
      if (next === null) return;
      // 终端从存储读字号：存不进去就不改滑块，免得显示和实际不一致
      try { localStorage.setItem(TERM_FONT_STORAGE_KEY, String(next)); } catch { return; }
      setTermSize(next);
      // 终端面板监听这个事件重读字号并重排
      window.dispatchEvent(new Event(FONT_SCALE_EVENT));
    }
    else if (id === "idle-release") chooseIdleRelease(value);
  };

  const selectedValue = (id: string): string => {
    if (id === "theme") return theme;
    if (id === "font-scale") return scaleChoice;
    if (id === "body-font") return String(bodySize);
    return idleRelease;
  };

  /** 服务端存了非档位值（如手动编辑 prefs.json）时补一个如实显示的选项，不猜不改。 */
  const optionsFor = (item: SettingItem): SettingOption[] => {
    if (item.id !== "idle-release") return item.options;
    if (item.options.some((option) => option.value === idleRelease)) return item.options;
    return [...item.options, { value: idleRelease, label: idleRelease }];
  };

  const renderGroup = (group: SettingGroup, footer?: ReactNode) => (
    <section className={`settings-group settings-group-${group.id}`} key={group.id}>
      <h3 className="settings-group-title">{group.label}</h3>
      {group.items.map((item) => (
        item.id === "remote-control-startup" ? (
          <div className="settings-item" key={item.id}>
            <div className="settings-row">
              <span className="settings-item-label" id={`settings-item-${item.id}`}>{item.label}</span>
              <button type="button" role="switch" aria-checked={rcStartup === true}
                aria-labelledby={`settings-item-${item.id}`} aria-describedby="settings-rc-hint"
                className="settings-switch" disabled={rcStartup === null || rcSaving}
                title={rcSaving ? "保存中…" : rcStartup === null ? (rcError ? "读取失败" : "读取中…") : rcStartup ? "已开启" : "已关闭"}
                onClick={() => void toggleRcStartup()}>
                <span className={`slash-switch${rcStartup ? " on" : ""}`} aria-hidden="true" />
              </button>
            </div>
            <span className="settings-hint" id="settings-rc-hint">仅对新建、续接或释放后再发送的会话生效。</span>
            {rcError && <span className="new-error" role="alert">{rcError}</span>}
          </div>
        ) : item.id === "body-font" ? (
          <div className="settings-item" key={item.id}>
            <div className="settings-row">
              <label className="settings-item-label" htmlFor="settings-body-font">{item.label}</label>
              <span className="settings-range-value">{bodySize}px</span>
            </div>
            <input id="settings-body-font" className="settings-range" type="range"
              min={BODY_FONT_MIN} max={BODY_FONT_MAX} step={BODY_FONT_STEP} value={bodySize}
              onChange={(e) => choose(item.id, e.target.value)} />
          </div>
        ) : item.id === "term-font" ? (
          <div className="settings-item" key={item.id}>
            <div className="settings-row">
              <label className="settings-item-label" htmlFor="settings-term-font">{item.label}</label>
              <span className="settings-range-value">{termSize}px</span>
            </div>
            <input id="settings-term-font" className="settings-range" type="range"
              min={TERM_FONT_MIN} max={TERM_FONT_MAX} step={1} value={termSize}
              onChange={(e) => choose(item.id, e.target.value)} />
            <span className="settings-hint">只对这台设备生效。</span>
          </div>
        ) : (
          <div className="settings-item" key={item.id}>
            <span className="settings-item-label" id={`settings-item-${item.id}`}>{item.label}</span>
            <Segmented
              className="settings-seg"
              options={optionsFor(item)}
              value={selectedValue(item.id)}
              onChange={(value) => item.id === "theme" ? chooseTheme(value as ThemeChoice) : choose(item.id, value)}
              role="radiogroup"
              ariaLabelledby={`settings-item-${item.id}`}
            />
          </div>
        )
      ))}
      {footer}
    </section>
  );

  return (
    <div className="settings" ref={rootRef}>
      {open && (
        <div className="settings-panel" ref={panelRef} role="dialog" aria-label="设置" inert={dialogOpen}>
          <div className="settings-col">
            {renderGroup(SESSIONS_GROUP, <WorkbenchStorage dialogOpen={storageDialogOpen} onDialogOpenChange={setStorageDialogOpen} />)}
            <section className="settings-group">
              <button type="button" className="settings-action" ref={restartButton} disabled={restartState !== "idle"}
                aria-haspopup="dialog" onClick={() => void restart()}>
                <span aria-hidden="true">↻</span>{restartState === "checking" ? "检查会话中…" : "重启 Workbench"}
              </button>
            </section>
          </div>
          <div className="settings-col">
            {renderGroup(APPEARANCE_GROUP)}
            <section className="settings-group">
              <h3 className="settings-group-title">主机</h3>
              <button type="button" className="settings-action settings-hosts" onClick={openHostMenu} aria-haspopup="menu">
                主机与连接（Tailscale）
              </button>
              <button type="button" className={`settings-action settings-power${powerActive ? " is-pending" : ""}`} ref={powerButton}
                aria-haspopup={powerActive ? undefined : "dialog"} onClick={() => void togglePowerOff()}>
                {powerActive ? <span aria-hidden="true">✕</span> : <span aria-hidden="true">⏻</span>}
                {power?.state === "waiting" ? `取消关机（等 ${power.busy} 个会话完成）`
                  : power?.state === "scheduled" ? (powerSeconds === null ? "取消关机" : `取消关机（${powerSeconds} 秒后关机）`) : "关机"}
              </button>
              {(power?.error || powerError) && <span className="new-error" role="alert">{power?.error || powerError}</span>}
            </section>
          </div>
        </div>
      )}
      <button
        type="button"
        ref={gearRef}
        className="settings-gear"
        title="设置"
        aria-label="设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <GearIcon />
      </button>
      {powerConfirm !== null && createPortal(
        <div className="dir-overlay storage-overlay" onKeyDown={(event) => modalKeyDown(event, powerDialog.current, closePowerConfirm)}>
          <div className="dir-dialog storage-dialog" ref={powerDialog} tabIndex={-1} role="dialog"
            aria-modal="true" aria-labelledby="power-off-title" aria-describedby="power-off-description">
            <div className="dir-heading">
              <h2 id="power-off-title">关闭这台电脑</h2>
            </div>
            <p id="power-off-description">{powerConfirm > 0
              ? `有 ${powerConfirm} 个会话正在运行或带有后台任务。确认后先等它们全部完成，再自动关机，不再询问。`
              : "当前没有会话在运行，确认后约 60 秒关机。"}</p>
            <p className="settings-hint">关机前可在设置里点同一按钮取消。Windows 会强制关闭程序，未保存的内容会丢失。</p>
            <div className="dir-actions">
              <button type="button" className="btn" onClick={closePowerConfirm}>取消</button>
              <button type="button" className="btn btn-danger" onClick={() => void confirmPowerOff()}>
                {powerConfirm > 0 ? "等完成后关机" : "确认关机"}
              </button>
            </div>
          </div>
        </div>, document.body,
      )}
      {restartConfirm !== null && createPortal(
        <div className="dir-overlay storage-overlay" onKeyDown={(event) => modalKeyDown(event, restartConfirmDialog.current, closeRestartConfirm)}>
          <div className="dir-dialog storage-dialog" ref={restartConfirmDialog} tabIndex={-1} role="dialog"
            aria-modal="true" aria-labelledby="restart-confirm-title" aria-describedby="restart-confirm-description">
            <div className="dir-heading">
              <h2 id="restart-confirm-title">重启 Workbench</h2>
            </div>
            <p id="restart-confirm-description">有 {restartConfirm} 个会话正在运行或带有后台任务，重启会中断它们。</p>
            <p className="settings-hint">确认后关闭设置并重启，页面会自动重连。</p>
            <div className="dir-actions">
              <button type="button" className="btn" onClick={closeRestartConfirm}>取消</button>
              <button type="button" className="btn btn-danger" onClick={() => { setRestartConfirm(null); void restart(true); }}>仍要重启</button>
            </div>
          </div>
        </div>, document.body,
      )}
      {(restartState === "restarting" || restartState === "failed") && createPortal(
        <div className="dir-overlay restart-overlay" onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Tab") {
            event.preventDefault();
            if (restartState === "failed") restartDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
        }}>
          <div className="dir-dialog storage-dialog" ref={restartDialog} tabIndex={-1} role="dialog" aria-modal="true"
            aria-labelledby="restart-title" aria-describedby="restart-description">
            <div className="dir-heading">
              <h2 id="restart-title">{restartState === "restarting" ? "重启中…" : "重启未确认成功"}</h2>
            </div>
            <p id="restart-description" role={restartState === "failed" ? "alert" : "status"}>
              {restartState === "restarting" ? "正在等待 Workbench 恢复连接，请稍候。" : `${restartError}。请在电脑终端按当前实例的端口和 WORKBENCH_HOME 执行 wb restart，再刷新页面；手机用户请到电脑操作。`}
            </p>
            {restartState === "failed" && <div className="dir-actions"><button type="button" className="btn" onClick={() => {
              setRestartState("idle");
              gearRef.current?.focus();
            }}>关闭提示</button></div>}
          </div>
        </div>, document.body,
      )}
    </div>
  );
}

/* 内联自画齿轮，不引图标库 */
function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
