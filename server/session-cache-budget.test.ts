import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Driver, DriverOptions, SessionRecord, UnifiedEvent } from "./types.js";
const home = mkdtempSync(join(tmpdir(), "aireins-ring-budget-"));
Object.assign(process.env, { WORKBENCH_HOME: home, WORKBENCH_CLAUDE_HISTORY_DIR: join(home, "claude"),
  WORKBENCH_CODEX_HISTORY_DIR: join(home, "codex"), WORKBENCH_KIMI_HISTORY_DIR: join(home, "kimi") });
const p = await import("./persistence.js");
const { SessionManager } = await import("./session-manager.js");
p.loadRegistry();
const stored: SessionRecord[] = [0, 1, 2].map(index => {
  const id = `dead-${index}`, transcriptPath = p.transcriptPathFor(id);
  const event: UnifiedEvent = { type: "agent_text_delta", sessionId: id, agentId: "main", seq: 1,
    timestamp: "2026-01-01T00:00:00Z", payload: { text: "x".repeat(3 * 1024 * 1024) } };
  writeFileSync(transcriptPath, JSON.stringify(event) + "\n");
  return { id, agent: "codex", agentId: "main", cwd: home, status: "dead", seq: 1, config: {}, riskyMode: false,
    transcriptPath, createdAt: event.timestamp, lastActivityAt: event.timestamp };
});
p.saveRegistry(stored);
const factory = (kind: Driver["kind"], options: DriverOptions): Driver => ({ kind,
  async start() { options.callbacks.metadata({ nativeSessionId: `native-${options.sessionId}` }); options.callbacks.status("idle"); },
  async stop() {}, async sendUserMessage() {}, async resolvePermission() {}, async interrupt() {},
  async setConfig(config) { return config; }, getConfigSchema() { return { source: "fixture", options: [] }; } });
const manager = new SessionManager(factory);
const internal = manager as any;
assert.equal([...internal.rings.values()].reduce((n: number, ring: UnifiedEvent[]) => n + ring.length, 0), 0,
  "dead archives must not occupy startup replay cache");
for (const record of stored) {
  assert.equal(manager.getEventsAfter(record.id, 0)!.requiresSnapshot, true);
  assert.equal((manager.getSnapshot(record.id)!.events[0]!.payload.text as string).length, 3 * 1024 * 1024);
}
const active = await manager.create({ agent: "codex", cwd: home });
await manager.sendUserMessage(active.id, { text: "start" });
internal.setStatus(active.id, "running");
const activeSeq = manager.get(active.id)!.seq;
internal.emit(active.id, "agent_text_delta", { text: "a".repeat(1024 * 1024) });
const idle = [];
for (let i = 0; i < 4; i++) {
  const session = await manager.create({ agent: "codex", cwd: home });
  internal.emit(session.id, "agent_text_delta", { text: "b".repeat(3 * 1024 * 1024) });
  idle.push(session);
}
assert(internal.ringCacheBytes <= 16 * 1024 * 1024, "global replay cache must stay within its byte budget");
assert.equal(manager.getEventsAfter(active.id, activeSeq)!.requiresSnapshot, false, "prefer idle cache eviction over active work");
assert.equal(manager.getEventsAfter(idle[0]!.id, 0)!.requiresSnapshot, true);
assert.equal((manager.getSnapshot(idle[0]!.id)!.events.at(-1)!.payload.text as string).length, 3 * 1024 * 1024);
internal.emit(active.id, "agent_text_delta", { text: "a".repeat(6 * 1024 * 1024) });
internal.emit(idle[1]!.id, "agent_text_delta", { text: "i".repeat(2 * 1024 * 1024) });
assert.equal(manager.getEventsAfter(active.id, activeSeq)!.requiresSnapshot, false,
  "new idle output must be evicted before an older running conversation");
const oversized = idle.at(-1)!;
internal.emit(oversized.id, "agent_text_delta", { text: "z".repeat(17 * 1024 * 1024) });
assert(internal.ringCacheBytes <= 16 * 1024 * 1024);
assert.equal(manager.getEventsAfter(oversized.id, 0)!.requiresSnapshot, true);
assert.equal(manager.getEventsAfter(active.id, activeSeq)!.requiresSnapshot, false, "an uncacheable event must not evict unrelated caches");
await manager.release(idle[2]!.id, "manual");
assert.equal(internal.rings.has(idle[2]!.id), false, "released workers drop replay cache, not history");
await manager.shutdown();
console.log("PASS: startup dead archives, bounded replay memory, active priority, oversized events and release fallback");
