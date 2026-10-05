import { useEffect, useRef, type RefObject } from "react";

/** 设置与直达共用非模态浮层：Esc 返回按钮，外点保留目标焦点。 */
export function useAnchoredMenu({ open, rootRef, buttonRef, panelRef, close, initialFocus, trapFocus = false }: {
  open: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  close: (returnFocus: boolean) => void;
  initialFocus: string;
  trapFocus?: boolean;
}) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    (panelRef.current?.querySelector<HTMLElement>(initialFocus) ?? panelRef.current)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current(true);
        return;
      }
      if (!trapFocus || e.key !== "Tab") return;
      const panel = panelRef.current;
      const items = panel?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
      if (!panel || !items?.length) return;
      const first = items.item(0), last = items.item(items.length - 1);
      const outside = !panel.contains(document.activeElement);
      if (e.shiftKey && (outside || document.activeElement === first)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (outside || document.activeElement === last)) {
        e.preventDefault(); first.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) closeRef.current(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!trapFocus && !rootRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) closeRef.current(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, rootRef, buttonRef, panelRef, initialFocus, trapFocus]);
}
