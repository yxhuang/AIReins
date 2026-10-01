#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { groupDispatches, dispatchName, dispatchSeconds, dispatchTime, dispatchStatus, dispatcherTitle, dispatcherModel, RECENT_DISPATCH_MS } from '../src/dispatch-flow.ts';
import { startDispatchPolling } from '../src/dispatch-polling.ts';
import { fetchDispatches } from '../src/api.ts';

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: '#/' }, addEventListener() {} };
const { Store, store } = await import('../src/store.ts');
const { App } = await import('../src/App.tsx');
const { DispatchView } = await import('../src/components/DispatchView.tsx');
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
  assert.deepEqual(groups.map(g => g.wireState), ['flow', 'finish', 'idle']);
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
  assert.equal(dispatcherTitle([by('native'), by('other')], titles), '2 个会话在派单');
  assert.equal(dispatcherTitle([by('native', 'codex')], titles), 'Claude Code 会话');
  assert.equal(dispatcherTitle([run({ session: 'native' })], titles), 'Claude Code 会话');
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
await t('派单 toggle 恢复主区会话/历史预览/页面；手机返回侧栏，路由离开清除选中态', () => {
  const s = new Store(); s.ensureLoaded = async () => {};
  s.navigate('session-a'); s.toggleDispatches(); assert.equal(s.dispatchesOpen, true); assert.equal(window.location.hash, '#/dispatches');
  s.toggleDispatches(); assert.equal(s.currentId, 'session-a'); assert.equal(window.location.hash, '#/session/session-a');
  s.navigateHistory(); s.selectHistory({ title: '预览' }); const preview = s.historySelection;
  s.toggleDispatches(); assert.equal(s.historyOpen, false); s.toggleDispatches(); assert.equal(s.historySelection, preview); assert.equal(s.currentId, 'session-a');
  s.navigatePage('ai-usage'); s.toggleDispatches(); s.toggleDispatches(); assert.equal(s.currentPageId, 'ai-usage');
  s.navigate('session-a'); s.toggleDispatches(); s.closeDispatches(true); assert.equal(s.currentId, null); assert.equal(s.dispatchesOpen, false);
  s.navigateHistory(); s.selectHistory({ title: '预览' }); s.toggleDispatches(); s.closeDispatches(true); assert.equal(s.historyOpen, true); assert.equal(s.historySelection, null);
  s.toggleDispatches(); s.navigatePage('ai-usage'); assert.equal(s.dispatchesOpen, false);
  const fresh = new Store(); window.location.hash = '#/dispatches'; fresh.onHashChange(); assert.ok(fresh.dispatchesOpen); fresh.toggleDispatches(); assert.equal(window.location.hash, '#/');
});
await t('派单在主区，三个执行端常驻、入口顺序/选中态和手机返回；无详情原文或操控', () => {
  store.toggleDispatches();
  const html = renderToStaticMarkup(React.createElement(App));
  const main = html.match(/<main class="main">([\s\S]*?)<\/main>/)[1];
  assert.ok(html.includes('class="app has-main"')); assert.ok(main.includes('aria-label="派单流程图"'));
  const flow = renderToStaticMarkup(React.createElement(DispatchView));
  assert.equal((flow.match(/dispatch-node dispatch-executor idle/g) || []).length, 3);
  assert.ok(main.includes('‹ 返回侧栏')); assert.ok(html.includes('aria-label="派单" aria-pressed="true"'));
  assert.ok(html.indexOf('aria-label="派单"') < html.indexOf('aria-label="所有来源会话"'));
  assert.ok(!main.includes('summary')); assert.ok(!main.includes('重派'));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--agent-copilot:\s+light-dark\(#8053C8, #B69AEB\)/);
  assert.match(css, /@container dispatch \(min-width: 720px\)/);
  assert.match(css, /\.dispatch-wire.flow \{ animation: none; stroke-dasharray: none/);
});
if (!process.exitCode) console.log(`✅ dispatch flow 全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
