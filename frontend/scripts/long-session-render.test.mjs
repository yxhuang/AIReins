import assert from 'node:assert/strict';
import { buildRenderItems, createRenderItemsBuilder, groupReadOnlyTools, focusVisible } from '../src/render-items.ts';
const ev = (seq, type, payload = {}) => ({ seq, type, payload, sessionId: 's', agentId: 'a', timestamp: '2026-10-05T00:00:00Z' });
let random = 93251;
const rng = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
for (const agent of ['codex', 'claude', 'kimi']) {
  const builder = createRenderItemsBuilder(agent);
  let events = [], dropped = 0;
  const types = ['agent_text_delta', 'thought_delta', 'user_message', 'turn_completed', 'tool_call_started', 'tool_call_updated', 'tool_call_completed', 'permission_request', 'permission_resolved', 'raw_event', 'usage_updated'];
  for (let i = 1; i <= 650; i++) {
    const type = types[rng(types.length)];
    const payload = { text: i % 83 === 0 ? '界 **text**\n'.repeat(6000) : `delta ${i}`, toolCallId: `t${rng(6)}`, requestId: `g${rng(4)}`, toolName: 'Read', input: { path: 'a' }, result: { aggregatedOutput: 'output delta' }, source: agent, method: 'item/commandExecution/outputDelta', params: { itemId: 't1', delta: 'delta' }, raw: { type: 'user', message: { content: 'delta 1' } } };
    events.push(ev(i, type, payload));
    if (i % 53 === 0) events.push(ev(i, 'agent_text_delta', { text: 'duplicate' }));
    if (i % 71 === 0) events.push(ev(i - 3, 'thought_delta', { text: 'out of order' }));
    if (i % 97 === 0) events = events.map(e => ({ ...e, payload: { ...e.payload } })); // same seq resync
    if (i % 113 === 0) { events = events.slice(-60); dropped++; }
    const full = buildRenderItems(events, agent);
    assert.deepEqual(builder.update(events, dropped), full, `${agent} step ${i}`);
    const focus = i % 43 < 21;
    assert.deepEqual(builder.display(focus, '/tmp'), groupReadOnlyTools(full, agent, '/tmp').filter(item => !focus || focusVisible(item)), `${agent} display ${i}`);
  }
}
const events = [ev(1, 'agent_text_delta', { text: 'a' })];
const builder = createRenderItemsBuilder('codex');
const first = builder.update(events, 0)[0];
events.push(ev(2, 'agent_text_delta', { text: 'b' }));
const second = builder.update(events, 0)[0];
assert.notEqual(first, second);
assert.equal(first.text, 'a');
assert.equal(second.text, 'ab');
assert.deepEqual(builder.update([ev(1, 'agent_text_delta', { text: 'replaced' }), ev(2, 'agent_text_delta', { text: 'window' })], 0), buildRenderItems([ev(1, 'agent_text_delta', { text: 'replaced' }), ev(2, 'agent_text_delta', { text: 'window' })], 'codex'));
console.log('✅ long-session incremental render equivalence and item identity');
const { createStreamingTextThrottle } = await import('../src/streaming-text.ts');
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
let tick, delay, cancels = 0;
globalThis.setTimeout = (fn, ms) => { assert.equal(tick, undefined); tick = fn; delay = ms; return 1; };
globalThis.clearTimeout = () => { tick = undefined; cancels++; };
try {
  const published = [];
  const throttle = createStreamingTextThrottle(text => published.push(text));
  const large = '## Head\n\n**bold**\n\n```js\nconst x = 1;\n```\n'.repeat(1400);
  for (let i = 0; i < 1000; i++) throttle.update(large + i, true);
  assert.equal(delay, 100);
  assert.deepEqual(published, []);
  const fire = tick; tick = undefined; fire();
  assert.deepEqual(published, [large + 999]);
  throttle.update(large + 'pending', true);
  throttle.update(large + 'final', false);
  assert.equal(published.at(-1), large + 'final');
  assert.equal(tick, undefined);
  throttle.update('unmount', true); throttle.cancel();
  assert.equal(tick, undefined); assert.equal(cancels, 2);
} finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
console.log('✅ 100ms streaming throttle, immediate final text and timer cancellation');

const identityBuilder = createRenderItemsBuilder('claude');
const identityEvents = [ev(1, 'tool_call_started', { toolCallId: 't', toolName: 'Read' }), ev(2, 'permission_request', { requestId: 'g' })];
const oldItems = [...identityBuilder.update(identityEvents)];
identityEvents.push(ev(3, 'tool_call_updated', { toolCallId: 't', input: { path: 'updated' } }), ev(4, 'permission_resolved', { requestId: 'g', decision: 'allow' }));
const updatedItems = identityBuilder.update(identityEvents);
assert.notEqual(oldItems[0], updatedItems[0]); assert.notEqual(oldItems[1], updatedItems[1]);
assert.equal(oldItems[0].input, ''); assert.equal(oldItems[1].decision, undefined);
assert.equal(updatedItems[1].decision, 'allow');

const React = await import('react');
globalThis.React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: Markdown } = await import('react-markdown');
const { default: remarkGfm } = await import('remark-gfm');
const { MarkdownMessage } = await import('../src/components/MarkdownMessage.tsx');
const finalText = '# Finished\n\n' + '**bold** and ~~deleted~~\n\n'.repeat(2500);
const expectedHtml = '<div class="markdown-message">' + renderToStaticMarkup(React.createElement(Markdown, { skipHtml: true, remarkPlugins: [remarkGfm] }, finalText)) + '</div>';
assert.equal(renderToStaticMarkup(React.createElement(MarkdownMessage, { text: finalText, streaming: false })), expectedHtml);
console.log('✅ updated tool/gate object identity and final >50KB Markdown matches full parsing');
