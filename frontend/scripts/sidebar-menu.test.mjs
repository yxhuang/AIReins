import { strict as assert } from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { store } from '../src/store.ts';
globalThis.React = React;
const { Sidebar } = await import('../src/components/Sidebar.tsx');
const selectors = await import('../src/sidebar-sessions.ts');
const interaction = await import('../src/sidebar-menu.ts').catch(() => ({}));
const menu = await import('../src/components/SidebarActionMenu.tsx').catch(() => ({}));
let pass = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } }
const now = new Date(2026, 9, 3, 0, 30).getTime();
const session = (id, age = 0, status = 'idle', extra = {}) => ({ id, agent: 'claude', cwd: '/repo', title: id, status, config: {}, createdAt: new Date(now - age).toISOString(), lastActivityAt: new Date(now - age).toISOString(), ...extra });
const section = (sessions, pending = {}) => selectors.selectSidebarSections({ sessions, projectOrder: ['/repo'], now, currentId: null, pendingCount: id => pending[id] ?? 0 });
t('目录分组：跨午夜和 2h 边界不拆组，组内活动倒序，空目录隐藏', () => {
  const result = section([session('boundary', 7200000), session('earlier', 7200001), session('running', 90000000, 'running')]);
  assert.deepEqual(result.projects.map(x => [x.path, x.sessions.map(s => s.id)]), [['/repo', ['boundary', 'earlier', 'running']]]);
  assert.deepEqual(section([]).projects, []);
});
t('目录分组：随原有 now 时钟越过 72h 后隐藏', () => {
  const input = { sessions: [session('old', 72 * 3600000)], projectOrder: ['/repo'], now, currentId: null, pendingCount: () => 0 };
  assert.equal(selectors.selectSidebarSections(input).projects.length, 1);
  assert.equal(selectors.selectSidebarSections({ ...input, now: now + 1 }).projects.length, 0);
});
t('组织：置顶不限 72h 且 dead 保留，闸门优先且每个会话只出现一次', () => {
  const result = section([session('pin', 400000000, 'dead', { pinned: true }), session('dead', 400000000, 'dead'), session('gate', 400000000, 'dead', { pinned: true }), session('recent')], { gate: 1 });
  assert.deepEqual(result.waiting.map(x => x.id), ['gate']);
  assert.deepEqual(result.pinned.map(x => x.id), ['pin']);
  assert.deepEqual(result.projects[0].sessions.map(x => x.id), ['recent']);
  const all = [...result.waiting, ...result.pinned, ...result.projects.flatMap(x => x.sessions)].map(x => x.id);
  assert.equal(new Set(all).size, 3); assert.equal(all.length, 3);
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
  const html = renderToStaticMarkup(React.createElement(menu.SidebarActionMenu, { position: { x: 10, y: 10 }, label: '会话操作', description: '/repo/完整路径', items: [
    { id: 'pin', label: '取消置顶', icon: 'pin', shortcut: 'P', onSelect() {} }, { id: 'rename', label: '重命名', icon: 'rename', shortcut: 'R', onSelect() {} },
    { id: 'delete', label: '删除', icon: 'delete', shortcut: 'D', danger: true, divider: true, onSelect() {} },
  ], onClose() {} }));
  for (const text of ['取消置顶', '重命名', '删除']) assert.ok(html.includes(text));
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 3); assert.ok(html.includes('row-menu-shortcut')); assert.ok(html.includes('role="separator"')); assert.ok(html.includes('<svg')); assert.ok(html.indexOf('/repo/完整路径') < html.indexOf('取消置顶'));
});
t('行渲染：默认折叠、工作中自动展开、手动优先、旧键忽略及隐私回退', () => {
  const savedStorage = globalThis.localStorage;
  const savedWindow = globalThis.window;
  globalThis.window ??= { location: { href: "http://127.0.0.1:8790/", hash: "#/" }, innerWidth: 1280, matchMedia: () => ({ matches: false }) };
  const reads = [];
  let folds = null;
  globalThis.localStorage = { getItem: key => { reads.push(key); return key === 'aireins-project-folds' ? folds : '["/repo"]'; }, setItem() {}, removeItem() {} };
  const saved = { sessions: store.sessions, now: store.now, currentId: store.currentId, projectOrder: store.projectOrder, pendingCount: store.pendingCount, historyOpen: store.historyOpen, currentPageId: store.currentPageId };
  try {
    Object.assign(store, { now, currentId: null, projectOrder: ['/repo'], sessions: [session('wait', 0, 'idle', { pendingGateCount: 1 }), session('pin', 400000000, 'dead', { pinned: true }), session('fresh'), session('old', 7200001)], pendingCount: id => id === 'wait' ? 1 : 0, historyOpen: false, currentPageId: null });
    const render = () => renderToStaticMarkup(React.createElement(Sidebar, { collapsed: false, onToggle() {} }));
    const expanded = html => /aria-expanded="true" aria-controls="project-%2Frepo"/.test(html);
    const html = render();
    const order = ['等待处理', '置顶', 'class="project-name"'].map(x => html.indexOf(x)); assert.ok(order.every((x, i) => x >= 0 && (!i || x > order[i - 1])));
    assert.equal(expanded(html), false, '空闲目录默认折叠');
    assert.ok(!html.includes('aria-label="会话 fresh 的操作"')); assert.ok(html.includes('aria-label="工作目录 repo 的操作"'));
    assert.ok(html.includes('class="project-toggle" title="/repo"'));
    assert.ok(html.includes('aria-label="搜索会话"')); assert.ok(!html.includes('ChatGPT'));
    assert.ok(reads.includes('aireins-project-folds') && !reads.includes('aireins-collapsed-projects'), '读取新键且不读取旧折叠键');
    const original = store.sessions;
    for (const extra of [{ status: 'running' }, { status: 'starting' }, { backgroundTasks: [{ id: 'background' }] }]) {
      store.sessions = original.map(item => item.id === 'fresh' ? { ...item, ...extra } : item);
      assert.equal(expanded(render()), true, '工作状态自动展开');
    }
    store.sessions = original;
    store.currentId = 'fresh';
    assert.equal(expanded(render()), true, '当前打开会话自动展开');
    store.currentId = null;
    assert.equal(expanded(render()), false, '工作结束自动折叠');
    store.sessions = original.map(item => item.id === 'fresh' ? { ...item, status: 'error' } : item);
    assert.equal(expanded(render()), false, '错误状态不自动展开');
    folds = '{"/repo":"open"}';
    store.sessions = original;
    const opened = render();
    assert.equal(expanded(opened), true, '手动展开覆盖空闲折叠');
    assert.equal((opened.match(/status-idle/g) ?? []).length, 1);
    assert.ok(opened.includes('aria-label="会话 fresh 的操作"'));
    folds = '{"/repo":"closed"}';
    store.sessions = original.map(item => item.id === 'fresh' ? { ...item, status: 'running' } : item);
    const folded = render();
    assert.ok(/aria-expanded="false" aria-controls="project-%2Frepo"/.test(folded));
    assert.ok(folded.includes('class="project-count" aria-label="2 个会话">2</span>'));
    assert.ok(folded.includes('status-dot status-running'));
    assert.ok(!folded.includes('aria-label="会话 fresh 的操作"'));
    assert.ok(folded.includes('aria-label="会话 wait 的操作"') && folded.includes('aria-label="会话 pin 的操作"'));
    store.sessions = original;
    for (const invalid of ['[]', 'null', '{"/repo":"invalid"}', '{']) {
      folds = invalid;
      assert.equal(expanded(render()), false, '无效持久化值回退默认折叠');
    }
    globalThis.localStorage.getItem = () => { throw new Error('Private mode'); };
    assert.equal(expanded(render()), false, '隐私模式读取失败保留默认规则');
  } finally { Object.assign(store, saved); globalThis.localStorage = savedStorage; globalThis.window = savedWindow; }
});
t('右键、500ms 长按、⋮ 共用 openMenu；重命名 Enter/Esc/失焦与触屏命中', () => {
  const source = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(source.includes('onContextMenu=')); assert.ok(source.includes('}, 500)')); assert.ok(source.includes('onBlur=')); assert.ok(source.includes('normalizeSidebarTitle'));
  assert.match(source, /onContextMenu={[\s\S]*?openMenu\(/); assert.match(source, /longPressTimer.current = window.setTimeout\([\s\S]*?openMenu\(/);
  assert.match(css, /\.session-title-input[\s\S]*?font-size: 15px/); assert.ok(css.includes('min-height: 44px')); assert.ok(!css.includes('session-swipe-remove'));
});
if (!process.exitCode) console.log(`✅ sidebar menu 回归全过（${pass} 例）`);
