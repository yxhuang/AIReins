import { t } from "../i18n";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FONT_SCALE_EVENT } from "../font-scale";

// 输入框底栏的「胶囊按钮 + 弹出菜单」：按钮直接显示当前值（如「Opus 5.5 High」「⚡ Auto」），
// 点开是分组的单选菜单。会话输入框与新建会话表单共用。
// 浮层相对最近的 position:relative 祖先（.cfg-bar）定位，而不是胶囊本身：
// 侧栏窄且 overflow 会裁切，贴着整条底栏的左/右边缘展开最不容易被切掉。

export interface MenuItem {
  value: string;
  label: ReactNode;
  /** 选中后不触发 onSelect 的展示项（如会话里的「跟随配置」：不能用来撤销覆盖） */
  inert?: boolean;
}

export interface MenuGroup {
  id: string;
  title: string;
  items: MenuItem[];
  selected: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  /** 组底部的中性小字（事实说明，如重启代价、别名精度） */
  note?: ReactNode;
  /** 有序档位（推理强度）画成横向滑块，而不是逐行列表 */
  slider?: boolean;
  /** 跟随配置时的实际生效值：滑块把它画成虚的滑钮，不编造选中 */
  effective?: string;
}

function ConfigPill({
  label,
  icon,
  groups,
  title,
  align = "left",
  placement = "up",
  kind,
  cwd,
}: {
  kind: "main" | "perm";
  cwd?: string;
  label: ReactNode;
  icon?: ReactNode;
  groups: MenuGroup[];
  title?: string;
  align?: "left" | "right";
  placement?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const disabled = groups.every((g) => g.disabled);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // 新建页的卡片在屏幕中央，不能只按 vh 限高：菜单可能仍超出按钮下方的可见区。
  useLayoutEffect(() => {
    if (!open || placement !== "down") return;
    const panel = panelRef.current;
    const anchor = panel?.offsetParent;
    if (!panel || !(anchor instanceof HTMLElement)) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--font-scale")) || 1;
      const above = Math.max(0, rect.top - top - 16);
      const below = Math.max(0, bottom - rect.bottom - 16);
      const up = panel.scrollHeight * scale > below && above > below;
      panel.style.top = up ? "auto" : "calc(100% + 4px)";
      panel.style.bottom = up ? "calc(100% + 4px)" : "auto";
      panel.style.maxHeight = `calc(${(up ? above : below) / scale}px - env(safe-area-inset-bottom, 0px))`;
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      position();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    window.addEventListener("resize", position);
    window.addEventListener(FONT_SCALE_EVENT, position);
    document.addEventListener("scroll", onScroll, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener(FONT_SCALE_EVENT, position);
      document.removeEventListener("scroll", onScroll, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ??
      panel?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [role="slider"][tabindex="0"]') ?? [],
      );
      if (items.length === 0) return;
      e.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // 禁用了就把已打开的浮层收掉（如点选后进入重启切换）
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <span className={`cfg-pill-wrap cfg-pill-${kind}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`cfg-pill${open ? " open" : ""}`}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {icon}
        {label}
      </button>
      {open && (
        <div className={`cfg-menu cfg-menu-${align} cfg-menu-${placement}`} role="menu" ref={panelRef}>
          {cwd && <div className="cfg-menu-cwd mono" title={cwd}>{t("ui.ConfigMenu.working_directory_sentence", { p0: (cwd) })}</div>}
          {groups.map((group) => (
            <div className="cfg-group" role="group" aria-label={group.title} key={group.id}>
              {groups.length > 1 && !group.slider && <div className="cfg-group-title">{group.title}</div>}
              {group.slider && <StepSlider group={group} />}
              {!group.slider && group.items.map((item) => {
                const checked = item.value === group.selected;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    key={item.value}
                    className="cfg-item"
                    disabled={group.disabled}
                    onClick={() => {
                      if (!item.inert && !checked) group.onSelect(item.value);
                      close(true);
                    }}
                  >
                    <span className="cfg-check" aria-hidden="true">{checked ? <CheckIcon /> : null}</span>
                    <span className="cfg-item-label">{item.label}</span>
                  </button>
                );
              })}
              {group.note && <div className="cfg-note">{group.note}</div>}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// 推理强度滑块：点/拖/←→ 选档。live 会话里每次改都要重启 worker，所以先只动草稿，
// 松手才提交；键盘连按停 600ms 再提交；浮层关掉时没提交的也补交。回显到了才丢草稿。
function StepSlider({ group }: { group: MenuGroup }) {
  const steps = group.items.filter((item) => item.value !== "");
  const follow = group.items.find((item) => item.value === "");
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 按下时锁定滑块的坐标框：拖动中标签文字变宽变窄不能反过来改变档位换算（曾因此来回跳档闪烁）
  const dragRect = useRef<DOMRect | null>(null);
  const groupRef = useRef(group);
  groupRef.current = group;
  const selectedIndex = steps.findIndex((step) => step.value === group.selected);
  const index = draft ?? selectedIndex;
  const followIndex = steps.findIndex((step) => step.value === group.effective);
  const shown = index >= 0 ? index : followIndex;

  const commit = () => {
    clearTimeout(timer.current);
    const i = pending.current;
    pending.current = null;
    const step = i === null ? undefined : steps[i];
    if (step && step.value !== groupRef.current.selected) groupRef.current.onSelect(step.value);
  };
  const move = (i: number, delay: number | null) => {
    const next = Math.max(0, Math.min(steps.length - 1, i));
    setDraft(next);
    pending.current = next;
    clearTimeout(timer.current);
    if (delay !== null) timer.current = setTimeout(commit, delay);
  };
  const indexAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = dragRect.current ?? e.currentTarget.getBoundingClientRect();
    return Math.floor(((e.clientX - rect.left) / rect.width) * steps.length);
  };

  useEffect(() => setDraft(null), [group.selected]);
  useEffect(() => () => commit(), []);

  const valueText =
    index >= 0
      ? String(steps[index]?.label ?? "")
      : t("ui.ConfigMenu.use_configuration", { p0: (followIndex >= 0 ? ` · ${String(steps[followIndex]?.label ?? "")}` : "") });
  const fill = shown >= 0 ? ((shown + 0.5) / steps.length) * 100 : 0;
  return (
    <div className="cfg-slider-row">
      <span className="cfg-slider-label" title={valueText}>
        {group.title}
        <span className="cfg-slider-value">（{valueText}）</span>
      </span>
      {follow && !follow.inert && group.selected !== "" && (
        <button type="button" className="cfg-slider-reset" disabled={group.disabled} onClick={() => group.onSelect("")}>{t("ui.common.default")}</button>
      )}
      <div
        role="slider"
        tabIndex={group.disabled ? -1 : 0}
        aria-label={group.title}
        aria-valuemin={0}
        aria-valuemax={steps.length - 1}
        aria-valuenow={shown >= 0 ? shown : undefined}
        aria-valuetext={valueText}
        aria-disabled={group.disabled}
        className={`cfg-slider${index < 0 ? " follow" : ""}`}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onPointerDown={(e) => {
          if (group.disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRect.current = e.currentTarget.getBoundingClientRect();
          move(indexAt(e), null);
        }}
        onPointerMove={(e) => {
          if (dragRect.current) move(indexAt(e), null);
        }}
        onPointerUp={() => {
          dragRect.current = null;
          commit();
        }}
        onPointerCancel={() => {
          dragRect.current = null;
          commit();
        }}
        onKeyDown={(e) => {
          if (group.disabled) return;
          const base = index >= 0 ? index : Math.max(followIndex, 0);
          const next =
            e.key === "ArrowRight" ? base + 1
            : e.key === "ArrowLeft" ? base - 1
            : e.key === "Home" ? 0
            : e.key === "End" ? steps.length - 1
            : null;
          if (next === null) return;
          e.preventDefault();
          move(next, 600);
        }}
      >
        {steps.map((step, i) => (
          <span key={step.value} className={`cfg-step${i === shown ? " thumb" : ""}${i < shown ? " on" : ""}`} />
        ))}
      </div>
    </div>
  );
}

interface BuiltPill {
  group: MenuGroup;
  text: string;
  fullText?: string;
  /** 禁用原因，作胶囊 title */
  reason?: string;
}

/** 一行胶囊：模型+推理强度合成一个（「Opus 5.5 High」），审批模式单独一个靠右。 */
const COMPACT_PERMISSION_LABELS: Record<string, string> = {
  "Ask for approval": "Ask",
  "Approve for me": "Auto",
  "Full access": "Full",
};

export function ConfigPills({
  main,
  perm,
  permMode,
  cwd,
  placement = "up",
  beforePerm,
}: {
  main: BuiltPill[];
  perm: BuiltPill | null;
  permMode: string;
  cwd?: string;
  placement?: "up" | "down";
  beforePerm?: ReactNode;
}) {
  return (
    <div className="cfg-pills">
      {main.length > 0 && (
        <ConfigPill
          kind="main"
          cwd={cwd}
          title={[main.map((m) => m.fullText ?? m.text).join(" · "), main.map((m) => m.reason).find(Boolean)].filter(Boolean).join("；")}
          placement={placement}
          label={
            <>
              <span className="cfg-pill-model">{main[0]!.text}</span>
              {/* 推理强度跟随配置且无从得知实际值时不显示，免得出现「默认 默认」 */}
              {main[1] && main[1].text !== t("ui.common.default") && <span className="cfg-pill-sub">{main[1].text}</span>}
            </>
          }
          groups={main.map((m) => m.group)}
        />
      )}
      {beforePerm}
      {perm && (
        <ConfigPill
          kind="perm"
          icon={<PermissionIcon mode={permMode} />}
          title={[`${perm.group.title}：${perm.text}`, perm.reason].filter(Boolean).join("；")}
          placement={placement}
          align="right"
          label={<span className="cfg-perm-label">
            <span className="cfg-perm-full">{perm.text}</span>
            <span className="cfg-perm-short">{COMPACT_PERMISSION_LABELS[perm.text] ?? perm.text}</span>
          </span>}
          groups={[perm.group]}
        />
      )}
    </div>
  );
}

// ---- 内联自画图标（不引图标库），全部 currentColor ----

const svgProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function CheckIcon() {
  return <svg {...svgProps}><path d="M20 6 9 17l-5-5" /></svg>;
}

export function ClockIcon() {
  return <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

export function PlusIcon() {
  return <svg {...svgProps} width={16} height={16}><path d="M12 5v14M5 12h14" /></svg>;
}

export function SendIcon() {
  return <svg {...svgProps} width={16} height={16}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}

export function StopIcon() {
  return <svg {...svgProps} width={16} height={16}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>;
}

/** 审批模式按「放权程度」配图标：盾=逐项审批，笔=放行编辑，清单=只规划，闪电=自动放行。 */
function PermissionIcon({ mode }: { mode: string }) {
  if (mode === "plan") {
    return <svg {...svgProps}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>;
  }
  if (mode === "acceptEdits") {
    return <svg {...svgProps}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
  }
  if (["auto", "yolo", "never", "dontAsk", "bypassPermissions"].includes(mode)) {
    return <svg {...svgProps}><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></svg>;
  }
  return <svg {...svgProps}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
}
