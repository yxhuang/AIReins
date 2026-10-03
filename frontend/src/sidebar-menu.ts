/** 未打开的行只响应向左滑；一旦锁定纵向，本次手势不再转向。 */
export function lockSidebarSwipe(direction: 'horizontal' | 'vertical' | null, dx: number, dy: number, open: boolean) {
  if (direction || Math.max(Math.abs(dx), Math.abs(dy)) < 10) return direction;
  return Math.abs(dx) > Math.abs(dy) * 1.2 && (dx < 0 || open) ? 'horizontal' : 'vertical';
}
export function sidebarSwipeOffset(initial: number, dx: number) { return Math.max(-52, Math.min(0, initial + dx)); }
export function normalizeSidebarTitle(value: string) { return value.trim().slice(0, 200); }
export function sidebarMenuKey(key: string, { editing = false, modified = false } = {}) {
  if (key === 'Escape') return 'close';
  if (editing || modified) return null;
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'previous';
  return ({ p: 'pin', r: 'rename', d: 'delete' } as Record<string, string>)[key.toLowerCase()] ?? null;
}
