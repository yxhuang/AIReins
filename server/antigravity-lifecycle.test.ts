import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverConfigSchema, DriverOptions, SessionConfig, UserMessageInput } from "./types.js";

const root = await mkdtemp(join(tmpdir(), "aireins-antigravity-lifecycle-"));
process.env.WORKBENCH_HOME = join(root, "workbench");
for (const agent of ["CLAUDE", "CODEX", "KIMI"]) process.env[`WORKBENCH_${agent}_HISTORY_DIR`] = join(root, agent);
const { SessionManager } = await import("./session-manager.js");
const nativeSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
const instances: FakeDriver[] = [];
class FakeDriver implements Driver {
  readonly kind = "antigravity" as const;
  stopped = false;
  readonly sent: UserMessageInput[] = [];
  constructor(readonly options: DriverOptions) {}
  async start(): Promise<void> {
    this.options.callbacks.metadata({ nativeSessionId: this.options.resumeSessionId ?? nativeSessionId,
      config: { model: "gemini-3.8-flash", effort: "low", permissionMode: "default" } });
    this.options.callbacks.status("idle");
  }
  getConfigSchema(): DriverConfigSchema { return { options: [], source: "Antigravity fixture" }; }
  async setConfig(config: SessionConfig): Promise<SessionConfig> { return config; }
  async sendUserMessage(message: UserMessageInput): Promise<void> {
    assert.equal(this.stopped, false);
    this.sent.push(message);
    this.options.callbacks.status("running");
    queueMicrotask(() => {
      this.options.callbacks.emit("agent_text_delta", { text: "fixture reply" });
      this.options.callbacks.emit("turn_completed", { stopReason: "end_turn" });
      this.options.callbacks.status("idle");
    });
  }
  async resolvePermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; }
}
function manager() {
  return new SessionManager((agent, options) => {
    assert.equal(agent, "antigravity");
    const driver = new FakeDriver(options); instances.push(driver); return driver;
  });
}
const first = manager();
const session = await first.create({ agent: "antigravity", cwd: root, snapshot: "skip" });
await first.sendUserMessage(session.id, { text: "first turn" });
await new Promise<void>(resolve => setImmediate(resolve));
const released = await first.release(session.id, "manual");
assert.equal(released.session.released, true);
assert.match(released.resumeCommand, /agy --conversation aaaaaaaa-1111-4111-8111-111111111111$/);
assert.equal(instances[0].stopped, true);
await first.sendUserMessage(session.id, { text: "resume turn" });
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(instances[1].options.resumeSessionId, nativeSessionId);
assert.equal(first.getSnapshot(session.id)!.events.filter(event => event.type === "user_message").length, 2);
await first.shutdown();
const restored = manager();
assert.equal(restored.get(session.id)!.status, "idle");
assert.equal(restored.get(session.id)!.released, true);
await restored.sendUserMessage(session.id, { text: "after backend restart" });
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(instances.at(-1)!.options.resumeSessionId, nativeSessionId);
assert.equal(restored.getSnapshot(session.id)!.events.filter(event => event.type === "user_message").length, 3);
await restored.shutdown();
console.log("PASS: Antigravity 会话释放、终端续接命令、发送时恢复与正常重启后的历史保存");

const { listParentDispatches } = await import("./dispatches.js");
const dispatchRoot = join(root, "delegate");
for (const tool of ["codex", "kimi"]) {
  const directory = join(dispatchRoot, `20261116-010000-${tool}-antigravity-child`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.json"), JSON.stringify({ schema: 1, status: "running", pid: process.pid,
    startedAt: new Date().toISOString(), parent: { agent: "antigravity", sessionId: session.id, entrypoint: "workbench" } }));
}
for (const id of [session.id, nativeSessionId]) {
  const dispatches = await listParentDispatches(id, dispatchRoot, "antigravity", () => [session]);
  assert.deepEqual(dispatches.map(run => run.tool).sort(), ["codex", "kimi"], "Antigravity 主会话的 AIReins ID 和原生 ID 共用派单归属");
}
console.log("PASS: Antigravity 跨 CLI 派单保留父节点和会话 ID 别名");
