import assert from "node:assert/strict";
import { replaySession, type EventClient } from "./event-stream.js";
import type { UnifiedEvent } from "./types.js";

const event = (seq: number, text: string): UnifiedEvent => ({ type: "agent_text_delta", sessionId: "fixture", agentId: "main", seq,
  timestamp: "2026-01-01T00:00:00Z", payload: { text } });
for (const [name, events, bufferedAmount] of [
  ["single large event", [event(1, "x".repeat(2 * 1024 * 1024))], 0],
  ["large batch within ring", Array.from({ length: 800 }, (_, i) => event(i + 1, "x".repeat(16 * 1024))), 0],
  ["UTF-8 wire bytes", [event(1, "界".repeat(200_000))], 0],
  ["existing buffered output", [event(1, "x".repeat(300_000))], 400_000],
] as const) {
  const frames: any[] = [];
  const client: EventClient = { lastSeq: new Map(), socket: { readyState: 1, bufferedAmount,
    send: data => { frames.push(JSON.parse(String(data))); }, terminate: () => assert.fail(`${name}: recovery must not disconnect`) } };
  replaySession({ getEventsAfter: () => ({ events: [...events], currentSeq: events.length, requiresSnapshot: false }) }, client, "fixture", 0);
  assert.deepEqual(frames.map(frame => [frame.type, frame.sessionId, frame.currentSeq]), [["resync_required", "fixture", events.length]], name);
  assert.equal(client.lastSeq.get("fixture"), 0, "snapshot fallback must not advance the replay cursor");
}
const frames: any[] = [];
const client: EventClient = { lastSeq: new Map(), socket: { readyState: 1, bufferedAmount: 0,
  send: data => frames.push(JSON.parse(String(data))), terminate: () => assert.fail("small replay must remain connected") } };
replaySession({ getEventsAfter: () => ({ events: [event(1, "small"), event(2, "reply")], currentSeq: 2, requiresSnapshot: false }) }, client, "fixture", 0);
assert.deepEqual(frames.map(frame => frame.seq ?? frame.type), [1, 2, "replay_complete"]);
assert.equal(client.lastSeq.get("fixture"), 2);
console.log("PASS: replay byte budget, UTF-8 bytes, queued output and small replay continuity");
