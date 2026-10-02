import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_PAGE_MAX_JSON_BYTES, EVENT_PAGE_MAX_TURNS, InvalidEventPageCursor, selectEventPage, snapshotState } from "./event-pages.js";
import type { DriverOptions, UnifiedEvent } from "./types.js";
import type { NativeConversationReader } from "./native-conversation.js";

function fixture(): { events: UnifiedEvent[]; add: (type: UnifiedEvent["type"], payload?: Record<string, unknown>) => UnifiedEvent } {
  const events: UnifiedEvent[] = [];
  const add = (type: UnifiedEvent["type"], payload: Record<string, unknown> = {}) => {
    const event: UnifiedEvent = { type, sessionId: "s", agentId: "a", seq: events.length + 1, timestamp: "2026-10-02T00:00:00.000Z", payload };
    events.push(event);
    return event;
  };
  return { events, add };
}

const turns = fixture();
turns.add("session_created");
for (let index = 0; index < 65; index++) {
  turns.add("user_message", { text: `turn ${index}` });
  turns.add("tool_call_started", { toolCallId: `t${index}` });
  turns.add("tool_call_completed", { toolCallId: `t${index}` });
  turns.add("turn_completed");
}
let page = selectEventPage(turns.events);
assert.equal(page.events[0]!.payload.text, "turn 35");
assert.equal(page.events.filter((event) => event.type === "user_message").length, EVENT_PAGE_MAX_TURNS);
assert.equal(page.hasMore, true);
assert.equal(page.firstSeq, page.events[0]!.seq);
let stitched = page.events;
while (page.hasMore) {
  page = selectEventPage(turns.events, page.firstSeq);
  assert.equal(page.firstSeq, page.events[0]!.seq);
  stitched = [...page.events, ...stitched];
}
assert.deepEqual(stitched, turns.events, "paging to the beginning exactly reconstructs every event, including prelude");
assert.deepEqual(selectEventPage(turns.events, 1), { events: [], hasMore: false, firstSeq: 0 });
assert.deepEqual(selectEventPage(turns.events, 999999), selectEventPage(turns.events));
assert.deepEqual(selectEventPage([]), { events: [], hasMore: false, firstSeq: 0 });
assert.throws(() => selectEventPage(turns.events, 3), InvalidEventPageCursor, "a cursor inside a tool/turn is rejected");
assert.throws(() => selectEventPage(turns.events, 2), InvalidEventPageCursor, "prelude cannot be separated from the first turn");
assert.throws(() => selectEventPage(turns.events, NaN), InvalidEventPageCursor);

for (const kind of ["tool", "gate", "late-update", "open-tool", "open-gate"] as const) {
  const run = fixture();
  for (let index = 0; index < 40; index++) {
    run.add("user_message", { text: `turn ${index}` });
    if (index === 5) run.add(kind.includes("gate") ? "permission_request" : "tool_call_started", { toolCallId: "cross", requestId: "cross" });
    if (index === 6 && kind === "late-update") run.add("tool_call_completed", { toolCallId: "cross" });
    if (index === 10) run.add("process_exited");
    if (index === 15 && kind === "late-update") run.add("tool_call_updated", { toolCallId: "cross", input: "updated after completed" });
    if (index === 15 && kind === "tool") run.add("tool_call_completed", { toolCallId: "cross" });
    if (index === 15 && kind === "gate") run.add("permission_resolved", { requestId: "cross" });
    run.add("turn_completed");
  }
  const last = selectEventPage(run.events);
  if (kind.startsWith("open")) {
    assert.equal(last.events[0]!.payload.text, "turn 5", "open tool/gate spans force retention even above the turn cap and across process_exited");
  } else {
    assert.equal(last.events[0]!.payload.text, "turn 16", "closed spans and late tool updates rule out every crossing cut");
    const previous = selectEventPage(run.events, last.firstSeq);
    assert(previous.events.some((event) => event.type === (kind === "gate" ? "permission_request" : "tool_call_started")));
    assert(previous.events.some((event) => event.type === (kind === "gate" ? "permission_resolved" : kind === "late-update" ? "tool_call_updated" : "tool_call_completed")));
    const badCursor = run.events.find((event) => event.type === "user_message" && event.payload.text === "turn 11")!.seq;
    assert.throws(() => selectEventPage(run.events, badCursor), InvalidEventPageCursor);
  }
}

const steer = fixture();
for (let index = 0; index < 31; index++) {
  steer.add("user_message", { text: `turn ${index}` });
  for (let extra = 0; extra < 3; extra++) steer.add("user_message", { text: "steer", steer: true, queued: true });
  steer.add("turn_completed");
}
const steerPage = selectEventPage(steer.events);
assert.equal(steerPage.events[0]!.payload.text, "turn 1");
assert.equal(steerPage.events.filter((event) => event.type === "user_message" && event.payload.steer !== true).length, 30);

