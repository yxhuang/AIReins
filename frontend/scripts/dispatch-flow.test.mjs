#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { groupDispatches, dispatchName, dispatchSeconds, dispatchTime, dispatchStatus, dispatcherTitle, dispatcherSessions, dispatcherModel, subagentWireState, RECENT_DISPATCH_MS, FINISHED_WIRE_MS } from '../src/dispatch-flow.ts';
import { startDispatchPolling } from '../src/dispatch-polling.ts';
import { fetchDispatches } from '../src/api.ts';

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: '#/' }, innerWidth: 1280, addEventListener() {} };
const { Store, store } = await import('../src/store.ts');
const { App } = await import('../src/App.tsx');
const { DispatchView, DispatchTree } = await import('../src/components/DispatchView.tsx');
const { lastWindowsCwd, loadWindowsHistory } = await import('../src/components/DirectoryBrowser.tsx');
let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`❌ ${name}\n${e.stack}`); process.exitCode = 1; } };
const now = Date.parse('2026-10-01T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const run = (over = {}) => ({ runId: '20261001-100000-codex-task-name', tool: 'codex', name: '任务', model: 'gpt-test', effort: 'high', status: 'running', startedAt: iso(now - 61000), endedAt: null, elapsedS: null, session: null, parent: null, ...over });

await t('固定三端，按 tool 分组；运行中保留，结束 30 分钟边界，未知日期不冒充近期单', () => {
  const groups = groupDispatches([
    run({ startedAt: iso(now - 86400000) }),
    run({ tool: 'kimi', status: 'OK', endedAt: iso(now - RECENT_DISPATCH_MS) }),
    run({ tool: 'copilot', status: 'TIMEOUT', endedAt: iso(now - RECENT_DISPATCH_MS - 1) }),
    run({ status: 'OK', endedAt: 'bad', startedAt: null }),
    run({ status: 'unknown', startedAt: null }),
    run({ tool: 'other' }),
  ], now);
  assert.deepEqual(groups.map(g => g.tool), ['codex', 'kimi', 'copilot']);
  assert.deepEqual(groups.map(g => g.runs.length), [1, 1, 0]);
  assert.deepEqual(groups.map(g => g.wireState), ['flow', 'idle', 'idle']);
  assert.equal(groupDispatches([], now).length, 3);
});
await t('结束时间缺失可由 startedAt + elapsedS 推算；lost 从首次观察起算且会过期', () => {
  const lost = run({ status: 'lost' });
  assert.equal(groupDispatches([lost], now, new Map([[lost.runId, now]]) )[0].runs.length, 1);
  assert.equal(groupDispatches([lost], now + RECENT_DISPATCH_MS + 1, new Map([[lost.runId, now]]))[0].runs.length, 0);
  const completed = run({ status: 'TOOL_FAIL', startedAt: iso(now - RECENT_DISPATCH_MS - 1000), elapsedS: 1 });
  assert.equal(groupDispatches([completed], now)[0].runs.length, 1);
});
await t('运行中优先，最多三单与 +N；嵌套单仍普通分组，输入不被修改', () => {
  const items = Array.from({ length: 5 }, (_, i) => run({ runId: String(i), status: i === 4 ? 'running' : 'OK', endedAt: iso(now - 1000), parent: { runId: 'outer', agent: 'codex', sessionId: 'parent', entrypoint: null } }));
  const before = JSON.stringify(items);
  const g = groupDispatches(items, now)[0];
  assert.equal(g.visible.length, 3); assert.equal(g.more, 2); assert.equal(g.visible[0].runId, '4');
  assert.equal(groupDispatches(items.slice(0, 2), now)[0].more, 0);
  assert.equal(JSON.stringify(items), before);
});
await t('简述只用 name 或 runId 尾段；运行走秒，结束只用 elapsedS；状态全覆盖', () => {
  assert.equal(dispatchName(run({ name: '' })), 'task-name');
  assert.equal(dispatchName(run({ name: '  简述  ', promptHead: '不显示' })), '简述');
  assert.equal(dispatchSeconds(run(), now), 61);
  assert.equal(dispatchSeconds(run(), now + 1000), 62);
  assert.equal(dispatchSeconds(run({ status: 'OK', elapsedS: 18 }), now), 18);
  assert.equal(dispatchSeconds(run({ status: 'OK' }), now), null);
  assert.equal(dispatchSeconds(run({ startedAt: 'bad' }), now), null);
  assert.equal(dispatchTime(3661), '1:01:01'); assert.equal(dispatchTime(null), '—');
  assert.deepEqual(['running', 'OK', 'TOOL_FAIL', 'ACCEPT_FAIL', 'TIMEOUT', 'lost', 'unknown'].map(x => dispatchStatus(x).label), ['运行中', '刚完成 ✓', '失败 ✗', '失败 ✗', '失败 ✗', 'lost', '未知']);
});
await t('派单人标题：取 parent.sessionId（仅 claude）、工作台/原生 id 匹配、短 id、多个会话、执行端 session 不算', () => {
  const titles = [{ id: 'wb', nativeSessionId: 'native', title: '工作台标题' }];
  const by = (sessionId, agent = 'claude') => run({ session: 'executor-own', parent: { agent, sessionId, entrypoint: null } });
  assert.equal(dispatcherTitle([by('native')], titles), '工作台标题');
  assert.equal(dispatcherTitle([by('wb'), by('native')], titles), '工作台标题');
  assert.equal(dispatcherTitle([by('abcdefgh-123')], titles), 'Claude Code 会话 · abcdefgh');
  assert.equal(dispatcherTitle([by('native'), by('other')], titles), '工作台标题\nClaude Code 会话 · other');
  assert.equal(dispatcherTitle([by('native', 'codex')], titles), 'Claude Code 会话');
  assert.equal(dispatcherTitle([run({ session: 'native' })], titles), 'Claude Code 会话');
});

await t('多个派单会话逐行显示标题与运行数，别名去重，最多三行并显示 +N；单会话保持原样', () => {
  const titles = Array.from({ length: 5 }, (_, i) => ({ id: `wb-${i}`, nativeSessionId: `native-${i}`, title: `派单会话 ${i}` }));
  const by = (id, status = 'running') => run({ runId: id, status, endedAt: iso(now), parent: { agent: 'claude', sessionId: id, entrypoint: null } });
  const runs = [...titles.map(s => by(s.nativeSessionId)), by('wb-0'), by('native-0', 'OK')];
  const dispatchers = dispatcherSessions(runs, titles);
  assert.deepEqual(dispatchers.map(s => s.title), titles.map(s => s.title));
  assert.deepEqual(dispatchers.map(s => s.running), [2, 1, 1, 1, 1]);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches(runs, now), title: dispatcherTitle(runs, titles), dispatchers, model: null, now,
  }));
  const source = html.match(/<article class="dispatch-node dispatch-source">([\s\S]*?)<\/article>/)[1];
  assert.equal((source.match(/class="dispatch-session-title"/g) || []).length, 4);
  for (const text of ['派单会话 0 · 2 单运行中', '派单会话 1 · 1 单运行中', '派单会话 2 · 1 单运行中', '>+2<']) assert.ok(source.includes(text));
  assert.ok(!source.includes('派单会话 3')); assert.ok(!source.includes('派单会话 4'));
  const single = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches([runs[0]], now), title: dispatcherTitle([runs[0]], titles),
    dispatchers: dispatcherSessions([runs[0]], titles), model: null, now,
  }));
  assert.ok(single.includes('title="派单会话 0">派单会话 0</p>'));
});

