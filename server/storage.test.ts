import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind, Driver, DriverOptions, SessionConfig, SessionRecord, SessionStatus, UnifiedEvent } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-storage-test-"));
const home = join(fixture, "workbench");
process.env.WORKBENCH_HOME = home;
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(fixture, "native", "claude");
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(fixture, "native", "codex");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(fixture, "native", "kimi");

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function event(id: string, type: UnifiedEvent["type"], payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type, sessionId: id, agentId: "main", seq: 1,
    timestamp: "2026-10-02T00:00:00.000Z", payload } satisfies UnifiedEvent)}\n`;
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id, agent: "codex", agentId: "main", cwd: fixture, status: "dead",
    createdAt: "2026-10-02T00:00:00.000Z", lastActivityAt: "2026-10-02T00:00:00.000Z",
    seq: 1, transcriptPath: join(home, "transcripts", `${id}.ndjson`), config: {}, riskyMode: false, ...overrides };
}

function bytes(paths: string[]): number {
  return paths.reduce((sum, path) => sum + statSync(path).size, 0);
}

class FakeDriver implements Driver {
  stopped = false;
  constructor(readonly kind: AgentKind, readonly options: DriverOptions) {}
  async start(): Promise<void> { this.options.callbacks.status("idle"); }
  getConfigSchema() { return { source: "storage-test", options: [] }; }
  async setConfig(config: SessionConfig): Promise<SessionConfig> { return config; }
  async sendUserMessage(): Promise<void> { this.options.callbacks.status("running"); }
  async resolvePermission(): Promise<void> {}
  async interrupt(): Promise<void> { this.options.callbacks.status("idle"); }
  async stop(): Promise<void> { this.stopped = true; }
}

let manager: import("./session-manager.js").SessionManager | undefined;
try {
  const nativePath = write(join(fixture, "native", "original.jsonl"), "CLI native record must survive\n");
  const dead = record("dead-own", { nativeSessionId: "native-dead", nativeTranscriptPath: nativePath });
  const sharedDead = record("dead-shared");
  const gated = record("pending-dead");
  const idle = record("idle-released", { released: true, nativeSessionId: "native-idle" });
  const sharedOrphanUpload = write(join(home, "uploads", "shared-orphan", "image.png"), "shared orphan image");
  const endedOnlyOrphanUpload = write(join(home, "uploads", "ended-only-orphan", "image.png"), "referenced only by ended session");
  const sharedDeadUpload = write(join(home, "uploads", sharedDead.id, "image.png"), "shared ended image");
  const deadUploads = [
    write(join(home, "uploads", dead.id, "a.png"), "ended image one"),
    write(join(home, "uploads", dead.id, "nested", "b.png"), "ended image two"),
  ];
  const gatedUpload = write(join(home, "uploads", gated.id, "a.png"), "pending approval image");
  write(dead.transcriptPath, event(dead.id, "user_message", { text: "ended", mentions: [endedOnlyOrphanUpload] }));
  write(sharedDead.transcriptPath, event(sharedDead.id, "user_message", { text: "ended shared" }));
  write(gated.transcriptPath, event(gated.id, "permission_request", { requestId: "unresolved-gate", toolName: "Write" }));
  write(idle.transcriptPath, event(idle.id, "user_message", { mentions: [sharedOrphanUpload, sharedDeadUpload] }));
  const registryPath = write(join(home, "sessions.json"), JSON.stringify([dead, sharedDead, gated, idle]));

  const [{ SessionManager }, { getStorageStats, cleanStorage, validateStorageCleanInput, StorageInputError }] = await Promise.all([
    import("./session-manager.js"), import("./storage.js"),
  ]);
  const drivers: FakeDriver[] = [];
  manager = new SessionManager((agent, options) => {
    const driver = new FakeDriver(agent, options);
    drivers.push(driver);
    return driver;
  });
  const active: SessionRecord[] = [];
  const activeUploads: string[] = [];
  for (const status of ["idle", "running", "starting", "error"] satisfies SessionStatus[]) {
    const created = await manager.create({ agent: "codex", cwd: fixture, snapshot: "skip" });
    drivers.at(-1)!.options.callbacks.status(status);
    active.push(manager.get(created.id)!);
    activeUploads.push(write(join(home, "uploads", created.id, "keep.png"), `keep ${status}`));
  }
  assert.equal(manager.get(idle.id)?.status, "idle", "released idle session is restored without starting a CLI");
  assert.equal(manager.list().find((session) => session.id === gated.id)?.pendingGateCount, 0);
  assert.equal(manager.isEndedSessionRemovable(gated.id), false, "hidden pending gate protects a dead session");
  assert.equal(manager.isEndedSessionRemovable(dead.id), true);
  const resumeState = manager as unknown as { checkingSessions: Set<string>; restartingSessions: Set<string> };
  for (const guard of [resumeState.checkingSessions, resumeState.restartingSessions]) {
    guard.add(dead.id);
    assert.equal(manager.isEndedSessionRemovable(dead.id), false, "session being resumed cannot be cleaned");
    assert.equal((await getStorageStats(manager)).cleanable.ended.sessions, 1);
    guard.delete(dead.id);
  }

  // The registry deliberately disagrees with live memory: omit an idle session and register an orphan.
  const diskOnly = record("disk-only");
  const orphanTranscripts = [
    write(diskOnly.transcriptPath, event(diskOnly.id, "user_message", { text: "disk only" })),
    write(join(home, "transcripts", "orphan.ndjson"), event("orphan", "user_message", { text: "orphan" })),
  ];
  const orphanUploads = [
    write(join(home, "uploads", diskOnly.id, "a.png"), "disk only upload"),
    write(join(home, "uploads", "loose", "a.png"), "orphan upload one"),
    write(join(home, "uploads", "loose", "nested", "b.png"), "orphan upload two"),
  ];
  write(registryPath, JSON.stringify([...manager.list().filter((session) => session.id !== idle.id), diskOnly]));
  const transcriptNote = write(join(home, "transcripts", "README.txt"), "keep non-transcript metadata");
  const currentLog = write(join(home, "server.log"), "l".repeat(100));
  const rotatedLogs = [
    write(join(home, "server.log.1"), "1".repeat(70)),
    write(join(home, "server.log.2"), "2".repeat(30)),
    write(join(home, "server.log.old"), "o".repeat(40)),
  ];
  const otherFiles = [registryPath,
    write(join(home, "snapshots", "nested", "snapshot.json"), "snapshot"),
    write(join(home, "prefs.json"), "preferences"),
  ];
  const sessionTranscripts = [dead, sharedDead, gated, idle, ...active].map((session) => session.transcriptPath);
  const allTranscripts = [...sessionTranscripts, ...orphanTranscripts, transcriptNote];
  const allUploads = [...deadUploads, sharedDeadUpload, sharedOrphanUpload, endedOnlyOrphanUpload, gatedUpload, ...activeUploads, ...orphanUploads];
  const orphanBytes = bytes([...orphanTranscripts, ...orphanUploads]);
  const defaultFreed = bytes(rotatedLogs) + orphanBytes;
  const endedBytes = bytes([dead.transcriptPath, sharedDead.transcriptPath, ...deadUploads, endedOnlyOrphanUpload]);
  const before = await getStorageStats(manager);
  assert.deepEqual(before.categories, {
    transcripts: { bytes: bytes(allTranscripts), files: allTranscripts.length, sessions: sessionTranscripts.length + orphanTranscripts.length },
    uploads: { bytes: bytes(allUploads), files: allUploads.length, sessions: 11 },
    logs: { bytes: bytes([currentLog, ...rotatedLogs]), files: 4, sessions: 0 },
    other: { bytes: bytes(otherFiles), files: otherFiles.length, sessions: 0 },
  });
  assert.equal(before.totalBytes, bytes([...allTranscripts, ...allUploads, currentLog, ...rotatedLogs, ...otherFiles]));
  assert.deepEqual(before.cleanable, {
    bytes: defaultFreed,
    rotatedLogs: { bytes: 140, files: 3 },
    orphans: { bytes: orphanBytes, files: 5, uploadDirs: 2 },
    ended: { bytes: endedBytes, files: 5, sessions: 2 },
  });

  assert.doesNotThrow(() => validateStorageCleanInput({ includeEnded: false }));
  assert.doesNotThrow(() => validateStorageCleanInput({ includeEnded: true }));
  for (const invalid of [null, undefined, [], true, "true", {}, { includeEnded: "false" }, { includeEnded: 0 }]) {
    assert.throws(() => validateStorageCleanInput(invalid), StorageInputError);
  }

  const preservedPaths = [...sessionTranscripts, ...deadUploads, sharedDeadUpload, sharedOrphanUpload, endedOnlyOrphanUpload, gatedUpload, ...activeUploads,
    currentLog, transcriptNote, nativePath, ...otherFiles];
  const cleaned = await cleanStorage(manager, false);
  assert.equal(cleaned.freedBytes, defaultFreed, "released bytes count removed files, excluding registry rewrite");
  assert.deepEqual(cleaned.removed, { rotatedLogs: 3, orphanFiles: 5, orphanUploadDirs: 2, endedSessions: 0 });
  for (const path of [...rotatedLogs, ...orphanTranscripts, ...orphanUploads]) assert.equal(existsSync(path), false, path);
  for (const path of preservedPaths) assert.equal(existsSync(path), true, path);
  assert.equal(manager.get(dead.id)?.status, "dead", "includeEnded=false retains ended sessions");
  assert.equal(manager.get(sharedDead.id)?.status, "dead");
  assert.equal(cleaned.storage.cleanable.bytes, 0);
  assert.equal(cleaned.storage.cleanable.ended.bytes, endedBytes);
  assert.deepEqual(cleaned.storage, await getStorageStats(manager));

  const noOp = await cleanStorage(manager, false);
  assert.equal(noOp.freedBytes, 0);
  assert.deepEqual(noOp.removed, { rotatedLogs: 0, orphanFiles: 0, orphanUploadDirs: 0, endedSessions: 0 });
  assert.deepEqual(noOp.storage, cleaned.storage);

  const endedClean = await cleanStorage(manager, true);
  assert.equal(endedClean.freedBytes, endedBytes);
  assert.deepEqual(endedClean.removed, { rotatedLogs: 0, orphanFiles: 1, orphanUploadDirs: 1, endedSessions: 2 },
    "attachment referenced only by removed sessions becomes a cleanable orphan");
  assert.equal(manager.get(dead.id), undefined);
  assert.equal(manager.get(sharedDead.id), undefined);
  for (const path of [dead.transcriptPath, sharedDead.transcriptPath, ...deadUploads, endedOnlyOrphanUpload]) assert.equal(existsSync(path), false, path);
  for (const path of [gated.transcriptPath, idle.transcriptPath, gatedUpload, sharedDeadUpload, sharedOrphanUpload,
    ...active.map((session) => session.transcriptPath), ...activeUploads, currentLog, nativePath, transcriptNote]) {
    assert.equal(existsSync(path), true, path);
  }
  assert.deepEqual(active.map((session) => manager!.get(session.id)?.status), ["idle", "running", "starting", "error"]);
  assert.equal(drivers.some((driver) => driver.stopped), false, "cleaning never stops non-dead workers");
  assert.equal(manager.get(gated.id)?.status, "dead", "dead session with an approval gate survives includeEnded=true");
  assert.equal(readFileSync(nativePath, "utf8"), "CLI native record must survive\n");
  assert.equal(endedClean.storage.cleanable.ended.sessions, 0);
  assert.equal(endedClean.storage.cleanable.bytes, 0, "shared orphan attachment remains protected");
  assert.deepEqual(endedClean.storage, await getStorageStats(manager));
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).some((session: SessionRecord) => session.id === dead.id), false);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).some((session: SessionRecord) => session.id === idle.id), true);

  // Symlinks are counted as links; no traversal or deletion may affect their external targets.
  const outsideDir = join(fixture, "outside");
  const outsideFile = write(join(outsideDir, "keep.bin"), "x".repeat(4096));
  const links = [join(home, "uploads", "linked-dir"), join(home, "server.log.link"),
    join(home, "transcripts", "linked.ndjson"), join(home, "snapshots", "linked")];
  symlinkSync(outsideDir, links[0]!);
  symlinkSync(outsideFile, links[1]!);
  symlinkSync(outsideFile, links[2]!);
  symlinkSync(outsideDir, links[3]!);
  const withLinks = await getStorageStats(manager);
  assert.equal(withLinks.totalBytes, endedClean.storage.totalBytes + links.reduce((sum, path) => sum + lstatSync(path).size, 0));
  assert.equal(withLinks.categories.uploads.sessions, endedClean.storage.categories.uploads.sessions, "symlink is not an upload directory");
  const linkClean = await cleanStorage(manager, true);
  assert.equal(existsSync(outsideFile), true);
  assert.equal(readFileSync(outsideFile, "utf8"), "x".repeat(4096));
  assert.equal(lstatSync(links[0]!).isSymbolicLink(), true);
  assert.equal(lstatSync(links[1]!).isSymbolicLink(), true, "symlink log is never a rotated-log deletion candidate");
  assert.deepEqual(linkClean.storage, await getStorageStats(manager));

  console.log("✅ storage: exact statistics, live registry, default/ended cleanup, protected sessions, shared attachments, idempotence, native records and symlinks");
} finally {
  await manager?.shutdown();
  // Authorized cleanup list: only this test's mkdtemp root and its generated fixtures.
  await rm(fixture, { recursive: true, force: true });
  assert.equal(existsSync(fixture), false, "temporary storage fixture cleanup is verified");
}
