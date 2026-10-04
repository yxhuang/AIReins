import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

const MIN_WIDTH = 224;
const DEFAULT_WIDTH = 304;
const COLLAPSED_WIDTH = 52;
const RESISTANCE_DISTANCE = 48;
const REOPEN_DISTANCE = 12;
const STORAGE_KEY = "workbench-sidebar-width";
const DEFAULT_STORAGE_KEY = "workbench-sidebar-default-width";
const clampWidth = (width: number, maximum: number) => Math.max(MIN_WIDTH, Math.min(maximum, width));

function readSavedWidth(key = STORAGE_KEY): number | null {
  try {
    const saved = localStorage.getItem(key);
    if (saved === null || !saved.trim()) return null;
    const width = Number(saved);
    return Number.isFinite(width) ? Math.max(MIN_WIDTH, width) : null;
  } catch { return null; }
}

/** 宽度直接更新侧栏的 CSS 变量，拖动不重渲染整个会话列表。 */
export function SidebarResize({ collapsed, usageOpen, onToggle }: { collapsed: boolean; usageOpen: boolean; onToggle: () => void }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const defaultWidth = useRef(DEFAULT_WIDTH);
  const [maximum, setMaximum] = useState(DEFAULT_WIDTH * 1.5);
  const usageSizing = useRef<{ maximum: number } | null>(null);
  const drag = useRef<{
    pointerId: number; startX: number; startWidth: number; scale: number;
    collapsed: boolean; reopenWidth: number;
  } | null>(null);

  const sidebar = () => handleRef.current?.parentElement;
  const maxWidth = () => usageSizing.current?.maximum ?? defaultWidth.current * 1.5;
  const applyWidth = (value: number) => {
    const next = clampWidth(value, maxWidth());
    sidebar()?.style.setProperty(usageSizing.current ? "--sidebar-panel-width" : "--sidebar-width", `${next}px`);
    setWidth(next);
    return next;
  };
  const saveWidth = (value: number) => {
    if (usageSizing.current) return;
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* 仅本次页面生效 */ }
  };
  const clearResistance = () => {
    const element = sidebar();
    element?.removeAttribute("data-resisting");
    element?.style.removeProperty("--sidebar-resistance");
  };
  const finishDrag = () => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    const element = sidebar();
    if (element) saveWidth(clampWidth(Number.parseFloat(element.style.getPropertyValue("--sidebar-width")) || element.offsetWidth, maxWidth()));
    clearResistance();
    element?.removeAttribute("data-resizing");
    document.body.classList.remove("sidebar-resizing");
    const handle = handleRef.current;
    if (handle?.hasPointerCapture(active.pointerId)) handle.releasePointerCapture(active.pointerId);
    if (active.collapsed) element?.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus();
  };

  useLayoutEffect(() => {
    const element = handleRef.current?.parentElement;
    if (!element) return;
    // 首次升级记下用户当前宽度；之后拖动不改变这个默认值。
    const saved = readSavedWidth(DEFAULT_STORAGE_KEY) ?? readSavedWidth() ?? DEFAULT_WIDTH;
    defaultWidth.current = saved;
    setMaximum(saved * 1.5);
    try { localStorage.setItem(DEFAULT_STORAGE_KEY, String(saved)); } catch { /* 仅本次页面生效 */ }
    element.style.setProperty("--sidebar-width", `${saved}px`);
    element.style.setProperty("--sidebar-default-width", `${saved}px`);
    const measure = () => setWidth(Math.max(COLLAPSED_WIDTH, element.offsetWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const desktop = window.matchMedia("(min-width: 721px)");
    const changeLayout = () => finishDrag();
    desktop.addEventListener("change", changeLayout);
    return () => {
      observer.disconnect();
      desktop.removeEventListener("change", changeLayout);
      drag.current = null;
      element.removeAttribute("data-resizing");
      element.removeAttribute("data-resisting");
      element.style.removeProperty("--sidebar-resistance");
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  useLayoutEffect(() => {
    const element = sidebar();
    if (!element) return;
    if (usageOpen) {
      // CSS 先取当前宽度与原额度页固定宽度的较大者，再用独立变量承载页面内的拖动。
      const wasResizing = element.hasAttribute("data-resizing");
      element.setAttribute("data-resizing", "");
      element.style.removeProperty("--sidebar-panel-width");
      const expanded = Number.parseFloat(getComputedStyle(element).width);
      usageSizing.current = { maximum: Math.max(defaultWidth.current * 1.5, expanded) };
      element.style.setProperty("--sidebar-panel-width", `${expanded}px`);
      if (!wasResizing) element.removeAttribute("data-resizing");
      setMaximum(usageSizing.current.maximum);
    } else {
      usageSizing.current = null;
      element.style.removeProperty("--sidebar-panel-width");
      setMaximum(defaultWidth.current * 1.5);
    }
  }, [usageOpen]);

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = active.startWidth + (event.clientX - active.startX) / active.scale;
    if (active.collapsed) {
      if (next >= active.reopenWidth) {
        active.collapsed = false;
        applyWidth(next);
        onToggle();
      }
      return;
    }
    applyWidth(next);
    const pull = Math.max(0, MIN_WIDTH - next);
    if (pull > 0) {
      const element = sidebar();
      element?.setAttribute("data-resisting", "");
      element?.style.setProperty("--sidebar-resistance", `${Math.min(5, pull / RESISTANCE_DISTANCE * 5)}px`);
    } else clearResistance();
    if (pull >= RESISTANCE_DISTANCE) {
      // 保持同一个拖动条和指针捕获，反向拉动时可以直接重新展开。
      active.collapsed = true;
      active.reopenWidth = next + REOPEN_DISTANCE;
      clearResistance();
      onToggle();
    }
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    finishDrag();
  };
  const toggleWithFocus = () => {
      const element = sidebar();
      onToggle();
      requestAnimationFrame(() => element?.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus());
  };

  return <div ref={handleRef} className="sidebar-resize" role="separator" tabIndex={0}
    aria-label="调整左侧栏宽度" aria-orientation="vertical"
    aria-valuemin={collapsed ? COLLAPSED_WIDTH : MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={collapsed ? COLLAPSED_WIDTH : Math.round(width)}
    title={collapsed ? "向右拖动展开左侧栏；双击恢复默认宽度" : "拖动调整宽度，越过最窄处的阻力后收起；双击恢复默认宽度"}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || !window.matchMedia("(min-width: 721px)").matches) return;
      const element = sidebar();
      if (!element) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId, startX: event.clientX, startWidth: element.offsetWidth,
        scale: element.getBoundingClientRect().width / element.offsetWidth,
        collapsed, reopenWidth: COLLAPSED_WIDTH + REOPEN_DISTANCE,
      };
      element.setAttribute("data-resizing", "");
      document.body.classList.add("sidebar-resizing");
    }}
    onPointerMove={moveDrag}
    onPointerUp={(event) => { moveDrag(event); endDrag(event); }}
    onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onDoubleClick={() => {
      saveWidth(applyWidth(defaultWidth.current));
      if (collapsed) onToggle();
    }}
    onKeyDown={(event) => {
      const element = sidebar();
      if (!element) return;
      const current = clampWidth(element.offsetWidth, maxWidth());
      const delta = event.key === "ArrowLeft" ? -12 : event.key === "ArrowRight" ? 12 : 0;
      if (!delta && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      if (collapsed) {
        if (delta > 0 || event.key === "End") {
          saveWidth(applyWidth(event.key === "End" ? maxWidth() : MIN_WIDTH));
          onToggle();
        }
        return;
      }
      if (event.key === "ArrowLeft" && current <= MIN_WIDTH) {
        toggleWithFocus();
      } else {
        saveWidth(applyWidth(event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth() : current + delta));
      }
    }} />;
}
