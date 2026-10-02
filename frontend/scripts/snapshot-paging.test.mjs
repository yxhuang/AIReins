import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.ts";
import { fetchSnapshot } from "../src/api.ts";
import { buildRenderItems, groupReadOnlyTools, promptCacheExpiry } from "../src/render-items.ts";
import { selectEventPage, snapshotState } from "../../server/event-pages.ts";

const id = "paging";
const events = [];
function add(type, payload = {}) {
  const seq = events.length + 1;
  events.push({ type, payload, seq, sessionId: id, agentId: "agent", timestamp: new Date(1_800_000_000_000 + seq * 1000).toISOString() });
}
add("session_created", { agent: "claude", cwd: "/tmp" });
add("commands_updated", { commands: [{ name: "old-command", description: "old command" }] });
add("usage_updated", { usage: { cache_creation: { ephemeral_1h_input_tokens: 1 } } });
add("config_update_started", { message: "正在切换模型…" });
for (let turn = 0; turn < 60; turn++) {
  add("user_message", { text: `round ${turn}` });
  add("thought_delta", { text: "thinking" });
  add("tool_call_started", { toolCallId: `read-${turn}`, toolName: "Read", input: { file_path: `/tmp/${turn}` } });
  add("tool_call_completed", { toolCallId: `read-${turn}`, result: "read" });
  add("tool_call_started", { toolCallId: `read2-${turn}`, toolName: "Read", input: { file_path: `/tmp/${turn}-2` } });
  add("tool_call_completed", { toolCallId: `read2-${turn}`, result: "read2" });
  if (turn === 0) {
    add("tool_call_started", { toolCallId: "todos", toolName: "TodoWrite", input: { todos: [{ content: "task", status: "pending" }] } });
    add("tool_call_completed", { toolCallId: "todos", result: "done" });
    add("permission_request", { requestId: "resolved", questions: [{ question: "old?" }] });
    add("permission_resolved", { requestId: "resolved", decision: "allow", questionAnswers: { "old?": "yes" } });
    add("external_messages_added", { messages: [{ role: "user", text: "outside", timestamp: null }] });
  }
  add("agent_text_delta", { text: `answer ${turn}` });
  if (turn === 59) {
    add("usage_updated", { usage: { cache_read_input_tokens: 99 } });
    add("tool_call_started", { toolCallId: "running", toolName: "Bash", input: { command: "sleep 1" } });
    add("permission_request", { requestId: "pending", questions: [{ question: "continue?" }] });
  }
  add("turn_completed");
}
const session = { id, agent: "claude", agentId: "agent", cwd: "/tmp", status: "running", seq: events.length,
  createdAt: events[0].timestamp, lastActivityAt: events.at(-1).timestamp, config: {}, riskyMode: false, transcriptPath: "/tmp/paging.ndjson" };
const tail = selectEventPage(events);
assert.equal(tail.hasMore, true);
const earlier = selectEventPage(events, tail.firstSeq);
assert.equal(earlier.hasMore, false);
const seeded = { ...session, title: "round 0", snapshotState: snapshotState(events) };
const envelope = (data) => ({ json: async () => ({ code: 0, msg: "", data }) });
let calls = [];
let release;
let fail = false;
let delayed = true;
globalThis.fetch = (path) => {
  calls.push(String(path));
  if (String(path).endsWith("/snapshot?tail=1")) return Promise.resolve(envelope({ session: seeded, seq: session.seq, ...tail }));
  if (String(path).endsWith("/commands")) return Promise.resolve(envelope({ commands: seeded.snapshotState.commands }));
  if (String(path).includes("/events?")) {
    if (fail) return Promise.reject(new Error("offline"));
    if (delayed) return new Promise((resolve) => { release = resolve; });
    return Promise.resolve(envelope(earlier));
  }
  if (String(path).endsWith("/snapshot")) return Promise.resolve(envelope({ session, seq: session.seq, events }));
  throw new Error(`unexpected ${path}`);
};
assert.deepEqual((await fetchSnapshot(id)).events, events, "API 默认仍可取全量");
const full = new Store();
full.applySnapshot(id, { ...session, title: "round 0" }, session.seq, events);
const paged = new Store();
await paged.ensureLoaded(id);
const state = (store) => ({ pending: [...store.data.get(id).pendingGates], usage: store.data.get(id).latestUsage,
  commands: store.commands.get(id), switching: store.configSwitching.get(id), expiry: store.promptCacheExpiry(id), title: store.session(id).title });
