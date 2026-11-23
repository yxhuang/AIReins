import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPowerOff } from "./power-off.js";
import type { AgentKind, Driver, DriverConfigSchema, DriverOptions, SessionConfig, SessionRecord, UnifiedEvent, UserMessageInput } from "./types.js";

const root = await mkdtemp(join(tmpdir(), "aireins-antigravity-lifecycle-"));
process.env.WORKBENCH_HOME = join(root, "workbench");
const brain = process.env.WORKBENCH_ANTIGRAVITY_BRAIN_DIR = join(root, "antigravity-brain");
for (const agent of ["CLAUDE", "CODEX", "KIMI"]) process.env[`WORKBENCH_${agent}_HISTORY_DIR`] = join(root, agent);
const { SessionManager } = await import("./session-manager.js");
const { saveRegistry, transcriptPathFor } = await import("./persistence.js");
const nativeSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
const instances: FakeDriver[] = [];
class FakeDriver implements Driver {
  stopped = false;
  readonly sent: UserMessageInput[] = [];
  constructor(readonly kind: AgentKind, readonly options: DriverOptions, private readonly id: string) {}
  async start(): Promise<void> {
    this.options.callbacks.metadata({ nativeSessionId: this.options.resumeSessionId ?? this.id,
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
function manager(bootTime?: number) {
  return new SessionManager((agent, options) => {
    const driver = new FakeDriver(agent, options, instances.length ? `fixture-${instances.length}` : nativeSessionId);
    instances.push(driver);
    return driver;
  }, () => ({ model: null, effort: null }), undefined, undefined, undefined,
  bootTime === undefined ? undefined : () => bootTime);
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

{
  const live = manager();
  const create = async (agent: AgentKind) => {
    const record = await live.create({ agent, cwd: root, snapshot: "skip" });
    return { id: record.id, driver: instances.at(-1)! };
  };
  const idle = await create("antigravity");
  const next = await create("antigravity");
  const running = await create("antigravity");
  running.driver.options.callbacks.status("running");
  const dispatch = await create("antigravity");
  live.setActiveDispatchCounts(new Map([[dispatch.id, 1]]));
  const gated = await create("antigravity");
  gated.driver.options.callbacks.emit("permission_request", { requestId: "approval", gate: "fixture", toolName: "fixture" });
  const unprompted = await create("claude");
  const connected = await create("claude");
  await live.sendUserMessage(connected.id, { text: "prompted Claude" });
  await new Promise<void>(resolve => setImmediate(resolve));
  connected.driver.options.callbacks.metadata({ remoteControl: { status: "connected" } });
  assert.equal(live.get(connected.id)?.remoteControl?.status, "connected");

  await live.releaseSessionsForPowerOff(() => idle.driver.stopped);
  assert.equal(live.get(idle.id)?.released, true);
  assert.equal(next.driver.stopped, false, "cancellation stops the loop before releasing the next worker");
  assert.equal(connected.driver.stopped, false);

  await live.releaseSessionsForPowerOff();
  for (const { id, driver } of [idle, next, connected]) {
    assert.equal(driver.stopped, true);
    const record = live.get(id)!;
    assert.equal(record.status, "idle");
    assert.equal(record.released, true);
    const lines = (await readFile(record.transcriptPath, "utf8")).trimEnd().split("\n");
    const events = lines.map(line => JSON.parse(line) as UnifiedEvent).filter(event => event.type === "worker_released");
    assert.deepEqual(events.map(event => event.payload.reason), ["shutdown"]);
  }
  assert.equal(live.get(connected.id)?.remoteControl?.status, "disconnected");
  for (const { id, driver } of [running, dispatch, gated, unprompted]) {
    assert.equal(driver.stopped, false, id);
    assert.equal(live.get(id)?.released, undefined, id);
  }
  // Load the persisted state directly, without the normal shutdown path or a native brain archive.
  const afterPowerOff = manager();
  assert.equal(afterPowerOff.get(idle.id)?.status, "idle");
  assert.equal(afterPowerOff.get(idle.id)?.released, true);
  assert.ok(afterPowerOff.getSnapshot(idle.id)!.events.some(event =>
    event.type === "worker_released" && event.payload.reason === "shutdown"));
  await live.shutdown();
}

{
  const timestamp = "2020-01-01T00:00:00.000Z";
  const bootTime = Date.parse(timestamp) + 60_000;
  const fixtures: Array<{ record: SessionRecord; valid: boolean }> = [];
  for (const status of ["idle", "dead"] as const) {
    for (const archive of ["valid", "missing", "corrupt"] as const) {
      const id = `power-off-${status}-${archive}`;
      const transcriptPath = transcriptPathFor(id);
      const record: SessionRecord = {
        id, agent: "antigravity", agentId: "main", cwd: root, config: {}, riskyMode: false,
        status, nativeSessionId: id, seq: 1, transcriptPath, createdAt: timestamp, lastActivityAt: timestamp,
        ...(status === "idle" ? { processId: process.pid,
          processIdentity: { bootId: "00000000-0000-0000-0000-000000000000", startTime: "1" } } : {}),
      };
      const event: UnifiedEvent = {
        type: "user_message", sessionId: id, agentId: "main", seq: 1, timestamp, payload: { text: "before power loss" },
      };
      await writeFile(transcriptPath, JSON.stringify(event) + "\n");
      if (archive !== "missing") {
        const native = join(brain, id, ".system_generated", "logs", "transcript.jsonl");
        await mkdir(dirname(native), { recursive: true });
        await writeFile(native, archive === "valid" ? '{"type":"USER_INPUT","text":"before power loss"}\n' : "{broken}\n");
      }
      fixtures.push({ record, valid: archive === "valid" });
    }
  }
  saveRegistry(fixtures.map(({ record }) => record));
  const recovered = manager(bootTime);
  for (const { record, valid } of fixtures) {
    assert.equal(recovered.get(record.id)?.status, valid ? "idle" : "dead", record.id);
    assert.equal(recovered.get(record.id)?.released, valid ? true : undefined, record.id);
    if (!valid) continue;
    await recovered.sendUserMessage(record.id, { text: "resume after power loss" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(instances.at(-1)!.options.resumeSessionId, record.nativeSessionId);
    assert.equal(instances.at(-1)!.sent[0]?.text, "resume after power loss");
  }
  await recovered.shutdown();
}
console.log("PASS: power-off worker release and Antigravity crash/reboot recovery");
