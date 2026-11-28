import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: '#/' }, addEventListener() {} };
const { Store } = await import('../src/store.ts');
const { DispatchDetailHeader, dispatchProcessMessages } = await import('../src/components/DispatchDetail.tsx');
const renderCloud = (externalUrl, acceptResult = null) => renderToStaticMarkup(React.createElement(DispatchDetailHeader, {
  detail: { runId: '20261001-100000-muse-cloud-task', tool: 'muse', name: '云端任务', status: 'DISPATCHED',
    model: null, effort: null, elapsedS: 10, parent: null, credits: null, externalUrl, acceptResult },
  sessions: [], now: Date.parse('2026-10-01T10:01:00Z'),
}));
for (const url of ['https://example.com/run', 'http://example.com/run']) {
  const html = renderCloud(url);
  assert.ok(html.includes(`<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">打开云端页面</a>`));
  assert.match(html, /class="dispatch-badge finished">[^<]*已派发<\/span>/);
  assert.doesNotMatch(html, /验收/);
}
assert.match(renderCloud(null, 'OK ← test'), /验收 OK/);
for (const url of ['javascript:alert(1)', 'file:///tmp/run', 'https://', 'https:///example.com', '//example.com',
  'https://exa\tmple.com/', 'https://example.com/a b', 42, null, undefined]) {
  assert.doesNotMatch(renderCloud(url), /打开云端页面|href=/);
}
const user = (text) => ({ role: 'user', text, timestamp: null });
const tool = { role: 'tool', timestamp: null, tool: { id: 'call', name: 'exec_command', input: {}, status: 'ok' } };
const repeated = user('  派单原文\n');
const followup = user('继续检查');
const messages = [repeated, tool, followup, repeated];
assert.deepEqual(dispatchProcessMessages(messages, '\n派单原文  '), [], 'use the last matching prompt even when no new process has arrived');
assert.equal(messages.length, 4, 'filter must preserve raw message positions for polling deltas');
const prompt = '甲'.repeat(200) + '乙';
assert.deepEqual(dispatchProcessMessages([user('甲'.repeat(200) + '原生补充'), tool], prompt), [tool], 'first 200 characters can match a native prompt suffix');
const unrelated = [followup, repeated, tool];
assert.deepEqual(dispatchProcessMessages(unrelated, '派单原文'), [tool], 'discard messages before a later matching dispatch prompt');
const unmatched = [user('别的工单'), tool, followup];
assert.equal(dispatchProcessMessages(unmatched, '派单原文'), unmatched, 'keep the existing process when no prompt matches');
assert.equal(dispatchProcessMessages(messages, '  '), messages, 'empty prompts cannot match every message');
assert.equal(dispatchProcessMessages(messages, null), messages);
assert.deepEqual(dispatchProcessMessages([tool, repeated, followup], '派单原文'), [followup], 'discard tools before the dispatch prompt');
const answer = { role: 'assistant', text: '本轮完成', timestamp: null };
const resumed = [user('上一轮工单'), tool, answer, repeated, tool, answer, followup];
assert.deepEqual(dispatchProcessMessages(resumed, '派单原文'), [tool, answer, followup], 'resume shows only this dispatch process and retains later user messages');
assert.equal(resumed.length, 7, 'resume filtering leaves the native snapshot intact');
const s = new Store();
s.ensureLoaded = async () => {};
s.navigate('parent');
s.navigateDispatches(['run-one']);
assert.equal(window.location.hash, '#/dispatches/run-one');
assert.equal(s.dispatchesOpen, true);
s.navigateDispatches();
assert.equal(window.location.hash, '#/dispatches');
s.closeDispatches();
assert.equal(window.location.hash, '#/session/parent', 'detail -> list -> close restores original conversation');
s.navigateDispatches(['run-one', 'run-two']);
assert.equal(window.location.hash, '#/dispatches?runs=run-one,run-two');
assert.equal(s.dispatchesOpen, true);
s.navigateDispatches(['run-one'], false);
assert.equal(window.location.hash, '#/dispatches?runs=run-one', 'session entry with one run highlights it on the flow, not its detail');
s.navigateDispatches(['run-two']);
assert.equal(s.dispatchesOpen, true);
s.navigate('another');
assert.equal(s.dispatchesOpen, false);
console.log('✅ dispatch detail cloud links, prompt filtering, routes, multi-run highlight and return navigation');
