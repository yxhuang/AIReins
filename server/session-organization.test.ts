import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Driver, SessionRecord } from "./types.js";
import { normalizeProjectPath } from "../shared/project-path.js";

const home = mkdtempSync(join(tmpdir(), "aireins-project-order-"));
process.env.WORKBENCH_HOME = home;
const kimiRoot = join(home, "kimi-sessions");
process.env.WORKBENCH_KIMI_HISTORY_DIR = kimiRoot;
const { SessionManager, SessionBusyError } = await import("./session-manager.js");
const { organizationRoute } = await import("./session-organization-routes.js");
const { sendOrganizationUpdate } = await import("./session-organization.js");
const { pruneStorage, projectOrderPath, saveProjectOrder, loadProjectOrder } = await import("./persistence.js");
const record = (id: string, cwd: string, createdAt: string): SessionRecord => ({ id, agent: "codex", agentId: "main", cwd,
  status: "dead", config: {}, riskyMode: false, createdAt,
  lastActivityAt: "2020-01-01T00:00:00.000Z", seq: 0, transcriptPath: join(home, "transcripts", `${id}.ndjson`) });
const a = join(home, "a"), b = join(home, "b"), hidden = join(home, "hidden"), c = join(home, "c");
for (const cwd of [a, b, hidden, c]) mkdirSync(cwd);
const originals = [record("one", `${a}//./`, "2020-01-04"), record("two", b, "2020-01-02"),
  { ...record("three", hidden, "2020-01-03"), groupId: "legacy" }, record("four", a, "2020-01-01")];
writeFileSync(join(home, "sessions.json"), JSON.stringify(originals));
const legacyFile = join(home, "session-groups.json");
writeFileSync(legacyFile, "untouched legacy contents");
const factory = (kind: Driver["kind"], _options?: unknown): Driver => ({ kind, async start() {}, async stop() {},
  getConfigSchema: () => ({ source: "test", options: [] }), async setConfig(config) { return config; },
  async sendUserMessage() {}, async resolvePermission() {}, async interrupt() {} });
let manager = new SessionManager(factory);
const route = (method: string, path: string, body?: unknown) => organizationRoute(manager, method, path, body)!;
const invalid = (method: string, path: string, body: unknown, status = 400) => assert.throws(
  () => route(method, path, body), (error: any) => error.status === status && (status !== 400 || error.code === 40070));