const large = fixture();
large.add("session_created");
large.add("user_message", { text: "a huge single turn" });
large.add("agent_text_delta", { text: "x".repeat(EVENT_PAGE_MAX_JSON_BYTES + 100) });
assert.deepEqual(selectEventPage(large.events).events, large.events, "one oversized turn is indivisible");
large.add("user_message", { text: "small next turn" });
large.add("turn_completed");
const small = selectEventPage(large.events);
assert.equal(small.events[0]!.payload.text, "small next turn");
assert.deepEqual(selectEventPage(large.events, small.firstSeq).events, large.events.slice(0, 3));

const bytes = fixture();
for (let index = 0; index < 10; index++) {
  bytes.add("user_message", { text: `turn ${index}` });
  bytes.add("agent_text_delta", { text: "中".repeat(100_000) });
}
const bytePage = selectEventPage(bytes.events);
assert.equal(bytePage.events.filter((event) => event.type === "user_message").length, 5);
assert(Buffer.byteLength(JSON.stringify(bytePage.events)) <= EVENT_PAGE_MAX_JSON_BYTES);
const noUser = fixture();
noUser.add("session_created");
noUser.add("agent_text_delta", { text: "x".repeat(EVENT_PAGE_MAX_JSON_BYTES + 100) });
assert.deepEqual(selectEventPage(noUser.events), { events: noUser.events, hasMore: false, firstSeq: 1 });

const state = fixture();
state.add("commands_updated", { commands: [{ name: "one", source: "claude", description: "command" }] });
state.add("usage_updated", { usage: { cache_creation: { ephemeral_1h_input_tokens: 10 } } });
state.add("config_update_started");
const latest = state.add("usage_updated", { usage: { input_tokens: 20 } });
latest.timestamp = "2026-10-02T00:01:00.000Z";
for (let index = 0; index < 40; index++) state.add("user_message", { text: `turn ${index}` });
const derived = snapshotState(state.events);
assert.deepEqual(derived.latestUsage, latest.payload);
assert.equal(derived.commands[0]!.name, "one");
assert.equal(derived.configSwitching, "正在切换配置…");
assert.equal(derived.promptCacheTtlMs, 60 * 60_000);
assert.equal(derived.promptCacheUsageAt, Date.parse(latest.timestamp));
assert(!selectEventPage(state.events).events.some((event) => event.type === "usage_updated"));
state.add("session_error");
state.add("commands_updated", { commands: false });
assert.equal(snapshotState(state.events).configSwitching, undefined);
assert.deepEqual(snapshotState(state.events).commands, []);
const fiveMinute = fixture();
fiveMinute.add("usage_updated", { usage: { cache_creation: { ephemeral_5m_input_tokens: 1 } } });
assert.equal(snapshotState(fiveMinute.events).promptCacheTtlMs, 5 * 60_000);
fiveMinute.events[0]!.timestamp = "invalid";
assert.equal(snapshotState(fiveMinute.events).promptCacheUsageAt, null);
assert.equal(snapshotState(fiveMinute.events).promptCacheTtlMs, null);

const home = mkdtempSync(join(tmpdir(), "wb-event-pages-test-"));
process.env.WORKBENCH_HOME = home;
const [{ SessionManager }, { ClaudeDriver }] = await Promise.all([import("./session-manager.js"), import("./drivers/claude.js")]);
let callbacks: DriverOptions["callbacks"];
class TestDriver extends ClaudeDriver {
  async start() { this.callbacks.status("idle"); }
  async stop() {}
}
const manager = new SessionManager((_kind, options) => {
  callbacks = options.callbacks;
  return new TestDriver(options);
}, () => ({ model: null, effort: null, remoteControlAtStartup: false }), undefined,
{ capture: async () => ({ path: home, identity: "test", offset: 0, size: 0 }) } as unknown as NativeConversationReader);
const session = await manager.create({ agent: "claude", cwd: home });
callbacks!.commands([{ name: "before", description: "before the tail", source: "claude" }]);
callbacks!.emit("usage_updated", { usage: { cache_creation: { ephemeral_5m_input_tokens: 1 } } });
for (let index = 0; index < 40; index++) {
  callbacks!.emit("user_message", { text: `manager ${index}` });
  callbacks!.emit("turn_completed");
}
const full = manager.getSnapshot(session.id)!;
assert.deepEqual(Object.keys(full).sort(), ["events", "seq", "session"], "the legacy snapshot has no new top-level keys");
assert.equal(full.session.snapshotState, undefined, "the legacy session has no snapshot-only state");
const tail = manager.getSnapshot(session.id, true)!;
assert.equal(tail.seq, full.seq);
assert.equal(tail.hasMore, true);
assert.equal(tail.session.title, "manager 0", "the tail title comes from the full transcript even when legacy session omits it");
assert.equal(tail.session.snapshotState!.commands[0]!.name, "before");
assert.equal(tail.session.snapshotState!.promptCacheTtlMs, 5 * 60_000);
const previous = manager.getEventsBefore(session.id, tail.firstSeq!)!;
assert.equal(previous.hasMore, false);
assert.deepEqual([...previous.events, ...tail.events], full.events);
assert.equal(manager.getSnapshot("missing", true), undefined);
assert.equal(manager.getEventsBefore("missing", 1), undefined);
await manager.shutdown();

console.log("✅ event pages: safe turns/tool and gate spans/steer/size caps/cursors/stitching/session reducers");
