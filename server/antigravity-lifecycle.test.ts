import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPowerOff } from "./power-off.js";
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
    setImmediate(() => {
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

const { getDispatch, listDispatches, listParentDispatches, countActiveDispatchesBySession } = await import("./dispatches.js");
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
const activeCounts = await countActiveDispatchesBySession([session], dispatchRoot);
assert.equal(activeCounts.get(session.id), 2, "按会话聚合统计全部运行中外部派单");

const freshRoot = join(root, "fresh-delegate");
await mkdir(freshRoot);
assert.equal((await countActiveDispatchesBySession([session], freshRoot)).size, 0);
const freshRun = join(freshRoot, "20261116-010000-codex-fresh-child");
await mkdir(freshRun);
await writeFile(join(freshRun, "run.json"), JSON.stringify({ schema: 1, status: "running", pid: process.pid,
  parent: { agent: "antigravity", sessionId: session.id } }));
await mkdir(join(freshRun, "stderr.log"));
await mkdir(join(freshRun, "prompt.txt"));
await mkdir(join(freshRun, "last.txt"));
await mkdir(join(freshRoot, "20261116-010001-kimi-missing-run"));
assert.equal((await countActiveDispatchesBySession([session], freshRoot)).size, 0, "常规扫描仍命中空缓存");
assert.equal((await countActiveDispatchesBySession([session], freshRoot, { fresh: true })).get(session.id), 1);
assert.equal((await listDispatches(null, freshRoot)).find(run => run.tool === "codex")?.status, "running");
assert.equal((await getDispatch("20261116-010000-codex-fresh-child", freshRoot))?.status, "running");
await assert.rejects(countActiveDispatchesBySession([session], join(freshRun, "run.json"), { fresh: true }), { code: "ENOTDIR" });

const loopRoot = join(root, "loop-delegate");
const loopRun = "20261116-010000-kimi-loop-child";
await mkdir(loopRoot);
await symlink(loopRun, join(loopRoot, loopRun));
assert.deepEqual(await listDispatches(null, loopRoot), []);
await assert.rejects(countActiveDispatchesBySession([session], loopRoot, { fresh: true }), { code: "ELOOP" });

const unreadableRoot = join(root, "unreadable-delegate");
const unreadableRun = "20261116-010000-kimi-unreadable-child";
await mkdir(join(unreadableRoot, unreadableRun, "run.json"), { recursive: true });
const protectedScan = assert.rejects(
  countActiveDispatchesBySession([session], unreadableRoot, { fresh: true }), /普通文件|EISDIR/,
);
const [tolerantRuns] = await Promise.all([listDispatches(null, unreadableRoot), protectedScan]);
assert.equal(tolerantRuns.find(run => run.runId === unreadableRun)?.status, "unknown");

let checks = 0;
const commands: string[][] = [];
const powerOff = createPowerOff({
  busy: () => 0,
  checkBusy() {
    const error = new Error("fresh scan failed");
    if (++checks === 1) throw error;
    return Promise.reject(error);
  },
  async run(args) { commands.push(args); },
  pollMs: 5,
});
try {
  assert.equal((await powerOff.request()).state, "waiting");
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.ok(checks > 1, "等待期间也执行新鲜扫描");
  assert.equal(powerOff.status().state, "waiting");
  assert.deepEqual(commands, []);
} finally { await powerOff.cancel(); }

// 活跃派单计数不落盘，但体现在 list/get/snapshot 中，并阻止手动与自动释放误杀父会话；同时校验每回合顺序与 durationMs 落盘
const timed = manager();
const timedSession = await timed.create({ agent: "antigravity", cwd: root, snapshot: "skip" });
await timed.sendUserMessage(timedSession.id, { text: "timed turn" });
await new Promise<void>(resolve => setImmediate(resolve));
const timedEvents = timed.getSnapshot(timedSession.id)!.events;
const timedUser = timedEvents.find(event => event.type === "user_message");
const timedTurn = timedEvents.find(event => event.type === "turn_completed");
assert.ok(timedUser && timedTurn && timedUser.seq < timedTurn.seq, "user_message 应先于 turn_completed 落盘");
assert.ok(typeof timedTurn.payload.durationMs === "number" && timedTurn.payload.durationMs >= 0,
  "SessionManager 应为缺少 durationMs 的 turn_completed 自动记录非负回合耗时");
assert.equal(timed.setActiveDispatchCounts(new Map([[timedSession.id, 2]])), true);
assert.equal(timed.setActiveDispatchCounts(new Map([[timedSession.id, 2]])), false);
assert.equal(timed.get(timedSession.id)!.activeDispatchCount, 2);
assert.equal(timed.list().find(item => item.id === timedSession.id)!.activeDispatchCount, 2);
assert.equal(timed.getSnapshot(timedSession.id, true)!.session.activeDispatchCount, 2);
// 有活跃派单时，手动释放与空闲自动释放均拒绝
await assert.rejects(() => timed.release(timedSession.id, "manual"), /后台任务/);
await timed.releaseIdleSessions(1, new Date(Date.now() + 10 * 60_000));
assert.equal(timed.get(timedSession.id)!.released, undefined, "有运行中派单时不得空闲释放父会话");
assert.equal(timed.setActiveDispatchCounts(new Map()), true);
assert.equal(timed.get(timedSession.id)!.activeDispatchCount, undefined);
await timed.releaseIdleSessions(1, new Date(Date.now() + 10 * 60_000));
assert.equal(timed.get(timedSession.id)!.released, true, "派单结束后可正常空闲释放");
await timed.shutdown();
console.log("PASS: Antigravity 跨 CLI 派单归属、运行态计数保活与每回合耗时记录");
