import { useEffect, useRef, useState } from "react";
import { fetchClaudeStartupSettings, fetchPrefs, saveClaudeStartupSettings, savePrefs } from "../api";
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
        label: "空闲自动释放",
        options: [
          { value: "0", label: "关闭" },
          { value: "15", label: "15 分钟" },
          { value: "30", label: "30 分钟" },
          { value: "60", label: "60 分钟" },
          { value: "120", label: "120 分钟" },
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
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const [scaleChoice, setScaleChoice] = useState<FontScaleChoice>(readFontScaleChoice);
  const [idleRelease, setIdleRelease] = useState("30");
  const [rcStartup, setRcStartup] = useState<boolean | null>(null);
  const [rcSaving, setRcSaving] = useState(false);
  const [rcError, setRcError] = useState<string | null>(null);
  const rcPending = useRef(false);
  const rcVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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
    if (!open) return;
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
  }, [open]);

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
    else if (id === "idle-release") chooseIdleRelease(value);
  };

  const selectedValue = (id: string): string => {
    if (id === "theme") return theme;
    if (id === "font-scale") return scaleChoice;
    return idleRelease;
  };

  /** 服务端存了非档位值（如手动编辑 prefs.json）时补一个如实显示的选项，不猜不改。 */
  const optionsFor = (item: SettingItem): SettingOption[] => {
    if (item.id !== "idle-release") return item.options;
    if (item.options.some((option) => option.value === idleRelease)) return item.options;
    return [...item.options, { value: idleRelease, label: `${idleRelease} 分钟` }];
  };

  return (
    <div className="settings" ref={rootRef}>
      {open && (
        <div className="settings-panel" ref={panelRef} role="dialog" aria-label="设置">
          {SETTING_GROUPS.map((group) => (
            <section className="settings-group" key={group.id}>
              <h3 className="settings-group-title">{group.label}</h3>
              {group.items.map((item) => (
                <div className="settings-item" key={item.id}>
                  <span className="settings-item-label" id={`settings-item-${item.id}`}>
                    {item.label}
                  </span>
                  {item.id === "remote-control-startup" ? <>
                    <button type="button" role="switch" aria-checked={rcStartup === true}
                      aria-labelledby={`settings-item-${item.id}`} aria-describedby="settings-rc-hint"
                      className="settings-option settings-toggle" disabled={rcStartup === null || rcSaving}
                      onClick={() => void toggleRcStartup()}>
                      <span>{rcSaving ? "保存中…" : rcStartup === null ? (rcError ? "读取失败" : "读取中…") : rcStartup ? "开启" : "关闭"}</span>
                      <span className={`slash-switch${rcStartup ? " on" : ""}`} aria-hidden="true" />
                    </button>
                    <span className="settings-hint" id="settings-rc-hint">仅对新建、续接或释放后再发送的会话生效。</span>
                    {rcError && <span className="new-error" role="alert">{rcError}</span>}
                  </> : <div
                    className="settings-options"
                    role="radiogroup"
                    aria-labelledby={`settings-item-${item.id}`}
                    onKeyDown={(e) => {
                      // roving tabindex：方向键在组内循环移动焦点并同时选中
                      const dir =
                        e.key === "ArrowDown" || e.key === "ArrowRight"
                          ? 1
                          : e.key === "ArrowUp" || e.key === "ArrowLeft"
                            ? -1
                            : 0;
                      if (dir === 0) return;
                      e.preventDefault();
                      const buttons = Array.from(
                        e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                      );
                      const index = buttons.indexOf(e.target as HTMLButtonElement);
                      if (index === -1) return;
                      const options = optionsFor(item);
                      const nextIndex = (index + dir + options.length) % options.length;
                      const nextButton = buttons[nextIndex];
                      const nextOption = options[nextIndex];
                      if (!nextButton || !nextOption) return;
                      nextButton.focus();
                      choose(item.id, nextOption.value);
                    }}
                  >
                    {optionsFor(item).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selectedValue(item.id) === option.value}
                        tabIndex={selectedValue(item.id) === option.value ? 0 : -1}
                        className={`settings-option${selectedValue(item.id) === option.value ? " selected" : ""}`}
                        onClick={() => choose(item.id, option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>}
                </div>
              ))}
            </section>
          ))}
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
