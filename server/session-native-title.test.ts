import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverOptions } from "./types.js";
import { sessionTitle } from "../shared/session-title.js";

const home = mkdtempSync(join(tmpdir(), "wb-native-title-"));
process.env.WORKBENCH_HOME = home;
const { SessionManager } = await import("./session-manager.js");
const callbacks = new Map<string, DriverOptions["callbacks"]>();
const factory = (kind: Driver["kind"], options: DriverOptions): Driver => {
  callbacks.set(options.sessionId, options.callbacks);
  return {
    kind,
    async start() { options.callbacks.status("idle"); },
    getConfigSchema: () => ({ source: "test", options: [] }),
    async setConfig(config) { return config; },
    async sendUserMessage() {},
    async resolvePermission() {},
    async interrupt() {},
    async stop() {},
  };
};

let manager = new SessionManager(factory);
const frames: any[] = [];
manager.onOrganizationUpdated(frame => frames.push(frame));
for (const agent of ["codex", "claude", "kimi"] as const) {
  const session = await manager.create({ agent, cwd: home, config: {} });
  await manager.sendUserMessage(session.id, { text: "请帮我阅读这个仓库并解决托盘没有入口的问题" });
  const before = manager.getSnapshot(session.id)!;
  const cb = callbacks.get(session.id)!;
  cb.metadata({ nativeTitle: "  修复托盘\n启动入口  " } as any);
  assert.equal(manager.get(session.id)!.title, "修复托盘 启动入口", `${agent}: native title replaces the first prompt`);
  assert.equal(frames.at(-1)?.sessions.find((s: any) => s.id === session.id)?.title, "修复托盘 启动入口");
  assert.equal(manager.get(session.id)!.seq, before.seq, "title changes do not advance the transcript");
  assert.equal(manager.get(session.id)!.lastActivityAt, before.session.lastActivityAt);
  assert.deepEqual(manager.getSnapshot(session.id)!.events, before.events);
  manager.updateOrganization(session.id, { customTitle: "我的手动标题" });
  cb.metadata({ nativeTitle: "更新后的原生标题" } as any);
  assert.equal(manager.get(session.id)!.title, "我的手动标题");
  manager.updateOrganization(session.id, { customTitle: "" });
  assert.equal(manager.getSnapshot(session.id, true)!.session.title, "更新后的原生标题");
  const frameCount = frames.length;
  for (const nativeTitle of ["", " \n ", null, 42, "更新后的原生标题"]) cb.metadata({ nativeTitle } as any);
  assert.equal(frames.length, frameCount, "invalid, empty, and repeated titles are ignored");
}
await manager.shutdown();
manager = new SessionManager(factory);
assert(manager.list().every(session => session.title === "更新后的原生标题"), "native titles survive restart");
assert.equal(sessionTitle({ nativeTitle: "原生摘要" } as any, [{ type: "user_message", payload: { text: "长输入" } }]), "原生摘要");
await manager.shutdown();
console.log("PASS: native title priority, live broadcast, manual override/reset, persistence, no transcript/activity changes");
