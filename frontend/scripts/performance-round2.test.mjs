import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHistoryRenderCache, historyRenderItems } from '../src/history-render-cache.ts';
import { buildRenderItems, focusVisible } from '../src/render-items.ts';
import { sessionDispatchInterval, startSessionDispatchPolling } from '../src/dispatch-polling.ts';

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: '#/' }, addEventListener() {} };
const { Store, store } = await import('../src/store.ts');
const { HistoryTimeline } = await import('../src/components/HistoryTimeline.tsx');
const { ResumedHistory } = await import('../src/components/ResumedHistory.tsx');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

assert.equal(sessionDispatchInterval(0, 0), 30000);
assert.equal(sessionDispatchInterval(1, 0), 3000);
assert.equal(sessionDispatchInterval(0, 1), 3000);
let visible = true, visibility, requests = 0, links = [], background = 0, delivered = 0;
const timers = new Map();
const stop = startSessionDispatchPolling({
  visible: () => visible, now: Date.now,
  every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: (id) => timers.delete(id),
  onVisibility: (fn) => { visibility = fn; return () => { visibility = null; }; },
}, async () => { requests++; return { dispatches: links }; }, () => delivered++, () => background);
await flush();
assert.equal(requests, 1); assert.deepEqual([...timers.keys()], [30000]);
links = [{ runId: 'one' }]; timers.get(30000)(); await flush();
assert.deepEqual([...timers.keys()], [3000]);
links = []; timers.get(3000)(); await flush(); assert.deepEqual([...timers.keys()], [30000]);
background = 1; visibility(); await flush(); assert.deepEqual([...timers.keys()], [3000]);
visible = false; visibility(); assert.equal(timers.size, 0);
const beforeVisible = requests; visible = true; visibility(); await flush(); assert.equal(requests, beforeVisible + 1);
stop(); assert.equal(timers.size, 0); assert.equal(visibility, null);
let slowResolve, slowSignal, slowReceived = 0;
const slowTimers = new Map();
const stopSlow = startSessionDispatchPolling({ visible: () => true, now: Date.now,
  every: (fn, ms) => { slowTimers.set(ms, fn); return ms; }, cancel: (id) => slowTimers.delete(id), onVisibility: () => () => {},
}, (signal) => { slowSignal = signal; return new Promise((resolve) => { slowResolve = resolve; }); }, () => slowReceived++, () => 0);
stopSlow(); assert.equal(slowSignal.aborted, true);
slowResolve({ dispatches: [] }); await flush(); assert.equal(slowReceived, 0);

let builds = 0;
const cached = createHistoryRenderCache((messages) => { builds++; return messages; });
const history = [{ role: 'assistant', text: '**answer**', timestamp: null },
  { role: 'tool', timestamp: null, tool: { id: 't', name: 'Shell', input: { command: 'pwd' }, status: 'unknown' } }];
const initial = cached(history, 'claude', '/tmp');
assert.equal(cached(history, 'claude', '/tmp'), initial); assert.equal(builds, 1);
cached(history, 'kimi', '/tmp'); assert.equal(builds, 2);
cached(history, 'kimi', '/other'); assert.equal(builds, 3);
const appended = [...history, { role: 'assistant', text: 'more', timestamp: null }];
cached(appended, 'kimi', '/other'); assert.equal(builds, 4);
const replaced = [history[0], { ...history[1], tool: { ...history[1].tool, result: 'NEW_TOOL_RESULT', status: 'ok' } }];
cached(replaced, 'kimi', '/other'); assert.equal(builds, 5);
const external = { type: 'external_messages_added', seq: 1, payload: { messages: history } };
const a = buildRenderItems([external], 'claude')[0];
const b = buildRenderItems([external, { type: 'agent_text_delta', seq: 2, payload: { text: 'live' } }], 'claude')[0];
assert.equal(a.messages, b.messages, '实时内容更新保持历史消息引用');
const c = buildRenderItems([{ ...external, payload: { messages: replaced } }], 'claude')[0];
assert.notEqual(c.messages, a.messages); assert.equal(c.messages[1].tool.result, 'NEW_TOOL_RESULT');
const props = { session: { cwd: '/tmp', resumedFrom: { agent: 'claude', nativeSessionId: 'native', historyCursor: 'cursor' } }, streamRef: {} };
assert.equal(ResumedHistory.compare(props, { ...props, session: { ...props.session, seq: 100 } }), true);
assert.equal(ResumedHistory.compare(props, { ...props, session: { ...props.session, resumedFrom: { ...props.session.resumedFrom, historyCursor: 'new' } } }), false);
store.focusView = false;
const full = renderToStaticMarkup(React.createElement(HistoryTimeline, { messages: replaced, agent: 'claude', cwd: '/tmp' }));
assert.equal(historyRenderItems(replaced, 'claude', '/tmp')[1].result, 'NEW_TOOL_RESULT');
assert.match(full, /tool-card tool-ok/); assert.match(full, /<strong>answer<\/strong>/);
store.focusView = true;
const focused = renderToStaticMarkup(React.createElement(HistoryTimeline, { messages: replaced, agent: 'claude', cwd: '/tmp' }));
assert.doesNotMatch(focused, /tool-card/); assert.match(focused, /<strong>answer<\/strong>/);
store.focusView = false;

