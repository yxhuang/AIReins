import { t, readLanguagePreference, setLanguagePreference, type LanguagePreference } from "../i18n";
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
import { useStore } from "../useStore";
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
  label: t("ui.SettingsMenu.appearance"),
  items: [
    {
      id: "language",
      label: t("ui.SettingsMenu.language"),
      options: [
        { value: "system", label: t("ui.SettingsMenu.system") },
        { value: "zh-CN", label: t("ui.SettingsMenu.chinese") },
        { value: "en", label: "English" },
      ],
    },
    {
      id: "theme",
      label: t("ui.SettingsMenu.theme"),
      options: [
        { value: "system", label: t("ui.SettingsMenu.system") },
        { value: "light", label: t("ui.SettingsMenu.light") },
        { value: "dark", label: t("ui.SettingsMenu.dark") },
      ],
    },
    {
      id: "font-scale",
      label: t("ui.SettingsMenu.interface_size"),
      options: [
        { value: "small", label: t("ui.SettingsMenu.small") },
        { value: "default", label: t("ui.common.default") },
        { value: "large", label: t("ui.SettingsMenu.large") },
        { value: "xlarge", label: t("ui.SettingsMenu.extra_large") },
      ],
    },
    {
      id: "body-font",
      label: t("ui.SettingsMenu.body_font_size"),
      options: [],
    },
    {
      id: "term-font",
      label: t("ui.SettingsMenu.terminal_font_size"),
      options: [],
    },
  ],
};

