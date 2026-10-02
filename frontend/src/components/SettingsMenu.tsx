import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Segmented } from "./Segmented";
import { WorkbenchStorage } from "./WorkbenchStorage";
import { BODY_FONT_MAX, BODY_FONT_MIN, BODY_FONT_STEP, BODY_FONT_STORAGE_KEY, applyBodyFontSize, bodyFontSize, readBodyFontSize } from "../body-font";
import { fetchClaudeStartupSettings, fetchPrefs, fetchSessions, restartWorkbench, saveClaudeStartupSettings, savePrefs } from "../api";
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

/* 分组 + 条目结构，后续加组/加条目只动这张表 */
const SETTING_GROUPS: SettingGroup[] = [
  {
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
    ],
  },
  {
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
  },
];

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

  useEffect(() => () => restartAbort.current?.abort(), []);
  useEffect(() => {
    if (restartState === "restarting" || restartState === "failed") restartDialog.current?.focus();
  }, [restartState]);

  const restart = async () => {
    if (restartPending.current) return;
    restartPending.current = true;
    setRestartState("checking");
    setRestartError("");
    const controller = new AbortController();
    restartAbort.current = controller;
    try {
      const count = restartBusyCount(await fetchSessions());
      if (controller.signal.aborted) return;
      if (count > 0 && !window.confirm(`有 ${count} 个会话正在运行或带有后台任务，重启会中断它们。仍要重启 Workbench？`)) {
        setRestartState("idle");
        return;
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

  const close = (returnFocus: boolean) => {
    setStorageDialogOpen(false);
    setOpen(false);
    if (returnFocus) gearRef.current?.focus();
  };

  // 打开时焦点落到当前选中项（aria-checked=true），与 roving tabindex 的 tabIndex=0 一致
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button[aria-checked="true"]')?.focus();
  }, [open]);

  // Esc 关闭；Tab/Shift+Tab 在面板内循环（focus trap）；点浮层外关闭
  // （齿轮按钮在 rootRef 内，自身 click 不会触发这条）
  useEffect(() => {
    if (!open || storageDialogOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close(true);
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables.item(0);
      const last = focusables.item(focusables.length - 1);
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      // 点在浮层外只关闭、不抢焦点，让用户点到的目标（如输入框）保有焦点
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, storageDialogOpen]);

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

  return (
    <div className="settings" ref={rootRef}>
      {open && (
        <div className="settings-panel" ref={panelRef} role="dialog" aria-label="设置" inert={storageDialogOpen}>
          {SETTING_GROUPS.map((group) => (
            <section className="settings-group" key={group.id}>
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
            </section>
          ))}
          <section className="settings-group">
            <h3 className="settings-group-title">Workbench</h3>
            <WorkbenchStorage dialogOpen={storageDialogOpen} onDialogOpenChange={setStorageDialogOpen} />
            <button type="button" className="settings-action" disabled={restartState !== "idle"}
              onClick={() => void restart()}>
              <span aria-hidden="true">↻</span>{restartState === "checking" ? "检查会话中…" : "重启 Workbench"}
            </button>
          </section>
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
      {(restartState === "restarting" || restartState === "failed") && createPortal(
        <div className="dir-overlay restart-overlay" onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Tab") {
            event.preventDefault();
            if (restartState === "failed") restartDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
        }}>
          <div className="dir-dialog" ref={restartDialog} tabIndex={-1} role="dialog" aria-modal="true"
            aria-labelledby="restart-title" aria-describedby="restart-description">
            <h3 id="restart-title">{restartState === "restarting" ? "重启中…" : "重启未确认成功"}</h3>
            <p id="restart-description" role={restartState === "failed" ? "alert" : "status"}>
              {restartState === "restarting" ? "正在等待 Workbench 恢复连接，请稍候。" : `${restartError}。请在电脑终端按当前实例的端口和 WORKBENCH_HOME 执行 wb restart，再刷新页面；手机用户请到电脑操作。`}
            </p>
            {restartState === "failed" && <button type="button" className="btn" onClick={() => {
              setRestartState("idle");
              gearRef.current?.focus();
            }}>关闭提示</button>}
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