assert.deepEqual(state(paged), state(full), "首段状态必须与全量一致，TTL、命令与切换起点在旧段");
assert.equal(paged.promptCacheExpiry(id), promptCacheExpiry(events));
let anchors = 0;
const first = paged.loadOlder(id, () => { anchors++; });
const concurrent = paged.loadOlder(id);
assert.equal(first, concurrent, "并发加载复用 Promise");
assert.equal(calls.filter((path) => path.includes("/events?")).length, 1);
assert.equal(calls.at(-1), `/api/sessions/${id}/events?beforeSeq=${tail.firstSeq}`);
const newer = { ...events.at(-1), seq: session.seq + 1, type: "agent_text_delta", payload: { text: "live" } };
paged.handleEvent(newer);
full.handleEvent(newer);
release(envelope(earlier));
await first;
assert.deepEqual(paged.data.get(id).events, [...events, newer], "两段拼出全量且保留加载途中的实时帧");
assert.deepEqual(state(paged), state(full), "加载旧段不覆盖当前派生状态");
assert.equal(anchors, 1);
assert.equal(paged.data.get(id).seq, newer.seq, "prepend 不回退 replay afterSeq");
assert.deepEqual(groupReadOnlyTools(buildRenderItems(paged.data.get(id).events, "claude"), "claude", "/tmp"),
  groupReadOnlyTools(buildRenderItems(full.data.get(id).events, "claude"), "claude", "/tmp"), "分组、工具、问答、todo、外部区块与全量完全相同");
await paged.loadOlder(id);
assert.equal(calls.filter((path) => path.includes("/events?")).length, 1, "翻到头后不再请求");

// 加载失败保留原段；点击重试成功后不会重复插入。
const retry = new Store();
await retry.ensureLoaded(id);
fail = true;
await retry.loadOlder(id);
assert.equal(retry.data.get(id).olderError, "offline");
assert.equal(retry.data.get(id).loadingOlder, false);
assert.deepEqual(retry.data.get(id).events, tail.events);
fail = false;
delayed = false;
await retry.loadOlder(id);
await retry.loadOlder(id);
assert.deepEqual(retry.data.get(id).events, events);

// resync 作废旧页请求；旧响应及 finally 不影响新快照与新页请求。
delayed = true;
const stale = new Store();
await stale.ensureLoaded(id);
const oldRequest = stale.loadOlder(id);
const oldRelease = release;
await stale.resync(id);
const newRequest = stale.loadOlder(id);
const newRelease = release;
oldRelease(envelope(earlier));
await oldRequest;
assert.deepEqual(stale.data.get(id).events, tail.events);
assert.equal(stale.data.get(id).loadingOlder, true);
newRelease(envelope(earlier));
await newRequest;
assert.deepEqual(stale.data.get(id).events, events);

const failedResync = new Store();
await failedResync.ensureLoaded(id);
const abandoned = failedResync.loadOlder(id);
const abandonedRelease = release;
const normalFetch = globalThis.fetch;
globalThis.fetch = (path) => String(path).endsWith("/snapshot?tail=1")
  ? Promise.reject(new Error("snapshot offline")) : normalFetch(path);
await failedResync.resync(id);
assert.equal(failedResync.data.get(id).loadingOlder, false, "resync 失败也必须解除旧分页 loading");
assert.equal(failedResync.data.get(id).olderError, "snapshot offline");
abandonedRelease(envelope(earlier));
await abandoned;
assert.deepEqual(failedResync.data.get(id).events, tail.events);
globalThis.fetch = normalFetch;
delayed = false;
await failedResync.loadOlder(id);
assert.deepEqual(failedResync.data.get(id).events, events);

// 超过旧 2000 条上限的已加载段与实时增长不会被剪掉。
const large = new Store();
const many = Array.from({ length: 2100 }, (_, i) => ({ ...events[0], seq: i + 1 }));
large.applySnapshot(id, session, many.length, many, false, 1);
large.handleEvent({ ...newer, seq: many.length + 1 });
assert.equal(large.data.get(id).events.length, 2101);
assert.equal(large.data.get(id).dropped, 0);

const view = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
assert.match(view, /new IntersectionObserver/);
assert.match(view, /anchor\.element\.getBoundingClientRect\(\)\.top - anchor\.top/);
assert.match(view, /加载更早的消息失败，点击重试/);
console.log("✅ snapshot paging: tail/state parity, full stitching/render grouping, concurrent/retry, live cursor, stale resync, >2000 retention");
