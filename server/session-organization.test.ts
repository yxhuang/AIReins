import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { SessionRecord } from "./types.js";

const home = mkdtempSync(join(tmpdir(), "wb-session-organization-"));
process.env.WORKBENCH_HOME = home;
const { SessionManager } = await import("./session-manager.js");
const { organizationRoute } = await import("./session-organization-routes.js");
const { sendOrganizationUpdate } = await import("./session-organization.js");
const { pruneStorage } = await import("./persistence.js");
const record = (id: string): SessionRecord => ({ id, agent: "codex", agentId: "main", cwd: home,
  status: "dead", config: {}, riskyMode: false, createdAt: "2020-01-01T00:00:00.000Z",
  lastActivityAt: "2020-01-01T00:00:00.000Z", seq: 0, transcriptPath: join(home, "transcripts", `${id}.ndjson`) });
writeFileSync(join(home, "sessions.json"), JSON.stringify([record("one"), record("two"), record("three")]));
let manager = new SessionManager();
const route = (method: string, path: string, body?: unknown) => organizationRoute(manager, method, path, body)!;
const invalid = (method: string, path: string, body: unknown, status = 400) => assert.throws(
  () => route(method, path, body), (error: any) => error.status === status);
const base = "/api/sessions/one";
try {
  assert.deepEqual(route("GET", "/api/session-groups"), { status: 200, data: { groups: [] } });
  for (const body of [null, [], "bad", { title: "x" }, { pinned: 1 }, { customTitle: null },
    { customTitle: "😀".repeat(201) }, { groupId: false }, { groupId: "missing" }, { groupId: "" }]) invalid("PATCH", base, body);
  for (const body of [null, [], { name: " " }, { name: 1 }, { name: "x", unknown: true }, { name: "x".repeat(201) }]) {
    invalid("POST", "/api/session-groups", body);
  }
  const created = route("POST", "/api/session-groups", { name: "  研究  " });
  assert.equal(created.status, 201);
  const group = (created.data as any).group;
  assert.equal(group.name, "研究"); assert.equal(typeof group.id, "string"); assert(Number.isFinite(Date.parse(group.createdAt)));
  assert(existsSync(join(home, "session-groups.json")));
  invalid("PATCH", `/api/session-groups/${group.id}`, { name: "" });
  invalid("PATCH", "/api/session-groups/missing", { name: "x" }, 404);
  invalid("DELETE", "/api/session-groups/missing", undefined, 404);
  invalid("PATCH", "/api/sessions/missing", { pinned: true }, 404);
  const transcriptBefore = manager.getSnapshot("one")!;
  const activity = manager.get("one")!.lastActivityAt;
  const frames: any[] = [], transcriptEvents: unknown[] = [];
  manager.onEvent(event => transcriptEvents.push(event));
  const unsubscribe = manager.onOrganizationUpdated(frame => {
    const clients = ["one", "two", undefined].map(sessionId => ({ sessionId, lastSeq: new Map(), socket: {
      readyState: WebSocket.OPEN, bufferedAmount: 0, terminate() { assert.fail("unexpected terminate"); },
      send(value: string) { frames.push({ sessionId, value: JSON.parse(value) }); },
    } }));
    sendOrganizationUpdate(clients, frame);
  });
  const updated = route("PATCH", base, { pinned: true, customTitle: "  自定😀  ", groupId: group.id });
  assert.equal(updated.status, 200);
  assert.equal((updated.data as any).session.customTitle, "自定😀");
  assert.equal((updated.data as any).session.title, "自定😀");
  assert.equal(manager.list().find(session => session.id === "one")!.title, "自定😀");
  assert.equal(manager.getSnapshot("one", true)!.session.title, "自定😀");
  assert.equal(manager.get("one")!.lastActivityAt, activity);
  assert.deepEqual(manager.getSnapshot("one")!.events, transcriptBefore.events);
  assert.equal(transcriptEvents.length, 0);
  assert.equal(frames.length, 3, "all open pages receive control frames regardless of session subscription");
  // 帧在线上走 JSON：undefined 值键不会上线，期望端同样过一遍 JSON 往返再比
  assert.deepEqual(frames[0].value, JSON.parse(JSON.stringify(
    { type: "session_organization_updated", sessions: manager.list(), groups: manager.listGroups() })));
  assert.equal(frames[1].value.type, "session_organization_updated");
  assert.equal(frames[0].value.seq, undefined);
  unsubscribe();
  route("PATCH", "/api/sessions/two", { groupId: group.id, customTitle: "😀".repeat(200) });
  route("PATCH", `/api/session-groups/${group.id}`, { name: "  完成  " });
  assert.equal(manager.listGroups()[0].name, "完成");
  const clone = manager.listGroups(); clone[0].name = "cannot mutate";
  assert.equal(manager.listGroups()[0].name, "完成");
  await manager.shutdown();
  manager = new SessionManager();
  assert.equal(manager.get("one")!.pinned, true);
  assert.equal(manager.get("one")!.customTitle, "自定😀");
  assert.equal(manager.get("two")!.groupId, group.id);
  assert.equal(manager.listGroups()[0].name, "完成");
  route("PATCH", base, { customTitle: " \n ", pinned: false, groupId: null });
  assert.equal(manager.get("one")!.customTitle, undefined, "empty title restores automatic title");
  assert.equal(manager.list().find(session => session.id === "one")!.title, "新会话");
  assert.equal(manager.get("one")!.groupId, undefined);
  route("PATCH", base, { groupId: group.id });
  const removed = route("DELETE", `/api/session-groups/${group.id}`);
  assert.deepEqual(removed, { status: 200, data: { groups: [] } });
  assert.equal(manager.get("one")!.groupId, undefined);
  assert.equal(manager.get("two")!.groupId, undefined);
  await manager.shutdown(); manager = new SessionManager();
  assert.deepEqual(manager.listGroups(), []);
  assert.equal(manager.get("two")!.groupId, undefined);
  const saved = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
  assert.equal(saved.some((session: any) => Object.hasOwn(session, "groupId")), false);
  const kept = route("POST", "/api/session-groups", { name: "持久分组" }).data as any;
  route("PATCH", base, { pinned: true });
  route("PATCH", "/api/sessions/two", { groupId: kept.group.id });
  assert.equal(pruneStorage(30).expired, 1, "automatic retention preserves deliberately organized sessions");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")).map((session: any) => session.id).sort(), ["one", "two"]);
} finally { await manager.shutdown(); }
console.log("✅ Session organization: PATCH validation, group contracts, atomic persistence/restart, title reset, member return, WS synchronization and retention");