let rafId = 0, notifications = 0;
const frames = new Map();
globalThis.requestAnimationFrame = (fn) => { frames.set(++rafId, fn); return rafId; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const s = new Store();
const session = { id: 's', agent: 'codex', config: {}, status: 'idle', cwd: '/tmp' };
s.applySnapshot('s', session, 0, []);
s.subscribe(() => notifications++);
const event = (seq, type, payload = {}) => ({ sessionId: 's', agentId: 'main', seq, type, payload, timestamp: new Date().toISOString() });
for (let seq = 1; seq <= 100; seq++) s.handleEvent(event(seq, seq % 2 ? 'tool_call_updated' : 'raw_event', { toolCallId: 't', output: String(seq) }));
assert.equal(notifications, 0); assert.equal(frames.size, 1);
assert.equal(s.data.get('s').seq, 100); assert.equal(s.data.get('s').events.length, 100);
const callback = [...frames.values()][0]; frames.clear(); callback(); assert.equal(notifications, 1);
s.handleEvent(event(101, 'raw_event')); assert.equal(frames.size, 1);
s.handleEvent(event(102, 'tool_call_completed')); assert.equal(notifications, 2); assert.equal(frames.size, 0);
s.handleEvent(event(103, 'tool_call_updated'));
s.handleEvent(event(104, 'permission_request', { requestId: 'gate' })); assert.equal(notifications, 3); assert.equal(frames.size, 0);
s.handleEvent(event(105, 'raw_event')); s.handleEvent(event(106, 'session_error', { message: 'fixture' }));
assert.equal(notifications, 4); assert.equal(frames.size, 0);
assert.equal(s.data.get('s').seq, 106);
s.handleEvent(event(107, 'config_updated', { config: { model: 'sonnet', effort: 'low' },
  effectiveModel: 'sonnet', effectiveEffort: 'low', effectiveModelSource: 'session', effectiveEffortSource: 'session', workerRestarted: false }));
assert.equal(s.session('s').effectiveModel, 'sonnet');
assert.equal(s.session('s').effectiveEffort, 'low');
assert.equal(s.data.get('s').seq, 107); assert.equal(notifications, 5); assert.equal(frames.size, 0);
s.applySnapshot('s', session, 9, [event(1, 'user_message'), event(5, 'permission_request', { requestId: 'restore-gate' }), event(9, 'turn_completed')]);
assert.equal(s.data.get('s').seq, 9, '迁移后有缺号的快照采用服务端 seq');
assert.equal(s.data.get('s').pendingGates.has('restore-gate'), true);
s.handleEvent(event(10, 'permission_resolved', { requestId: 'restore-gate' }));
assert.equal(s.data.get('s').seq, 10); assert.equal(s.data.get('s').pendingGates.size, 0);
console.log('✅ round2 frontend: polling backoff/visibility, history references/cache/tool replacement/focus, progress batching and gapped snapshot gates');
process.exit(0);
