import { useLayoutEffect, useRef, type RefObject } from "react";

const scopes: HTMLElement[] = [];
const focusable = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function available(element: HTMLElement): boolean {
  return !element.matches(":disabled") && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
}

/** Capture before commit: the menu item that opens a dialog may disappear during that commit. */
export function modalReturnTargets(active: Element | null): HTMLElement[] {
  if (!(active instanceof HTMLElement)) return [];
  const targets = [active];
  const menu = active.closest('[role="menu"]');
  const trigger = menu?.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
  if (trigger && !menu?.contains(trigger)) targets.push(trigger);
  return targets;
}

/** Only the innermost modal owns focus; nested menus retain their own Escape handling. */
export function mountModalFocus(dialog: HTMLElement, initial: HTMLElement | null, returnTargets: HTMLElement[]): () => void {
  scopes.push(dialog);
  let lastFocused: HTMLElement | null = null;
  const isTop = () => scopes.at(-1) === dialog;
  const items = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(available);
  const focusInside = () => {
    const target = lastFocused?.isConnected && dialog.contains(lastFocused) && available(lastFocused) ? lastFocused
      : items()[0] ?? dialog;
    target.focus();
  };
  const onFocus = () => {
    if (!isTop()) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialog.contains(active)) lastFocused = active;
    else focusInside();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!isTop() || event.defaultPrevented || event.key !== "Tab") return;
    const controls = items();
    const first = controls[0], last = controls.at(-1);
    const outside = !dialog.contains(document.activeElement);
    if (!first || !last) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault(); first.focus();
    }
  };
  document.addEventListener("focusin", onFocus);
  document.addEventListener("keydown", onKey);
  (initial && available(initial) ? initial : items()[0] ?? dialog).focus();
  return () => {
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("keydown", onKey);
    const ownedFocus = isTop() && (dialog.contains(document.activeElement) || document.activeElement === document.body);
    const index = scopes.lastIndexOf(dialog);
    if (index >= 0) scopes.splice(index, 1);
    // Explicit focus chosen by the caller on close takes precedence.
    if (ownedFocus) returnTargets.find(target => target.isConnected && available(target))?.focus();
  };
}

export function useModalFocus(dialog: RefObject<HTMLElement | null>, initial: RefObject<HTMLElement | null>): void {
  const targets = useRef<HTMLElement[] | null>(null);
  if (targets.current === null) targets.current = typeof document === "undefined" ? [] : modalReturnTargets(document.activeElement);
  useLayoutEffect(() => {
    if (dialog.current) return mountModalFocus(dialog.current, initial.current, targets.current ?? []);
  }, [dialog, initial]);
}