await t('工具组连线结束十分钟前/正好/之后变灰，卡片仍显示三十分钟；运行中始终 flow', () => {
  for (const age of [FINISHED_WIRE_MS - 1, FINISHED_WIRE_MS, FINISHED_WIRE_MS + 1]) {
    const g = groupDispatches([run({ status: 'OK', endedAt: iso(now - age) })], now)[0];
    assert.equal(g.runs.length, 1);
    assert.equal(g.wireState, age <= FINISHED_WIRE_MS ? 'finish' : 'idle');
  }
  const inferred = run({ status: 'OK', endedAt: null, startedAt: iso(now - FINISHED_WIRE_MS - 1001), elapsedS: 1 });
  assert.equal(groupDispatches([inferred], now)[0].wireState, 'idle');
  const lost = run({ status: 'lost', startedAt: null });
  assert.equal(groupDispatches([lost], now, new Map([[lost.runId, now - FINISHED_WIRE_MS]]))[0].wireState, 'finish');
  assert.equal(groupDispatches([lost], now, new Map([[lost.runId, now - FINISHED_WIRE_MS - 1]]))[0].wireState, 'idle');
  assert.equal(groupDispatches([inferred, run({ startedAt: iso(now - 86400000) })], now)[0].wireState, 'flow');
  assert.equal(groupDispatches([inferred, run({ status: 'OK', endedAt: iso(now - 1) })], now)[0].wireState, 'finish');
});

