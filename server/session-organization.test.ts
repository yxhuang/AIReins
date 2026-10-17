import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Driver, SessionRecord } from "./types.js";
import { normalizeProjectPath } from "../shared/project-path.js";

const home = mkdtempSync(join(tmpdir(), "aireins-project-order-"));
process.env.WORKBENCH_HOME = home;
const { SessionManager } = await import("./session-manager.js");
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
const factory = (kind: Driver["kind"]): Driver => ({ kind, async start() {}, async stop() {},
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
} finally { await manager.shutdown(); }
console.log("PASS: project order normalization, seed, strict validation, move, persistence/mode/limit, create registration, WS control frames and legacy retention");
