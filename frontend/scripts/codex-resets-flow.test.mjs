import assert from 'node:assert/strict';
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
const { Store } = await import('../src/store.ts');
const baseline = { enabled: true, lastSuccessAt: null, stale: false, monitor: { status: 'healthy' }, pending: [], recent: [], alerts: [] };
const unread = { ...baseline, alerts: [{ id: 'post-1', action: 'announce', events: [], context: [] }] };
const envelope = data => ({ json: async () => ({ code: 0, msg: '', data }) });
const store = new Store();
let resolve;
globalThis.fetch = () => new Promise(r => { resolve = r; });
const loading = store.refreshCodexResets();
store.handleFrame({ type: 'codex_resets_updated', data: unread });
resolve(envelope(baseline));
await loading;
assert.equal(store.codexResets.alerts[0].id, 'post-1', '旧 GET 不覆盖较新 WS 提醒');

const second = new Store();
second.handleFrame({ type: 'codex_resets_updated', data: unread });
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push([url, init]);
  if (url.endsWith('/ack')) {
    assert.deepEqual(JSON.parse(init.body), { id: 'post-1' });
    store.handleFrame({ type: 'codex_resets_updated', data: baseline });
    second.handleFrame({ type: 'codex_resets_updated', data: baseline });
  }
  return envelope(baseline);
};
await store.ackCodexReset('post-1');
assert.equal(store.codexResets.alerts.length, 0);
assert.equal(second.codexResets.alerts.length, 0, '全局 ack 帧同步第二端');
assert.equal(requests[0][0], '/api/codex-resets/ack');

globalThis.fetch = async (url, init) => {
  if (url.endsWith('/ack')) assert.deepEqual(JSON.parse(init.body), { id: 'post-1', provider: 'antigravity' });
  return envelope(baseline);
};
await store.ackCodexReset('post-1', 'antigravity');

store.handleFrame({ type: 'codex_resets_updated', data: unread });
globalThis.fetch = async () => { throw new Error('offline'); };
await assert.rejects(store.ackCodexReset('post-1'), /offline/);
assert.equal(store.codexResets.alerts.length, 1, 'ack 失败保留未读');
await store.refreshCodexResets();
assert.equal(store.codexResets.alerts.length, 1, '离线刷新保留快照');
store.handleFrame({ type: 'codex_resets_updated', data: { ...baseline, enabled: false } });
assert.equal(store.codexResets.enabled, false);
console.log('✅ codex reset store: fresh WS, cross-client ack, failure recovery, disable');

const { staleText } = await import('../src/components/CodexResets.tsx');
const now = Date.parse('2026-10-17T08:00:00Z'), fresh = '2026-10-17T07:55:00Z';
assert.match(staleText({ ...baseline, lastSuccessAt: '2026-10-17T06:30:00Z' }, now), /超过 1 小时未能从 AIHOT 更新/, '本机失败优先');
assert.equal(staleText({ ...baseline, lastSuccessAt: fresh, monitor: { status: 'attention', lastVerifiedAt: '2026-10-17T05:00:00Z' } }, now), 'AIHOT 监控需要处理，最近完整检查 3小时前，信息可能不全。');
assert.match(staleText({ ...baseline, lastSuccessAt: fresh }, now), /AIHOT 报告服务异常/, 'healthy 时只剩 outage');

const React = await import('react');
globalThis.React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { store: appStore } = await import('../src/store.ts');
const { CodexResetCard, hasResetUpdate } = await import('../src/components/CodexResets.tsx');
const announced = {
  id: 'old-window', type: 'direct_reset', status: 'announced', posts: [],
  schedule: { from: '2026-10-24T12:00:00+08:00', through: '2026-10-24T14:00:00+08:00', label: '10月24日 12:00–14:00' },
};
const confirmed = { id: 'confirmed-reset', type: 'direct_reset', status: 'confirmed', posts: [], confirmedAt: '2026-10-25T06:00:00+08:00' };
const state = { ...baseline, lastSuccessAt: fresh, pending: [announced], recent: [announced, confirmed] };
appStore.codexResets = state;
const renderCard = () => renderToStaticMarkup(React.createElement(CodexResetCard));

appStore.now = Date.parse('2026-10-25T08:00:00+08:00');
let card = renderCard();
assert.match(card, /aria-expanded="false"/, '只剩历史时默认折叠');
assert.match(card, /class="codex-reset-details" hidden=""/);
assert.match(card, /2小时前/, '手动展开时以确认时间为准');

appStore.now = Date.parse('2026-10-24T11:00:00+08:00');
assert.match(renderCard(), /aria-expanded="true"/, '有有效预告时自动展开');
assert.match(renderCard(), /10月24日 12:00–14:00/);
appStore.now = Date.parse(announced.schedule.through);
assert.match(renderCard(), /aria-expanded="false"/, '到窗口结束时自动折叠');

const point = { ...announced, id: 'point', schedule: { from: '2026-10-25T10:00:00+08:00', label: '单点重置时间' } };
const later = { ...point, id: 'later', schedule: { from: '2026-10-25T11:00:00+08:00', label: '下一次重置时间' } };
appStore.now = Date.parse('2026-10-25T09:00:00+08:00');
appStore.codexResets = { ...state, pending: [announced, point, later] };
card = renderCard();
assert.match(card, /下一次重置时间/);
assert.doesNotMatch(card, /单点重置时间/, '多条有效预告只展示最晚一次');

appStore.codexResets = { ...baseline, sources: [
  { provider: 'antigravity', status: { ...state, pending: [later] } },
  { provider: 'claude', status: baseline },
  { provider: 'grok-bot', status: baseline },
] };
appStore.now = Date.parse(point.schedule.from);
card = renderCard();
assert.match(card, /aria-expanded="true"/);
assert.match(card, /role="radio" aria-label="Antigravity" aria-checked="true"/);
assert.match(card, /role="radio" aria-label="Grok Bot" aria-checked="false"/);
assert.match(card, /class="agent-icon agent-grok-bot"/);
assert.match(card, /https:\/\/aihot.news\/antigravity-reset/);
assert.match(card, /下一次重置时间/);
assert.ok(hasResetUpdate(appStore.codexResets, appStore.now));
appStore.now = Date.parse(later.schedule.from);
assert.ok(!hasResetUpdate(appStore.codexResets, appStore.now));
card = renderCard();
assert.match(card, /aria-expanded="false"/);
assert.equal((card.match(/role="radio"/g) ?? []).length, 4, '公告收起时四个来源仍可选择');
appStore.codexResets = { ...baseline, sources: [{ provider: 'antigravity', status: { ...baseline, alerts: [
  { id: 'antigravity-confirmed', action: 'confirm', events: [confirmed], context: [] },
] } }] };
assert.match(renderCard(), /class="codex-reset-summary">已确认/);
assert.ok(hasResetUpdate(appStore.codexResets, appStore.now));
console.log('✅ quota reset panel: collapsed history, active announcements, clock cutoff and source selection');
