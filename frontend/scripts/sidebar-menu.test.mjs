import { strict as assert } from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { store } from '../src/store.ts';
import { Sidebar } from '../src/components/Sidebar.tsx';
const selectors = await import('../src/sidebar-sessions.ts');
const interaction = await import('../src/sidebar-menu.ts').catch(() => ({}));
const menu = await import('../src/components/SidebarActionMenu.tsx').catch(() => ({}));
let pass = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } }
const now = new Date(2026, 9, 3, 0, 30).getTime();
const session = (id, age = 0, status = 'idle', extra = {}) => ({ id, agent: 'claude', cwd: '/repo', title: id, status, config: {}, createdAt: new Date(now - age).toISOString(), lastActivityAt: new Date(now - age).toISOString(), ...extra });
const section = (sessions, pending = {}) => selectors.selectSidebarSections({ sessions, sessionGroups: [{ id: 'g', name: '项目', createdAt: '2026-10-01' }], now, currentId: null, pendingCount: id => pending[id] ?? 0 });
t('分区：恰好 2h 属进行中，跨本地午夜归更早，空组隐藏', () => {
  const result = section([session('boundary', 7200000), session('earlier', 7200001), session('running', 90000000, 'running')]);
  assert.deepEqual(result.sections.map(x => [x.label, x.sessions.map(s => s.id)]), [['进行中', ['boundary', 'running']], ['更早', ['earlier']]]);
  assert.deepEqual(section([]).sections, []);
});
t('分区：今天排除进行中，并随原有 now 时钟跨午夜', () => {
  const midday = new Date(2026, 9, 3, 12).getTime();
  const input = { sessions: [session('today', 0)], sessionGroups: [], now: midday, currentId: null, pendingCount: () => 0 };
  assert.equal(selectors.selectSidebarSections(input).sections[0].label, '今天');
  assert.equal(selectors.selectSidebarSections({ ...input, now: new Date(2026, 9, 4, 0).getTime() }).sections[0].label, '更早');
});
t('组织：置顶/分组不限 72h，dead 保留，闸门优先且每个会话只出现一次', () => {
  const result = section([session('pin', 400000000, 'dead', { pinned: true, groupId: 'g' }), session('group', 400000000, 'dead', { groupId: 'g' }), session('gate', 400000000, 'dead', { pinned: true }), session('recent')], { gate: 1 });
  assert.deepEqual(result.waiting.map(x => x.id), ['gate']);
  assert.deepEqual(result.pinned.map(x => x.id), ['pin']);
  assert.deepEqual(result.groups[0].sessions.map(x => x.id), ['group']);
  const all = [...result.waiting, ...result.pinned, ...result.groups.flatMap(x => x.sessions), ...result.sections.flatMap(x => x.sessions)].map(x => x.id);
  assert.equal(new Set(all).size, 4); assert.equal(all.length, 4);
});
t('状态点：空闲仅近期绿点，释放相同；运行/启动/后台/闸门/错误保留，dead 无点', () => {
  for (const extra of [{}, { released: true }]) {
    assert.equal(selectors.sidebarStatusDot(session('x', 7200000, 'idle', extra), 0, now), 'idle');
    assert.equal(selectors.sidebarStatusDot(session('x', 7200001, 'idle', extra), 0, now), null);
  }
  for (const status of ['running', 'starting', 'error']) assert.equal(selectors.sidebarStatusDot(session('x', 999999999, status), 0, now), status);
  assert.equal(selectors.sidebarStatusDot(session('x', 999999999, 'idle', { backgroundTasks: [{ id: 'task' }] }), 0, now), 'running');
  assert.equal(selectors.sidebarStatusDot(session('x', 999999999, 'dead'), 1, now), 'needs-user');
  assert.equal(selectors.sidebarStatusDot(session('x', 0, 'dead'), 0, now), null);
});
t('左滑方向锁：竖向不可转横向，只左滑可打开，右滑仅已打开时收回', () => {
  assert.equal(interaction.lockSidebarSwipe(null, -9, 0, false), null);
  assert.equal(interaction.lockSidebarSwipe(null, -30, 4, false), 'horizontal');
  assert.equal(interaction.lockSidebarSwipe(null, 30, 4, false), 'vertical');
  assert.equal(interaction.lockSidebarSwipe(null, 30, 4, true), 'horizontal');
  assert.equal(interaction.lockSidebarSwipe(null, -10, 25, false), 'vertical');
  assert.equal(interaction.lockSidebarSwipe('vertical', -80, 30, false), 'vertical');
  assert.equal(interaction.sidebarSwipeOffset(0, -90), -52);
  assert.equal(interaction.sidebarSwipeOffset(-52, 90), 0);
});
t('菜单快捷键：P/R/D、上下选择、Esc，输入/组合键不触发操作', () => {
  for (const [key, action] of [['P', 'pin'], ['r', 'rename'], ['D', 'delete'], ['ArrowDown', 'next'], ['ArrowUp', 'previous'], ['Escape', 'close']]) assert.equal(interaction.sidebarMenuKey(key), action);
  assert.equal(interaction.sidebarMenuKey('p', { editing: true }), null);
  assert.equal(interaction.sidebarMenuKey('d', { modified: true }), null);
  assert.equal(interaction.normalizeSidebarTitle('   '), ''); assert.equal(interaction.normalizeSidebarTitle(' 标题 '), '标题');
});
t('菜单渲染：图标/快捷键/分隔线/删除；已置顶显示取消置顶', () => {
  const html = renderToStaticMarkup(React.createElement(menu.SidebarActionMenu, { position: { x: 10, y: 10 }, label: '会话操作', items: [
    { id: 'pin', label: '取消置顶', icon: 'pin', shortcut: 'P', onSelect() {} }, { id: 'rename', label: '重命名', icon: 'rename', shortcut: 'R', onSelect() {} },
    { id: 'move', label: '移到分组', icon: 'folder', trailing: '›', onSelect() {} }, { id: 'delete', label: '删除', icon: 'delete', shortcut: 'D', danger: true, divider: true, onSelect() {} },
  ], onClose() {} }));
  for (const text of ['取消置顶', '重命名', '移到分组', '删除']) assert.ok(html.includes(text));
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 4); assert.ok(html.includes('row-menu-shortcut')); assert.ok(html.includes('role="separator"')); assert.ok(html.includes('<svg'));
});
t('行渲染：分区顺序与空闲点隐藏，⋮ 保持独立按钮和标题 aria', () => {
  const saved = { sessions: store.sessions, now: store.now, currentId: store.currentId, sessionGroups: store.sessionGroups, pendingCount: store.pendingCount, historyOpen: store.historyOpen, currentPageId: store.currentPageId };
  try {
    Object.assign(store, { now, currentId: null, sessionGroups: [{ id: 'g', name: '项目', createdAt: '2026-10-01' }], sessions: [session('wait'), session('pin', 400000000, 'dead', { pinned: true }), session('group', 400000000, 'idle', { groupId: 'g' }), session('fresh'), session('old', 7200001)], pendingCount: id => id === 'wait' ? 1 : 0, historyOpen: false, currentPageId: null });
    const html = renderToStaticMarkup(React.createElement(Sidebar, { collapsed: false, onToggle() {}, newOpen: false, onNewOpenChange() {} }));
    const order = ['等待处理', '置顶', '项目', '进行中', '更早'].map(x => html.indexOf(x)); assert.ok(order.every((x, i) => x >= 0 && (!i || x > order[i - 1])));
    assert.equal((html.match(/status-idle/g) ?? []).length, 1); assert.ok(html.includes('aria-label="会话 fresh 的操作"')); assert.ok(html.includes('aria-label="项目 的分组操作"'));
  } finally { Object.assign(store, saved); }
});
t('右键、500ms 长按、⋮ 共用 openMenu；重命名 Enter/Esc/失焦与触屏命中', () => {
  const source = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(source.includes('onContextMenu=')); assert.ok(source.includes('}, 500)')); assert.ok(source.includes('onBlur=')); assert.ok(source.includes('normalizeSidebarTitle'));
  assert.match(source, /onContextMenu={[\s\S]*?openMenu\(/); assert.match(source, /longPressTimer.current = window.setTimeout\([\s\S]*?openMenu\(/);
  assert.match(css, /\.session-title-input[\s\S]*?font-size: 16px/); assert.ok(css.includes('min-height: 44px')); assert.ok(!css.includes('session-swipe-remove'));
});
if (!process.exitCode) console.log(`✅ sidebar menu 回归全过（${pass} 例）`);