await t('子 agent 连线按自身 lastActivityAt，十分钟后变灰；运行中和未知日期处理独立', () => {
  const agent = { threadId: 'child', nickname: 'child', role: 'sol', depth: 1, parentThreadId: 'parent',
    status: 'finished', startedAt: iso(now), lastActivityAt: iso(now - FINISHED_WIRE_MS) };
  assert.equal(subagentWireState(agent, now - 1), 'finish');
  assert.equal(subagentWireState(agent, now), 'finish');
  assert.equal(subagentWireState(agent, now + 1), 'idle');
  assert.equal(subagentWireState({ ...agent, status: 'running', lastActivityAt: iso(now - 86400000) }, now), 'flow');
  assert.equal(subagentWireState({ ...agent, lastActivityAt: 'bad' }, now), 'idle');
  assert.equal(subagentWireState({ ...agent, status: 'unknown' }, now), 'idle');
  const html = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches([run({ subagents: [agent] })], now + 1), title: '派单人', model: null, now: now + 1,
  }));
  assert.ok(html.includes('dispatch-subagent-wire idle'));
  assert.ok(html.includes('已完成')); assert.ok(html.includes('dispatch-wire flow'));
});

await t('Windows 目录比较三家历史与工作台时间，历史更新者胜出；历史失败回落', async () => {
  const local = [{ cwd: '/mnt/c/Users/local', lastActivityAt: iso(now - 1000) }];
  for (const agent of ['claude', 'codex', 'kimi']) {
    const history = { agent, cwd: `/mnt/d/${agent}`, lastActivityAt: iso(now), title: agent };
    globalThis.fetch = async url => {
      assert.equal(url, '/api/history?q=%2Fmnt%2F&limit=1');
      return { json: async () => ({ code: 0, data: { sessions: [history] } }) };
    };
    assert.equal(lastWindowsCwd(local, await loadWindowsHistory()), history.cwd);
    assert.equal(lastWindowsCwd([{ ...local[0], lastActivityAt: iso(now + 1) }], [history]), local[0].cwd);
  }
  globalThis.fetch = async () => { throw new Error('历史接口失败'); };
  assert.equal(lastWindowsCwd(local, await loadWindowsHistory()), local[0].cwd);
  assert.equal(lastWindowsCwd([], await loadWindowsHistory()), '/mnt/c/Users');
  assert.equal(lastWindowsCwd([{ cwd: '/home/repo', lastActivityAt: iso(now) }]), '/mnt/c/Users');
  assert.equal(lastWindowsCwd([{ cwd: '/mnt/c/Users', lastActivityAt: iso(now) }], [{ cwd: '/mnt/d/older', lastActivityAt: iso(now - 1) }]), '/mnt/c/Users');
});

await t('历史关键词误匹配 Linux 会话标题时继续最小页；忽略无效时间，不修改输入', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    return { json: async () => ({ code: 0, data: calls === 1
      ? { sessions: [{ cwd: '/home/repo', title: '/mnt/ 的说明', lastActivityAt: iso(now) }], nextCursor: 'next' }
      : { sessions: [{ cwd: '/mnt/d/native', lastActivityAt: iso(now - 1) }] } }) };
  };
  const history = await loadWindowsHistory();
  assert.equal(calls, 2); assert.equal(lastWindowsCwd([], history), '/mnt/d/native');
  const local = [{ cwd: '/mnt/d/current', lastActivityAt: iso(now) }];
  const before = JSON.stringify(local);
  assert.equal(lastWindowsCwd(local, [{ cwd: '/mnt/c/bad-date', lastActivityAt: 'bad' }]), local[0].cwd);
  assert.equal(JSON.stringify(local), before);
});