try {
  assert.equal(normalizeProjectPath("//a/./b/../C///"), "/a/C");
  assert.equal(normalizeProjectPath("/../../"), "/");
  assert.equal(normalizeProjectPath("/a"), "/a");
  assert.deepEqual(route("GET", "/api/project-order"), { status: 200, data: { paths: [a, hidden, b] } });
  assert.deepEqual(JSON.parse(readFileSync(projectOrderPath, "utf8")), [a, hidden, b], "first load seeds latest creation per normalized directory");
  assert.equal(statSync(projectOrderPath).mode & 0o777, 0o600);
  assert.equal(route("GET", "/api/session-groups"), undefined, "manual group routes removed");
  for (const body of [null, [], "bad", { title: "x" }, { pinned: 1 }, { customTitle: null },
    { customTitle: "😀".repeat(201) }, { groupId: "legacy" }]) invalid("PATCH", "/api/sessions/one", body);
  invalid("PATCH", "/api/sessions/missing", { pinned: true }, 404);
  for (const body of [null, [], {}, { path: a }, { path: a, before: b, after: hidden }, { path: a, before: b, extra: 1 },
    { path: a, before: 1 }, { path: "relative", after: b }, { path: a, before: "/unknown" },
    { path: "/" + "x".repeat(4096), after: b }, { path: a, after: b + "\0" }]) invalid("POST", "/api/project-order/move", body);
  const frames: any[] = [], transcriptEvents: unknown[] = [];
  manager.onEvent(event => transcriptEvents.push(event));
  const unsubscribe = manager.onOrganizationUpdated(frame => {
    const clients = ["one", "two", undefined].map(sessionId => ({ sessionId, lastSeq: new Map(), socket: {
      readyState: WebSocket.OPEN, bufferedAmount: 0, terminate() { assert.fail("unexpected terminate"); },
      send(value: string) { frames.push({ sessionId, value: JSON.parse(value) }); },
    } }));
    sendOrganizationUpdate(clients, frame);
  });
  const before = manager.getSnapshot("one")!;
  route("PATCH", "/api/sessions/one", { pinned: true, customTitle: "  自定😀  " });
  assert.equal(manager.get("one")!.title, "自定😀");
  assert.equal(manager.getSnapshot("one", true)!.session.title, "自定😀");
  assert.equal(manager.get("one")!.lastActivityAt, before.session.lastActivityAt);
  assert.deepEqual(manager.getSnapshot("one")!.events, before.events);
  assert.equal(transcriptEvents.length, 0);
  assert.equal(frames.length, 3, "all clients receive organization frame regardless of session subscription");
  assert.deepEqual(frames[0].value, JSON.parse(JSON.stringify(
    { type: "session_organization_updated", sessions: manager.list(), projectOrder: [a, hidden, b] })));
  assert.equal(frames[0].value.seq, undefined);
  assert.equal(frames[0].value.groups, undefined);
  route("POST", "/api/project-order/move", { path: `${b}//./`, before: a });
  assert.deepEqual(manager.listProjectOrder(), [b, a, hidden], "moving visible groups keeps other entries' relative order");
  route("POST", "/api/project-order/move", { path: b, after: a });
  assert.deepEqual(manager.listProjectOrder(), [a, b, hidden]);
  const count = frames.length;
  route("POST", "/api/project-order/move", { path: a, before: a });
  assert.equal(frames.length, count, "no-op does not broadcast");
  const clone = manager.listProjectOrder(); clone.reverse();
  assert.deepEqual(manager.listProjectOrder(), [a, b, hidden], "caller cannot mutate order");
  const added = await manager.create({ agent: "codex", cwd: c, config: {} });
  assert.deepEqual(manager.listProjectOrder(), [c, a, b, hidden]);
  assert(frames.at(-1).value.sessions.some((session: SessionRecord) => session.id === added.id));
  assert.deepEqual(frames.at(-1).value.projectOrder, [c, a, b, hidden]);
  await manager.create({ agent: "codex", cwd: a, config: {} });
  assert.deepEqual(manager.listProjectOrder(), [c, a, b, hidden], "creating in existing directory never moves it");
  assert.equal(readFileSync(legacyFile, "utf8"), "untouched legacy contents");
  unsubscribe();
  await manager.shutdown();
  manager = new SessionManager(factory);
  assert.equal(manager.get("one")!.pinned, true);
  assert.equal(manager.get("one")!.customTitle, "自定😀");
  assert.deepEqual(manager.listProjectOrder(), [c, a, b, hidden], "restart preserves explicit order");
  route("PATCH", "/api/sessions/one", { customTitle: " \n ", pinned: false });
  assert.equal(manager.get("one")!.customTitle, undefined);
  route("PATCH", "/api/sessions/one", { pinned: true });
  assert.equal(pruneStorage(30).expired, 2, "retention still protects legacy groupId and pinned records");
  const kept = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
  assert(kept.some((session: any) => session.id === "three" && session.groupId === "legacy"));
  const many = Array.from({ length: 501 }, (_, i) => `/project/${i}`);
  writeFileSync(`${projectOrderPath}.tmp`, "stale partial write", { mode: 0o644 });
  saveProjectOrder(many);
  assert.equal(existsSync(`${projectOrderPath}.tmp`), false, "tmp renamed atomically");
  assert.equal(statSync(projectOrderPath).mode & 0o777, 0o600, "pre-existing tmp permissions tightened");
  assert.deepEqual(loadProjectOrder([]), many.slice(0, 500));
  await manager.shutdown();
  manager = new SessionManager(factory);
  await manager.create({ agent: "codex", cwd: c, config: {} });
  assert.deepEqual(manager.listProjectOrder(), [c, ...many.slice(0, 499)], "new directory evicts only the oldest tail at the 500-item limit");
  assert.deepEqual(JSON.parse(readFileSync(projectOrderPath, "utf8")), manager.listProjectOrder());
  writeFileSync(projectOrderPath, '["relative"]');
  assert.throws(() => loadProjectOrder([]), /绝对路径/);
  writeFileSync(projectOrderPath, "[]");
  await manager.shutdown();

  const kimiId = "session_11111111-2222-4333-8444-555555555555";
  const kimiDir = join(kimiRoot, "wd_a_0", kimiId);
  mkdirSync(join(kimiDir, "agents", "main"), { recursive: true });
  writeFileSync(join(kimiDir, "agents", "main", "wire.jsonl"), "");
  writeFileSync(join(kimiDir, "state.json"), JSON.stringify({ id: kimiId, version: 2, cwd: a, custom: { keep: 1 } }), { mode: 0o600 });
  const released = (id: string, agent: SessionRecord["agent"], nativeSessionId: string, status: SessionRecord["status"] = "idle") =>
    ({ ...record(id, a, "2020-01-01"), agent, status, released: true, nativeSessionId });
  writeFileSync(join(home, "sessions.json"), JSON.stringify([
    released("claude", "claude", "aaaaaaaa-0000-4000-8000-000000000001"), released("codex", "codex", "bbbbbbbb-0000-4000-8000-000000000002"),
    released("kimi", "kimi", kimiId), released("forked-a", "codex", "cccccccc-0000-4000-8000-000000000003"),
    released("forked-b", "codex", "cccccccc-0000-4000-8000-000000000003"),
  ]));
  let starts: any[] = [];
  manager = new SessionManager((kind, options) => { starts.push(options); return factory(kind); });
  const move = (id: string, body: unknown) => manager.moveSession(id, body);
  await assert.rejects(move("codex", { cwd: a }), (error: any) => error.status === 400 && error.code === 40070, "same directory");
  await assert.rejects(move("codex", { cwd: join(home, "missing") }), (error: any) => error.status === 400);
  await assert.rejects(move("codex", { cwd: b, orderKey: "1" }), (error: any) => error.status === 400);
  await assert.rejects(move("codex", { cwd: "relative" }), (error: any) => error.status === 400);
  await assert.rejects(move("missing", { cwd: b }), (error: any) => error.status === 404);
  await assert.rejects(move("forked-a", { cwd: b }), /引用同一原生历史/, "shared native history stays put");
  const moved = await move("claude", { cwd: `${b}//`, orderKey: 42 });
  assert.equal(moved.cwd, b);
  assert.equal(moved.nativeCwd, a, "Claude/Codex native records keep their origin");
  assert.equal(moved.orderKey, 42);
  assert.equal(moved.orderActivity, moved.lastActivityAt);
  assert.equal((await move("claude", { cwd: c })).nativeCwd, a, "origin survives a second move");
  const back = await move("claude", { cwd: a });
  assert.equal(back.nativeCwd, a, "stays marked as moved so subagents spawned elsewhere remain visible");
  assert.equal(back.orderKey, undefined, "a move without a position returns to automatic order");
  const persist = (manager as any).persistRegistry;
  (manager as any).persistRegistry = () => { throw new Error("disk full"); };
  await assert.rejects(move("kimi", { cwd: b }), /disk full/);
  (manager as any).persistRegistry = persist;
  assert.equal(manager.get("kimi")!.cwd, a, "failed save restores the record");
  assert.equal(JSON.parse(readFileSync(join(kimiDir, "state.json"), "utf8")).cwd, a, "failed save restores Kimi state");
  (manager as any).persistRegistry = () => { throw new Error("disk full"); };
  const reader = (manager as any).nativeReader, transcriptPath = reader.transcriptPath;
  let lookups = 0; // 第二次核验发生在回滚时；让它失败即模拟回滚也失败。
  reader.transcriptPath = (session: SessionRecord) => ++lookups > 1 ? undefined : transcriptPath.call(reader, session);
  await assert.rejects(move("kimi", { cwd: b }), /disk full/);
  reader.transcriptPath = transcriptPath;
  (manager as any).persistRegistry = persist;
  assert.equal(manager.get("kimi")!.cwd, b, "a failed rollback keeps memory with Kimi's actual directory");
  assert.equal(JSON.parse(readFileSync(join(kimiDir, "state.json"), "utf8")).cwd, b);
  await move("kimi", { cwd: a });
  await move("codex", { cwd: b });
  const kimi = await move("kimi", { cwd: b });
  assert.equal(kimi.nativeCwd, undefined, "Kimi native state itself moved");
  assert.deepEqual(JSON.parse(readFileSync(join(kimiDir, "state.json"), "utf8")), { id: kimiId, version: 2, cwd: b, custom: { keep: 1 } });
  assert.equal(statSync(join(kimiDir, "state.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(kimiDir).sort(), ["agents", "state.json"], "no temporary file is left behind");
  await manager.shutdown();
  manager = new SessionManager((kind, options) => { starts.push(options); return factory(kind); });
  assert.equal(manager.get("codex")!.cwd, b, "move survives restart");
  assert.equal(manager.get("codex")!.nativeCwd, a);
  assert.equal(manager.get("kimi")!.status, "idle", "moved Kimi session still passes the native archive check");
  starts = [];
  await manager.sendUserMessage("codex", { text: "hi" });
  assert.equal(starts[0].cwd, b, "resume happens in the new directory");
  assert.equal(starts[0].nativeCwd, a);
  assert.equal(starts[0].resumeSessionId, "bbbbbbbb-0000-4000-8000-000000000002");
  const racing = [move("codex", { cwd: c }), move("codex", { cwd: join(home, "hidden") })];
  await assert.rejects(racing[1], SessionBusyError, "a second move cannot overtake the release of the first");
  const live = await racing[0];
  assert.equal(live.cwd, c);
  assert.equal(live.released, true, "an idle worker is released before the directory changes");
  (manager as any).sessions.get("codex").status = "running";
  await assert.rejects(move("codex", { cwd: b }), SessionBusyError, "a running turn is never interrupted");
  assert.equal(manager.get("codex")!.cwd, c);
  (manager as any).sessions.get("codex").status = "idle";
  const reimported = await manager.create({ agent: "codex", cwd: b, config: {}, resumeSessionId: "bbbbbbbb-0000-4000-8000-000000000002" });
  assert.equal(reimported.nativeCwd, a, "resuming a moved session from history keeps the native origin");
  assert.equal(starts.at(-1).nativeCwd, a);
  await manager.remove(reimported.id);
  const { HistoryIndex } = await import("./history.js");
  const index = new HistoryIndex({ roots: { claude: join(home, "none"), codex: join(home, "none"), kimi: join(home, "none"), workbenchRegistry: join(home, "sessions.json") } });
  await (index as any).loadWorkbenchSessionIds();
  assert.equal((index as any).movedCwds.get("codex:bbbbbbbb-0000-4000-8000-000000000002"), c, "history shows the moved directory");
  assert.equal((index as any).movedCwds.has("kimi:" + kimiId), false);
} finally { await manager.shutdown(); }
console.log("PASS: project order normalization, seed, strict validation, move, persistence/mode/limit, create registration, WS control frames, legacy retention and session moves");
