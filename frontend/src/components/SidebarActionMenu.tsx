import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sidebarMenuKey } from '../sidebar-menu';
export interface SidebarMenuItem {
  id: string; label: string; icon?: 'pin' | 'rename' | 'folder' | 'delete' | 'back' | 'plus' | 'ungroup' | 'send';
  shortcut?: string; trailing?: string; danger?: boolean; divider?: boolean; disabled?: boolean; onSelect: () => void;
}
function MenuIcon({ name }: { name: SidebarMenuItem['icon'] }) {
  const paths = { pin: 'm8 3 8 0-1 6 3 3-5 0-1 9-1-9-5 0 3-3Z', rename: 'm4 16 0 4 4 0L20 8 16 4Z M14 6l4 4', folder: 'M3 5h7l2 3h9v12H3Z', delete: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7', back: 'm14 5-7 7 7 7', plus: 'M12 4v16 M4 12h16', ungroup: 'M3 5h7l2 3h9v12H3Z M9 12h6', send: 'M22 2 11 13 M22 2l-7 20-4-9-9-4Z' };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name ?? 'folder']} /></svg>;
}
export function SidebarActionMenu({ position, label, items, submenuItems, children, error, onClose }: {
  position: { x: number; y: number }; label: string; items: SidebarMenuItem[]; submenuItems?: SidebarMenuItem[];
  children?: ReactNode; error?: string | null; onClose: (returnFocus?: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const activeItems = submenuItems ?? items;
  // 父行随时钟/流式重渲染会让本 effect 反复触发：自动聚焦只在进入菜单或切屏时做一次，
  // 否则 ↑↓ 键盘导航到的位置会被下一次渲染抢回第一项。
  // 主屏项异步到达（如 Taildrop 设备列表）时也算新屏，补一次聚焦。
  const screenKey = submenuItems ? `sub:${submenuItems.map(item => item.id).join(',')}` : `main:${items.length > 0}`;
  const focusedScreen = useRef<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (focusedScreen.current !== screenKey) {
      focusedScreen.current = screenKey;
      const panel = root?.querySelector<HTMLElement>('.row-menu-subscreen') ?? root;
      (panel?.querySelector<HTMLInputElement>('input') ?? panel?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    }
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) onClose(false); };
    const key = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLElement && !!event.target.closest('input, textarea, [contenteditable="true"]');
      const action = sidebarMenuKey(event.key, { editing, modified: event.altKey || event.ctrlKey || event.metaKey });
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      if (action === 'close') { onClose(true); return; }
      if (action === 'next' || action === 'previous') {
        const panel = rootRef.current?.querySelector<HTMLElement>('.row-menu-subscreen') ?? rootRef.current;
        const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (action === 'next' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else activeItems.find(item => item.id === action && !item.disabled)?.onSelect();
    };
    const dismiss = () => onClose(false);
    document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', key, true);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true);
    };
  }, [position, submenuItems, onClose, activeItems]);
  const renderItems = (list: SidebarMenuItem[]) => list.map(item => <div key={item.id}>
    {item.divider && <div className="row-menu-divider" role="separator" />}
    <button type="button" role="menuitem" className={`row-menu-item${item.danger ? ' row-menu-danger' : ''}`} disabled={item.disabled} onClick={item.onSelect}>
      <MenuIcon name={item.icon} /><span>{item.label}</span>{item.shortcut && <kbd className="row-menu-shortcut">{item.shortcut}</kbd>}{item.trailing && <span className="row-menu-trailing">{item.trailing}</span>}
    </button>
  </div>);
  const content = <div ref={rootRef} className={`row-menu${submenuItems ? ' row-menu-has-subscreen' : ''}`} role="menu" aria-label={label} style={{ left: position.x, top: position.y }}>
    <div className="row-menu-main">{renderItems(items)}</div>
    {submenuItems && <div className="row-menu-subscreen" role="menu" aria-label="移到分组">{renderItems(submenuItems)}{children}</div>}
    {!submenuItems && children}{error && <p className="row-menu-error" role="alert">{error}</p>}
  </div>;
  return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content;
}
