import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionRecord, UnifiedEvent } from "./types.js";

const fixture = mkdtempSync(join(tmpdir(), "workbench-storage-maintenance-"));
const home = join(fixture, "workbench");
const codex = join(fixture, "codex");
process.env.WORKBENCH_HOME = home;
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(codex, "sessions");
const { SessionManager } = await import("./session-manager.js");
const { readTranscriptState, appendTranscript, flushTranscripts } = await import("./persistence.js");
const { createStorageMaintenance, getStorageStats } = await import("./storage.js");
const { readTranscriptText } = await import("./transcript-archive.js");

function write(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function record(id: string, day: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const time = new Date(Date.UTC(2026, 10, day)).toISOString();
  return { id, nativeSessionId: id, agent: "codex", agentId: "main", cwd: fixture, status: "idle", released: true,
    createdAt: time, lastActivityAt: time, seq: 3, transcriptPath: join(home, "transcripts", `${id}.ndjson`),
    config: {}, riskyMode: false, ...overrides };
}

function event(session: SessionRecord, seq: number, text: string): UnifiedEvent {
  return { sessionId: session.id, agentId: "main", seq, timestamp: session.createdAt,
    type: "user_message", payload: { text } };
}

let manager: InstanceType<typeof SessionManager> | undefined;
try {
  const old = record("old", 1);
  const recent = record("recent", 2);
  const pinned = record("pinned", 1, { pinned: true });
  const gated = record("gated", 1);
  const records = [old, recent, pinned, gated];
  const upload = join(home, "uploads", "shared", "attachment.txt");
  write(upload, "attachment");
  for (const session of records) {
    const events = [event(session, 1, "First question"), event(session, 2, "中".repeat(400_000)), event(session, 3, upload)];
    if (session === gated) events[2] = { ...events[2]!, type: "permission_request", payload: { requestId: "gate" } };
    write(session.transcriptPath, events.map(value => JSON.stringify(value)).join("\n") + "\n");
    write(join(codex, "sessions", "2026", "11", "01", `rollout-example-${session.id}.jsonl`), "{}\n");
  }
  write(join(home, "sessions.json"), JSON.stringify(records));
  manager = new SessionManager();
  const original = readFileSync(old.transcriptPath);
  const recentSize = statSync(recent.transcriptPath).size;
  const before = manager.getSnapshot(old.id);
  const page = manager.getSnapshot(old.id, true);
  const older = manager.getEventsBefore(old.id, 3);
  const budget = getStorageStats(manager).totalBytes - 200_000;
  const counts = async () => new Map<string, number>();
  const maintain = createStorageMaintenance(manager, { budgetBytes: budget, targetBytes: budget, activeDispatches: counts });
  await maintain();
  assert.ok(getStorageStats(manager).totalBytes <= budget);
  assert.ok(statSync(old.transcriptPath).size < original.length / 2, "the oldest eligible copy is compressed");
  assert.equal(statSync(recent.transcriptPath).size, recentSize, "newer copy is left alone");
  assert.equal(statSync(pinned.transcriptPath).size > original.length / 2, true);
  assert.equal(statSync(gated.transcriptPath).size > original.length / 2, true);
  assert.deepEqual(manager.getSnapshot(old.id), before);
  assert.deepEqual(manager.getSnapshot(old.id, true), page);
  assert.deepEqual(manager.getEventsBefore(old.id, 3), older);
  assert.ok(existsSync(upload), "archived history still protects referenced attachments");

  await manager.shutdown();
  manager = new SessionManager();
  assert.deepEqual(manager.getSnapshot(old.id), before, "compressed records survive process recovery");
  const maintainAfterRestart = createStorageMaintenance(manager, { budgetBytes: budget, targetBytes: budget, activeDispatches: counts });
  const active = join(codex, "sessions", "2026", "11", "01", "rollout-example-old.jsonl");
  const archive = join(codex, "archived_sessions", "rollout-example-old.jsonl");
  mkdirSync(dirname(archive));
  renameSync(active, archive);
  await maintainAfterRestart();
  await maintainAfterRestart();
  assert.ok(manager.get(old.id), "CLI archive is still a native session");
  renameSync(join(codex, "sessions"), join(codex, "offline"));
  await maintainAfterRestart();
  await maintainAfterRestart();
  assert.ok(manager.get(old.id), "an unavailable store cannot authorize removal");
  renameSync(join(codex, "offline"), join(codex, "sessions"));
  rmSync(archive);
  await maintainAfterRestart();
  assert.ok(manager.get(old.id), "first miss does not remove the only visible history");
  appendTranscript(old.transcriptPath, event(old, 4, "Continued"));
  flushTranscripts(old.transcriptPath);
  assert.equal(readTranscriptState(old.transcriptPath).events.at(-1)?.seq, 4, "the next write unpacks and appends");
  assert.deepEqual(readFileSync(old.transcriptPath).subarray(0, original.length), original);
  const organization = new Promise<string[]>(resolve => manager!.onOrganizationUpdated(frame => resolve(frame.sessions.map(session => session.id))));
  await maintainAfterRestart();
  assert.equal(manager.get(old.id), undefined, "confirmed native removal clears the workbench entry even below budget");
  assert.equal((await organization).includes(old.id), false);
  assert.equal(existsSync(old.transcriptPath), false);
  assert.ok(manager.get(pinned.id));

  const replayed = record("replayed", 3);
  const nativePath = join(codex, "sessions", "2026", "11", "01", "rollout-example-replayed.jsonl");
  const output = randomBytes(144_000).toString("base64");
  const onlyLocal = randomBytes(19_000).toString("base64");
  const tool: UnifiedEvent = { ...event(replayed, 2, ""), type: "tool_call_completed",
    payload: { toolCallId: "a", result: [{ type: "image", source: { data: output } }, onlyLocal] } };
  const replayEvents = [event(replayed, 1, "question"), tool, event(replayed, 3, "answer")];
  write(nativePath, JSON.stringify({ type: "session_meta", payload: { id: replayed.id } }) + "\n"
    + JSON.stringify({ output }) + "\n");
  write(replayed.transcriptPath, replayEvents.map(value => JSON.stringify(value)).join("\n") + "\n");
  const restored = manager.list();
  await manager.shutdown();
  write(join(home, "sessions.json"), JSON.stringify([...restored, replayed]));
  manager = new SessionManager();
  const beforeReplay = getStorageStats(manager).totalBytes;
  const targetBytes = beforeReplay - 145_000;
  await createStorageMaintenance(manager, { budgetBytes: beforeReplay - 20_000, targetBytes, activeDispatches: counts })();
  assert.ok(getStorageStats(manager).totalBytes <= targetBytes, "crossing the limit reclaims toward the lower target");
  const storedReplay = readTranscriptText(replayed.transcriptPath);
  assert.ok(!storedReplay.includes(output), "the verified duplicate is removed from the workbench copy");
  assert.ok(storedReplay.includes(onlyLocal), "workbench-only tool output is retained");
  assert.deepEqual(manager.getSnapshot(replayed.id)?.events, replayEvents);
  assert.deepEqual(manager.getSnapshot(replayed.id, true)?.events, replayEvents);
  await manager.shutdown();
  manager = new SessionManager();
  assert.equal(manager.getEventsAfter(replayed.id, 0)?.requiresSnapshot, true, "recovery must not replay placeholder events");
  assert.deepEqual(manager.getSnapshot(replayed.id)?.events, replayEvents);
  const archivedReplay = join(codex, "archived_sessions", "rollout-example-replayed.jsonl");
  renameSync(nativePath, archivedReplay);
  assert.deepEqual(manager.getSnapshot(replayed.id)?.events, replayEvents, "the native archive is readable after moving");
  const nativeHistory = readFileSync(archivedReplay, "utf8");
  write(archivedReplay, JSON.stringify({ metadata: "A new header changes the byte offsets" }) + "\n" + nativeHistory);
  assert.deepEqual(manager.getSnapshot(replayed.id)?.events, replayEvents, "transcript rewrites can relocate the exact payload");
  const continuation = event(replayed, 4, "continue after reclaiming");
  appendTranscript(replayed.transcriptPath, continuation);
  flushTranscripts(replayed.transcriptPath);
  replayEvents.push(continuation);
  assert.deepEqual(readTranscriptState(replayed.transcriptPath).events, replayEvents, "appending preserves the native references");
  renameSync(archivedReplay, join(fixture, "paused.jsonl"));
  const unavailable = manager.getSnapshot(replayed.id)?.events[1];
  assert.equal(unavailable?.nativePayloadUnavailable, true);
  assert.equal((unavailable?.payload.result as unknown[])[1], onlyLocal);
  assert.throws(() => manager!.updateOrganization(replayed.id, { pinned: true }), /原生历史暂不可读/);
  renameSync(join(fixture, "paused.jsonl"), archivedReplay);
  manager.updateOrganization(replayed.id, { pinned: true });
  rmSync(archivedReplay);
  assert.deepEqual(manager.getSnapshot(replayed.id)?.events, replayEvents, "pinning protects previously reclaimed data");
} finally {
  await manager?.shutdown();
  rmSync(fixture, { recursive: true, force: true });
}
