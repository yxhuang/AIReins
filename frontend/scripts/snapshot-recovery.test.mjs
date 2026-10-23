import assert from "node:assert/strict";
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
const { Store } = await import("../src/store.ts");
const record = { id: "fixture", agent: "codex", agentId: "main", cwd: "/tmp", status: "running", config: {}, riskyMode: false,
  createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z", seq: 1, transcriptPath: "/tmp/fixture.ndjson" };
const event = (seq, type = "agent_text_delta") => ({ type, seq, sessionId: record.id, agentId: "main", timestamp: record.lastActivityAt, payload: { text: String(seq) } });
const envelope = data => ({ json: async () => ({ code: 0, msg: "", data, request_id: "fixture" }) });
function setup(loaded = true) {
  const s = new Store(); s.sessions = [{ ...record }];
  if (loaded) s.applySnapshot(record.id, { ...record }, 1, [event(1)]);
  const requests = [];
  globalThis.fetch = async path => {
    if (String(path).includes("/snapshot")) return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    if (String(path).endsWith("/commands")) return envelope({ commands: [] });
    if (String(path) === "/api/sessions") return envelope({ sessions: [{ ...record, status: "idle", seq: 3 }] });
    throw new Error(`Unexpected URL: ${path}`);
  };
  return { s, requests };
}
{
  const { s, requests } = setup();
  const pending = s.resync(record.id);
  s.handleEvent(event(2)); s.handleEvent(event(3, "turn_completed"));
  requests[0].reject(new Error("snapshot timeout")); await pending;
  assert.equal(s.data.get(record.id).seq, 3, "failed snapshot must not strand contiguous live events");
  assert.notEqual(s.listRefreshTimer, undefined, "drained turn completion must schedule authoritative status refresh");
  await s.refreshSessions();
  assert.equal(s.session(record.id).status, "idle");
  assert.equal(s.snapshotBuffers.has(record.id), false);
  assert.equal(s.snapshotErrors.get(record.id), "snapshot timeout");
}
{
  const { s, requests } = setup();
  const pending = s.resync(record.id); s.handleEvent(event(3, "turn_completed"));
  requests[0].reject(new Error("gap timeout")); await pending;
  assert.equal(s.data.get(record.id).seq, 1, "a missing event must not be guessed");
  assert.equal(s.snapshotBuffers.get(record.id).length, 1);
  const retry = s.resync(record.id);
  requests[1].resolve(envelope({ session: { ...record, status: "idle", seq: 3 }, seq: 3, events: [event(1), event(2), event(3, "turn_completed")] }));
  await retry;
  assert.equal(s.data.get(record.id).seq, 3);
  assert.equal(s.snapshotErrors.has(record.id), false);
  assert.equal(s.snapshotBuffers.has(record.id), false);
}
{
  const { s, requests } = setup(false);
  const pending = s.ensureLoaded(record.id);
  requests[0].reject(new Error("first load failed")); await pending;
  assert.equal(s.data.has(record.id), false);
  assert.equal(s.snapshotErrors.get(record.id), "first load failed", "first-load failure must have a retryable error");
  const retry = s.resync(record.id);
  requests[1].resolve(envelope({ session: record, seq: 1, events: [event(1)] })); await retry;
  assert.equal(s.snapshotErrors.has(record.id), false);
  assert.equal(s.data.get(record.id).seq, 1);
}
{
  const { s, requests } = setup();
  const old = s.resync(record.id), fresh = s.resync(record.id);
  requests[1].resolve(envelope({ session: record, seq: 1, events: [event(1)] })); await fresh;
  requests[0].reject(new Error("stale failure")); await old;
  assert.equal(s.snapshotErrors.has(record.id), false, "a stale request must not set the new generation's error");
}
{
  const { s, requests } = setup();
  s.currentId = "current";
  for (const id of [record.id, "a", "b", "c", "current"]) {
    s.cachedSessions.set(id, true);
    if (id !== record.id) s.applySnapshot(id, { ...record, id }, 1, [{ ...event(1), sessionId: id }]);
  }
  s.configPending.set(record.id, new Set(["model"]));
  const pending = s.resync(record.id);
  s.handleEvent({ ...event(2, "config_updated"), payload: { config: {} } });
  s.handleEvent(event(3));
  requests[0].reject(new Error("eviction during recovery"));
  await pending;
  assert.equal(s.data.has(record.id), false, "settled config lets the oldest noncurrent cache be evicted");
  assert.equal(s.session(record.id).seq, 3, "events after eviction still update the unloaded summary");
  assert.equal(s.snapshotBuffers.has(record.id), false);
}
console.log("PASS: snapshot failure drains contiguous events, preserves gaps and supports first-load/generation-safe retry");
process.exit(0);
