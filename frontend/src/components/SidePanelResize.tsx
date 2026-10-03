import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type PointerEvent } from "react";
import { clampPanelWidth, TERM_DEFAULT_WIDTH, TERM_MAIN_MIN_WIDTH, TERM_MIN_WIDTH } from "../terminal";

// 终端与派单沿用原来的宽度和同步事件；文件面板单独记忆。
const DEFAULT_WIDTH_OPTIONS = {
  storageKey: "workbench-term-width", event: "workbench-panel-width",
  minWidth: TERM_MIN_WIDTH, defaultWidth: TERM_DEFAULT_WIDTH,
};
export const FILE_WIDTH_OPTIONS = {
  storageKey: "workbench-file-width", event: "workbench-file-panel-width",
  minWidth: 240, defaultWidth: 280,
};
type WidthOptions = typeof DEFAULT_WIDTH_OPTIONS;
const viewportWidth = () => window.innerWidth;

function readSavedWidth(options: WidthOptions): number {
  try {
    const raw = localStorage.getItem(options.storageKey);
    return raw === null ? options.defaultWidth : Number(raw);
  } catch { return options.defaultWidth; }
}

export function useSidePanelWidth(options: WidthOptions = DEFAULT_WIDTH_OPTIONS) {
  const { storageKey, event: widthEvent, minWidth, defaultWidth } = options;
  const [width, setWidth] = useState(() => clampPanelWidth(readSavedWidth(options), viewportWidth(), minWidth, defaultWidth));
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(width)); } catch { /* 仅本次会话生效 */ }
    window.dispatchEvent(new CustomEvent(widthEvent, { detail: width }));
  }, [width, storageKey, widthEvent]);
  useEffect(() => {
    const resize = () => setWidth((value) => clampPanelWidth(value, viewportWidth(), minWidth, defaultWidth));
    const sync = (event: Event) => setWidth((event as CustomEvent<number>).detail);
    window.addEventListener("resize", resize);
    window.addEventListener(widthEvent, sync);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener(widthEvent, sync);
    };
  }, [widthEvent, minWidth, defaultWidth]);
  return [width, setWidth] as const;
}

/** 三个右侧面板共用的收起图标。 */
/** 右侧面板（终端 / 文件 / 派单）共用的「返回」，只在窄屏显示（宽屏用收起按钮）。 */
export function PanelBackButton({ onClick, label = "返回" }: { onClick: () => void; label?: string }) {
  return <button type="button" className="panel-back" onClick={onClick}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
    {label}
  </button>;
}

export function PanelRightIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
  </svg>;
}

export function SidePanelResize({ label, width, setWidth, minWidth = TERM_MIN_WIDTH, defaultWidth = TERM_DEFAULT_WIDTH }: {
  label: string; width: number; setWidth: Dispatch<SetStateAction<number>>;
  minWidth?: number; defaultWidth?: number;
}) {
  const dragging = useRef(false);
  useEffect(() => () => {
    if (dragging.current) document.body.classList.remove("resizing");
  }, []);
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove("resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="term-split" role="separator" aria-orientation="vertical"
    aria-label={`调整${label}面板宽度`} aria-valuenow={width} aria-valuemin={minWidth}
    aria-valuemax={Math.max(minWidth, viewportWidth() - TERM_MAIN_MIN_WIDTH)} tabIndex={0}
    title="拖动调整宽度，双击复位"
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = true;
      document.body.classList.add("resizing");
    }}
    onPointerMove={(event) => {
      if (!dragging.current) return;
      const workspace = event.currentTarget.parentElement;
      if (workspace) setWidth(clampPanelWidth(workspace.getBoundingClientRect().right - event.clientX, viewportWidth(), minWidth, defaultWidth));
    }}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onDoubleClick={() => setWidth(clampPanelWidth(defaultWidth, viewportWidth(), minWidth, defaultWidth))}
    onKeyDown={(event) => {
      const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
      if (!delta) return;
      event.preventDefault();
      setWidth((value) => clampPanelWidth(value + delta, viewportWidth(), minWidth, defaultWidth));
    }} />;
}