await t('简要：name 是执行端兜底时用派单首行', () => {
  assert.equal(dispatchName(run({ name: 'codex', promptHead: '# 工单：派单流程图正式版\n\n正文' })), '派单流程图正式版');
  assert.equal(dispatchName(run({ name: '自定义名', promptHead: '# 工单：别的' })), '自定义名');
  assert.equal(dispatchName(run({ name: 'codex', promptHead: null })), 'codex');
});
await t('派单模型优先匹配 nativeSessionId，外部会话用 parent.model，共用模型短名；缺失无占位', () => {
  const parent = { agent: 'claude', sessionId: 'native', model: 'claude-sonnet-4-5', entrypoint: 'cli' };
  assert.equal(dispatcherModel([run({ parent })], [{ id: 'wb', nativeSessionId: 'native', title: '会话', model: 'claude-opus-5-5' }]), 'opus-5.5');
  assert.equal(dispatcherModel([run({ parent })], []), 'sonnet-4.5');
  assert.equal(dispatcherModel([run({ parent: { ...parent, model: null } })], []), null);
  assert.equal(dispatcherModel([run({ parent: { ...parent, agent: 'codex' } })], []), null);
});
await t('只读列表 URL 与现有信封，错误 msg 透传', async () => {
  let url;
  globalThis.fetch = async (input) => { url = input; return { json: async () => ({ code: 0, data: { dispatches: [run()] } }) }; };
  assert.equal((await fetchDispatches()).dispatches.length, 1); assert.equal(url, '/api/dispatches?limit=50');
  globalThis.fetch = async () => ({ json: async () => ({ code: 1, msg: '拒绝访问' }) });
  await assert.rejects(fetchDispatches(), /拒绝访问/);
});
await t('轮询 3 秒、走秒 1 秒；隐藏停、恢复立即取、慢请求不重叠、卸载丢弃迟到结果', async () => {
  let visible = true, change, calls = 0, resolve, signal, ticks = 0, received = 0, errors = [];
  const timers = new Map();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const stop = startDispatchPolling({ visible: () => visible, now: () => now, every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: fn => { change = fn; return () => { change = null; }; } },
    s => { calls++; signal = s; return new Promise(r => { resolve = r; }); }, () => received++, msg => errors.push(msg), () => ticks++);
  assert.equal(calls, 1); assert.deepEqual([...timers.keys()], [3000, 1000]);
  timers.get(1000)(); assert.equal(ticks, 2);
  timers.get(3000)(); assert.equal(calls, 1);
  visible = false; change(); assert.equal(timers.size, 0); assert.ok(signal.aborted);
  resolve({ dispatches: [run()] }); await flush(); assert.equal(received, 0);
  visible = true; change(); assert.equal(calls, 2);
  resolve({ dispatches: [] }); await flush(); assert.equal(received, 1); assert.deepEqual(errors, ['']);
  timers.get(3000)(); assert.equal(calls, 3);
  stop(); assert.equal(timers.size, 0); assert.equal(change, null); assert.ok(signal.aborted);
  resolve({ dispatches: [] }); await flush(); assert.equal(received, 1);
});
await t('加载失败后可重试；初始隐藏零请求', async () => {
  let visible = false, change, calls = 0, error = '', data = 0;
  const timers = new Map();
  const stop = startDispatchPolling({ visible: () => visible, now: () => now, every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: fn => { change = fn; return () => {}; } }, async () => { if (++calls === 1) throw new Error('离线'); return { dispatches: [] }; }, () => data++, msg => { error = msg; }, () => {});
  assert.equal(calls, 0); visible = true; change(); await Promise.resolve(); await Promise.resolve(); assert.equal(error, '离线');
  timers.get(3000)(); await Promise.resolve(); await Promise.resolve(); assert.equal(data, 1); assert.equal(error, ''); stop();
});
await t('面板路由保留会话/历史预览/页面；关闭恢复，主页和旧链接可用', () => {
  const s = new Store(); s.ensureLoaded = async () => {};
  s.navigate('session-a'); s.toggleDispatches();
  assert.equal(s.dispatchesOpen, true); assert.equal(s.currentId, 'session-a');
  assert.equal(window.location.hash, '#/dispatches');
  s.toggleDispatches(); assert.equal(s.currentId, 'session-a'); assert.equal(window.location.hash, '#/session/session-a');
  s.navigateHistory(); s.selectHistory({ title: '预览' }); const preview = s.historySelection;
  s.toggleDispatches(); assert.equal(s.historyOpen, true); assert.equal(s.historySelection, preview);
  s.toggleDispatches(); assert.equal(s.historySelection, preview); assert.equal(s.currentId, 'session-a');
  s.navigatePage('ai-usage'); s.toggleDispatches(); assert.equal(s.currentPageId, 'ai-usage');
  s.toggleDispatches(); assert.equal(s.currentPageId, 'ai-usage');
  s.navigate('session-a');
  for (const hash of ['#/dispatches', '#/dispatches/run-one', '#/dispatches?runs=one,two']) {
    window.location.hash = hash; s.onHashChange();
    assert.equal(s.currentId, 'session-a'); assert.ok(s.dispatchesOpen);
    s.closeDispatches(); assert.equal(window.location.hash, '#/session/session-a');
  }
  s.toggleDispatches(); s.navigatePage('ai-usage'); assert.equal(s.dispatchesOpen, false);
  const fresh = new Store(); window.location.hash = '#/dispatches/run-one'; fresh.onHashChange();
  assert.ok(fresh.dispatchesOpen); assert.equal(fresh.currentId, null);
  fresh.closeDispatches(); assert.equal(window.location.hash, '#/');
});
await t('终端与派单所有打开入口互斥，切详情不关闭面板或丢失会话', () => {
  const s = new Store(); s.ensureLoaded = async () => {};
  s.navigate('parent'); s.setTerminalOpen(true);
  s.toggleDispatches(); assert.ok(s.dispatchesOpen); assert.equal(s.termOpen, false);
  s.navigateDispatches(['one']); assert.equal(s.currentId, 'parent');
  s.setTerminalOpen(true); assert.equal(s.dispatchesOpen, false); assert.ok(s.termOpen);
  assert.equal(window.location.hash, '#/session/parent');
  s.navigateDispatches(['one', 'two']); assert.equal(s.termOpen, false); assert.ok(s.dispatchesOpen);
  s.setTerminalOpen(true); window.location.hash = '#/dispatches/old-link'; s.onHashChange();
  assert.equal(s.termOpen, false); assert.ok(s.dispatchesOpen);
  s.closeDispatches(); assert.equal(s.currentId, 'parent'); assert.equal(s.termOpen, false);
});
await t('派单与主区并列，当前会话仍有输入框；主页仍可打开并关闭', () => {
  store.ensureLoaded = async () => {};
  store.sessions = [{ id: 'parent', agent: 'claude', cwd: '/repo', status: 'idle', createdAt: iso(now), title: '父会话', config: {} }];
  store.navigate('parent'); store.navigateDispatches();
  const html = renderToStaticMarkup(React.createElement(App));
  const main = html.match(/<main class="main">([\s\S]*?)<\/main>/)[1];
  assert.ok(main.includes('composer-box')); assert.ok(main.includes('/repo'));
  assert.ok(!main.includes('派单面板')); assert.ok(html.indexOf('aria-label="派单面板"') > html.indexOf('</main>'));
  assert.ok(html.includes('aria-label="关闭派单面板"')); assert.ok(html.includes('aria-label="调整派单面板宽度"'));
  assert.ok(html.includes('aria-label="派单" aria-pressed="true"'));
  assert.ok(main.includes('aria-label="派单" aria-pressed="true"'));
  const sidebar = html.match(/<aside class="sidebar(?: sidebar-page-open)?">([\s\S]*?)<\/aside>/)[1];
  assert.ok(!sidebar.includes('aria-label="派单"'));
  store.closeDispatches(); const closed = renderToStaticMarkup(React.createElement(App));
  assert.ok(closed.includes('composer-box')); assert.ok(!closed.includes('aria-label="派单面板"'));
  store.navigate(null); store.navigateDispatches(); const home = renderToStaticMarkup(React.createElement(App));
  assert.ok(home.includes('aria-label="派单面板"')); assert.ok(home.includes('新建会话'));
  store.closeDispatches(); assert.equal(store.currentId, null);
  const flow = renderToStaticMarkup(React.createElement(DispatchView));
  assert.equal((flow.match(/dispatch-node dispatch-executor idle/g) || []).length, 3);
  assert.ok(!flow.includes('dispatch-intro')); assert.ok(!flow.includes('谁在接力'));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('dispatch-intro'));
  assert.match(css, /--agent-copilot:\s+light-dark\(#8053C8, #B69AEB\)/);
  assert.match(css, /@container dispatch \(min-width: 720px\)/);
  assert.match(css, /\.dispatch-wire.flow \{ animation: none; stroke-dasharray: none/);
  assert.match(css, /\.app.term-open \.main \{\s*display: none/);
  assert.match(css, /\.workspace.term-open \.term-panel \{[\s\S]*?width: auto !important/);
});
await t('子 agent 两层递归卡片、昵称/档位/状态、动态一行与 Codex 连线；超过四个换行', () => {
  const agent = (threadId, over = {}) => ({ threadId, nickname: threadId, role: 'sol', depth: 1,
    parentThreadId: 'parent', status: 'running', startedAt: iso(now), lastActivityAt: iso(now),
    activity: '正在核对夹具', ...over });
  const subagents = [agent('Carver'), agent('Luna', { role: 'luna', status: 'finished', activity: '已结束不显示的动态' }),
    agent('Unknown', { status: 'unknown' }), ...Array.from({ length: 3 }, (_, i) => agent(`Child${i}`)),
    agent('Nested', { depth: 2, parentThreadId: 'Carver' }),
    agent('TooDeep', { depth: 3, parentThreadId: 'Nested' }), agent('Orphan', { depth: 2, parentThreadId: 'missing' })];
  const groups = groupDispatches([run({ session: 'parent', subagents })], now);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups, title: '派单人', model: null, now }));
  assert.equal((html.match(/class="dispatch-node dispatch-subagent"/g) || []).length, 7);
  assert.equal((html.match(/class="dispatch-subagents"/g) || []).length, 2);
  assert.ok(html.includes('Codex 子 agent 第 1 层')); assert.ok(html.includes('Codex 子 agent 第 2 层'));
  for (const text of ['Carver', 'luna', 'sol', '运行中', '已完成', '未知', '正在核对夹具']) assert.ok(html.includes(text));
  assert.ok(html.includes('data-parent-id="Carver" data-depth="2"'));
  assert.ok(!html.includes('TooDeep')); assert.ok(!html.includes('Orphan')); assert.ok(!html.includes('已结束不显示的动态'));
  assert.equal((html.match(/dispatch-subagent-wire flow/g) || []).length, 5);
  assert.ok(html.includes('dispatch-subagent-wire finish')); assert.ok(html.includes('dispatch-subagent-wire idle'));
  assert.ok(html.includes('--wire-color:var(--agent-codex)'));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dispatch-subagents \{ margin-top: 84px;[^{]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.dispatch-subagent \{[^}]*width: min\(100%, 150px\)/);
  assert.match(css, /\.dispatch-subagents \{ margin-top: 130px/);
  assert.match(css, /\.dispatch-subagent \{[^}]*border-top: 3px solid var\(--agent-codex\)/);
  assert.match(css, /\.dispatch-executors \{ margin: 84px/);
  assert.match(css, /\.dispatch-source \{ width: min\(260px, 72%\); min-height: 112px/);
});
await t('无子 agent 不新增层/连线；空数组和旧列表都保持原来三端布局', () => {
  for (const subagents of [undefined, []]) {
    const groups = groupDispatches([run({ subagents })], now);
    const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups, title: '派单人', model: null, now }));
    assert.ok(!html.includes('dispatch-subagent')); assert.ok(!html.includes('Codex 子 agent'));
    assert.equal((html.match(/class="dispatch-node dispatch-executor/g) || []).length, 3);
    assert.equal((html.match(/class="dispatch-wire /g) || []).length, 3);
  }
});
await t('关闭面板或切到终端后停止列表轮询和走秒，清理在途请求', async () => {
  for (const close of [s => s.closeDispatches(), s => s.setTerminalOpen(true)]) {
    const s = new Store(); s.navigateDispatches();
    const timers = new Map(); let signal, resolve, received = 0, ticks = 0;
    const stop = startDispatchPolling({ visible: () => s.dispatchesOpen, now: () => now,
      every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: () => () => {},
    }, value => { signal = value; return new Promise(done => { resolve = done; }); }, () => received++, () => {}, () => ticks++);
    assert.deepEqual([...timers.keys()], [3000, 1000]);
    close(s); stop(); // App 的条件渲染在关闭/互斥时卸载 DispatchPanel。
    assert.equal(timers.size, 0); assert.ok(signal.aborted);
    const previousTicks = ticks; resolve({ dispatches: [run()] });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(received, 0); assert.equal(ticks, previousTicks);
  }
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('{dispatchesOpen && <DispatchPanel'));
  const detail = readFileSync(new URL('../src/components/DispatchDetail.tsx', import.meta.url), 'utf8');
  const history = readFileSync(new URL('../src/components/DispatchHistory.tsx', import.meta.url), 'utf8');
  assert.ok(detail.includes('request?.abort()')); assert.ok(detail.includes('window.clearInterval(tick)'));
  assert.ok(history.includes('controller.abort()')); assert.ok(history.includes('window.clearInterval(timer)'));
});
if (!process.exitCode) console.log(`✅ dispatch flow 全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
