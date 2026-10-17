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