const SESSIONS_GROUP: SettingGroup = {
  id: "sessions",
  label: t("ui.common.sessions"),
  items: [
    {
      id: "remote-control-startup",
      label: t("ui.SettingsMenu.remote_control_on_by_default"),
      options: [],
    },
    { id: "codex-reset-watch", label: t("ui.CodexResets.watch"), options: [] },
    {
      id: "idle-release",
      label: t("ui.SettingsMenu.release_idle_workers_after_minutes"),
      options: [
        { value: "0", label: t("ui.SettingsMenu.off") },
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
  const powerSupported = useStore(value => value.meta?.capabilities?.powerOff === true);
  const [open, setOpen] = useState(false);
  const [storageDialogOpen, setStorageDialogOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const [language, setLanguage] = useState<LanguagePreference>(readLanguagePreference);
  const [scaleChoice, setScaleChoice] = useState<FontScaleChoice>(readFontScaleChoice);
  const [bodySize, setBodySize] = useState(readBodyFontSize);
  const [termSize, setTermSize] = useState(() => Math.round(readTermFontSize()));
  const watchEnabled = useStore(value => value.codexResets?.enabled === true);
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchError, setWatchError] = useState("");
  const watchPending = useRef(false);
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
    if (!open || !powerSupported) return;
    let cancelled = false;
    const load = () => powerOff().then((status) => { if (!cancelled) applyPower(status); }).catch(() => { /* 保持当前显示 */ });
    void load();
    const timer = powerActive ? setInterval(load, 3000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, powerActive, powerSupported]);

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

  const toggleResetWatch = async () => {
    if (watchPending.current) return;
    watchPending.current = true;
    setWatchSaving(true);
    setWatchError("");
    try {
      const prefs = await fetchPrefs();
      await savePrefs({ ...prefs, codexResetWatch: !watchEnabled });
      await store.refreshCodexResets();
    } catch (error) { setWatchError(error instanceof Error ? error.message : String(error)); }
    finally { watchPending.current = false; setWatchSaving(false); }
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
    if (id === "language") {
      const next = value === "zh-CN" || value === "en" ? value : "system";
      if (!setLanguagePreference(next)) return;
      setLanguage(next);
      window.location.reload();
    }
    else if (id === "theme") chooseTheme(value);
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
    if (id === "language") return language;
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
        item.id === "codex-reset-watch" ? (
          <div className="settings-item" key={item.id}>
            <div className="settings-row">
              <span className="settings-item-label" id="settings-reset-watch">{item.label}</span>
              <button type="button" role="switch" className="settings-switch" aria-checked={watchEnabled}
                aria-labelledby="settings-reset-watch" aria-describedby="settings-reset-hint" disabled={watchSaving}
                onClick={() => void toggleResetWatch()}>
                <span className={`slash-switch${watchEnabled ? " on" : ""}`} aria-hidden="true" />
              </button>
            </div>
            <span className="settings-hint" id="settings-reset-hint">{t("ui.CodexResets.watch_hint")}</span>
            {watchError && <span className="new-error" role="alert">{watchError}</span>}
          </div>
        ) : item.id === "remote-control-startup" ? (
          <div className="settings-item" key={item.id}>
            <div className="settings-row">
              <span className="settings-item-label" id={`settings-item-${item.id}`}>{item.label}</span>
              <button type="button" role="switch" aria-checked={rcStartup === true}
                aria-labelledby={`settings-item-${item.id}`} aria-describedby="settings-rc-hint"
                className="settings-switch" disabled={rcStartup === null || rcSaving}
                title={rcSaving ? t("ui.common.saving") : rcStartup === null ? (rcError ? t("ui.common.read_failed") : t("ui.common.reading_2")) : rcStartup ? t("ui.SettingsMenu.on") : t("ui.SettingsMenu.off")}
                onClick={() => void toggleRcStartup()}>
                <span className={`slash-switch${rcStartup ? " on" : ""}`} aria-hidden="true" />
              </button>
            </div>
            <span className="settings-hint" id="settings-rc-hint">{t("ui.SettingsMenu.applies_to_new_sessions_resumed_sessions_or")}</span>
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
            <span className="settings-hint">{t("ui.SettingsMenu.applies_only_to_this_device")}</span>
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
        <div className="settings-panel" ref={panelRef} role="dialog" aria-label={t("ui.common.settings")} inert={dialogOpen}>
          <div className="settings-col">
            {renderGroup(APPEARANCE_GROUP)}
            <section className="settings-group">
              <h3 className="settings-group-title">{t("ui.SettingsMenu.host")}</h3>
              <button type="button" className="settings-action settings-hosts" onClick={openHostMenu} aria-haspopup="menu">{t("ui.SettingsMenu.hosts_and_connections_tailscale")}</button>
              {powerSupported && <button type="button" className={`settings-action settings-power${powerActive ? " is-pending" : ""}`} ref={powerButton}
                aria-haspopup={powerActive ? undefined : "dialog"} onClick={() => void togglePowerOff()}>
                {powerActive ? <span aria-hidden="true">✕</span> : <span aria-hidden="true">⏻</span>}
                {power?.state === "waiting" ? t("ui.SettingsMenu.cancel_shutdown_waiting_for_sessions", { p0: (power.busy) })
                  : power?.state === "scheduled" ? (powerSeconds === null ? t("ui.SettingsMenu.cancel_shutdown") : t("ui.SettingsMenu.cancel_shutdown_shutting_down_in_seconds", { p0: (powerSeconds) })) : t("ui.SettingsMenu.shut_down")}
              </button>}
              {powerSupported && (power?.error || powerError) && <span className="new-error" role="alert">{power?.error || powerError}</span>}
            </section>
          </div>
          <div className="settings-col">
            {renderGroup(SESSIONS_GROUP, <WorkbenchStorage dialogOpen={storageDialogOpen} onDialogOpenChange={setStorageDialogOpen} />)}
            <section className="settings-group">
              <button type="button" className="settings-action" ref={restartButton} disabled={restartState !== "idle"}
                aria-haspopup="dialog" onClick={() => void restart()}>
                <span aria-hidden="true">↻</span>{restartState === "checking" ? t("ui.SettingsMenu.checking_sessions") : t("ui.SettingsMenu.restart")}
              </button>
            </section>
          </div>
        </div>
      )}
      <button
        type="button"
        ref={gearRef}
        className="settings-gear"
        title={t("ui.common.settings")}
        aria-label={t("ui.common.settings")}
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
              <h2 id="power-off-title">{t("ui.SettingsMenu.shut_down_this_computer")}</h2>
            </div>
            <p id="power-off-description">{powerConfirm > 0
              ? t("ui.SettingsMenu.sessions_are_running_or_have_background_tasks", { p0: (powerConfirm) })
              : t("ui.SettingsMenu.no_sessions_are_running_this_computer_will")}</p>
            <p className="settings-hint">{t("ui.SettingsMenu.cancel_using_the_same_button_in_settings")}</p>
            <div className="dir-actions">
              <button type="button" className="btn" onClick={closePowerConfirm}>{t("ui.common.cancel")}</button>
              <button type="button" className="btn btn-danger" onClick={() => void confirmPowerOff()}>
                {powerConfirm > 0 ? t("ui.SettingsMenu.shut_down_when_finished") : t("ui.SettingsMenu.confirm_shutdown")}
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
              <h2 id="restart-confirm-title">{t("ui.SettingsMenu.restart")}</h2>
            </div>
            <p id="restart-confirm-description">{t("ui.SettingsMenu.sessions_are_running_or_have_background_tasks_sentence", { p0: (restartConfirm) })}</p>
            <p className="settings-hint">{t("ui.SettingsMenu.after_confirmation_settings_closes_and_the_server")}</p>
            <div className="dir-actions">
              <button type="button" className="btn" onClick={closeRestartConfirm}>{t("ui.common.cancel")}</button>
              <button type="button" className="btn btn-danger" onClick={() => { setRestartConfirm(null); void restart(true); }}>{t("ui.SettingsMenu.restart_anyway")}</button>
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
              <h2 id="restart-title">{restartState === "restarting" ? t("ui.SettingsMenu.restarting") : t("ui.SettingsMenu.restart_not_confirmed")}</h2>
            </div>
            <p id="restart-description" role={restartState === "failed" ? "alert" : "status"}>
              {restartState === "restarting" ? t("ui.SettingsMenu.waiting_for_to_reconnect_please_wait") : t("ui.SettingsMenu.run_wb_restart_in_a_terminal_on", { p0: (restartError) })}
            </p>
            {restartState === "failed" && <div className="dir-actions"><button type="button" className="btn" onClick={() => {
              setRestartState("idle");
              gearRef.current?.focus();
            }}>{t("ui.SettingsMenu.dismiss")}</button></div>}
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
