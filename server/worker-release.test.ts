import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentKind,
  Driver,
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  SessionConfig,
  UnifiedEvent,
  UserMessageInput,
} from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-worker-release-"));
process.env.WORKBENCH_HOME = join(fixture, "workbench");
const claudeRoot = join(fixture, "claude", "projects");
const claudeId = "aaaaaaaa-1111-4111-8111-111111111111";
const claudePath = join(claudeRoot, "project", `${claudeId}.jsonl`);
await mkdir(join(claudePath, ".."), { recursive: true });
await writeFile(claudePath, `${[
  JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "初始问题" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "初始回答" }] } }),
].join("\n")}\n`);
const quoteCwd = join(fixture, "it's-here");
await mkdir(quoteCwd);

const [{ SessionManager }, { NativeConversationReader }, { loadRegistry }] = await Promise.all([
  import("./session-manager.js"),
  import("./native-conversation.js"),
  import("./persistence.js"),
]);

const schema: DriverConfigSchema = {
  source: "fixture",
  options: [
    { id: "permissionMode", name: "审批模式", values: [{ value: "manual", label: "manual" }], default: "manual", mutable: true },
  ],
};

class FakeDriver implements Driver {
  sent: UserMessageInput[] = [];
  stopped = false;
  constructor(readonly kind: AgentKind, readonly options: DriverOptions, readonly failStart = false) {}
  async start(): Promise<void> {
    if (this.failStart) throw new Error("fixture start failed");
    this.options.callbacks.metadata({
      ...(this.options.resumeSessionId ? { nativeSessionId: this.options.resumeSessionId } : {}),
      ...(this.kind === "claude" ? { nativeTranscriptPath: claudePath } : {}),
    });
    this.options.callbacks.status("idle");
  }
  getConfigSchema(): DriverConfigSchema { return schema; }
  async setConfig(config: SessionConfig): Promise<SessionConfig> { return config; }
  async setRemoteControl(enabled: boolean) {
    const state = enabled
      ? { status: "connected" as const, sessionUrl: "https://claude.ai/code/session_test" }
      : { status: "disconnected" as const };
    this.options.callbacks.metadata({ remoteControl: state });
    return state;
  }
  async sendUserMessage(message: UserMessageInput): Promise<void> {
    this.sent.push(message);
    this.options.callbacks.status("running");
  }
  async resolvePermission(_requestId: string, _decision: PermissionDecision): Promise<void> {}
  async interrupt(): Promise<void> { this.options.callbacks.status("idle"); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.options.callbacks.exited({ code: 0, signal: null, expected: true });
  }
  finish(): void {
    this.options.callbacks.emit("turn_completed", {});
    this.options.callbacks.status("idle");
  }
  requestApproval(requestId: string): void {
    this.options.callbacks.emit("permission_request", { requestId, gate: "fixture", toolName: "Bash" });
  }
}

function harness(shouldFail: () => boolean = () => false) {
  const instances: FakeDriver[] = [];
  const events: UnifiedEvent[] = [];
  const manager = new SessionManager(
    (agent, options) => {
      const driver = new FakeDriver(agent, options, shouldFail());
      instances.push(driver);
      return driver;
    },
    () => ({ model: null, effort: null }),
    async () => null,
    new NativeConversationReader({
      claude: claudeRoot,
      codex: join(fixture, "codex-missing"),
      kimi: join(fixture, "kimi-missing"),
    }),
  );
  manager.onEvent((event) => events.push(event));
  return { manager, instances, events };
}

async function pendingMarks(manager: InstanceType<typeof SessionManager>, id: string): Promise<void> {
  await (manager as unknown as { pendingMarkReads: Map<string, Promise<void>> }).pendingMarkReads.get(id);
}

// ── 1. 手动释放：worker 停止、状态保持 idle、exited 不标 dead、注册表持久化 ──
{
  const { manager, instances, events } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  const result = await manager.release(session.id, "manual");
  assert.equal(result.resumeCommand, `cd '${fixture}' && claude --resume ${claudeId}`);
  assert.equal(result.session.released, true);
  assert.equal(instances[0]!.stopped, true);
  const after = manager.get(session.id)!;
  assert.equal(after.status, "idle");
  assert.equal(after.released, true);
  assert.equal(after.processId, undefined);
  assert.equal(after.remoteControl?.status, "disconnected");
  assert.equal(events.some((event) => event.type === "process_exited"), false, "释放触发的 exited 不得标 dead");
  const releasedEvent = events.find((event) => event.type === "worker_released")!;
  assert.equal(releasedEvent.payload.reason, "manual");
  assert.equal(releasedEvent.payload.resumeCommand, result.resumeCommand);
  assert.ok(events.some((event) => event.type === "remote_control_updated" && event.payload.status === "disconnected"));
  const stored = loadRegistry().find((record) => record.id === session.id)!;
  assert.equal(stored.released, true, "released 须写入注册表");
  assert.equal(stored.status, "idle");
  await assert.rejects(() => manager.release(session.id, "manual"), /已释放/);
  await assert.rejects(() => manager.interrupt(session.id), /已释放/);
  await assert.rejects(() => manager.resolvePermission(session.id, "r1", "allow"), /已释放/);
  await manager.shutdown();
  // 服务重启：所有会话载入为 dead，已释放标记不再保留
  const reloaded = harness().manager.get(session.id)!;
  assert.equal(reloaded.status, "dead");
  assert.equal(reloaded.released, undefined);
}

// ── 2. 释放后发送：以同一原生 ID 起新 worker 并发出消息，清掉 released ──
{
  const { manager, instances, events } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  await manager.sendUserMessage(session.id, { text: "释放后发送" });
  assert.equal(instances.length, 2);
  assert.equal(instances[1]!.options.resumeSessionId, claudeId);
  assert.deepEqual(instances[1]!.sent.map((message) => message.text), ["释放后发送"]);
  assert.equal(manager.get(session.id)!.released, undefined);
  assert.equal(events.some((event) => event.type === "external_messages_added"), false);
  await manager.shutdown();
}

// ── 3. 释放期间原生记录有外部新增：先广播 external_messages_added 再发本轮消息 ──
{
  const { manager, instances, events } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  await appendFile(claudePath, `${[
    JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "别处问题" } }),
    JSON.stringify({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "别处回答" }] } }),
  ].join("\n")}\n`);
  await manager.sendUserMessage(session.id, { text: "回来继续" });
  assert.equal(instances.length, 2);
  const externalAt = events.findIndex((event) => event.type === "external_messages_added");
  const userAt = events.findIndex((event) => event.type === "user_message" && event.payload.text === "回来继续");
  assert.ok(externalAt >= 0 && userAt > externalAt, "external_messages_added 必须排在本轮 user_message 前");
  const messages = events[externalAt]!.payload.messages as Array<{ role: string; text?: string }>;
  assert.deepEqual(messages.map((message) => `${message.role}:${message.text ?? ""}`), ["user:别处问题", "assistant:别处回答"]);
  await manager.shutdown();
}

// ── 4. 手动释放的可读错误：running / 待处理闸门 / 无原生 id ──
{
  const { manager, instances } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "进行中" });
  await assert.rejects(() => manager.release(session.id, "manual"), /空闲/);
  instances.at(-1)!.finish();
  instances.at(-1)!.requestApproval("gate-1");
  await assert.rejects(() => manager.release(session.id, "manual"), /闸门/);
  await manager.resolvePermission(session.id, "gate-1", "allow");
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  assert.equal(manager.get(session.id)!.released, true);
  const fresh = await manager.create({ agent: "claude", cwd: fixture, snapshot: "skip" });
  await assert.rejects(() => manager.release(fresh.id, "manual"), /原生会话 id/);
  await manager.shutdown();
}

// ── 5. 空闲自动释放：跳过 running / 待处理闸门 / RC 已连接 / 未到时间 / N=0 ──
{
  const { manager, instances, events } = harness();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const records = (manager as unknown as { sessions: Map<string, { lastActivityAt: string }> }).sessions;
  const releasable = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  const running = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(running.id, { text: "进行中" });
  const gated = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  instances.at(-1)!.requestApproval("gate-idle");
  const remoteControlled = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.setRemoteControl(remoteControlled.id, true);
  const recent = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  for (const id of [releasable.id, running.id, gated.id, remoteControlled.id]) {
    records.get(id)!.lastActivityAt = old;
  }
  await manager.releaseIdleSessions(30);
  assert.equal(manager.get(releasable.id)!.released, true, "空闲超时须释放");
  assert.equal(manager.get(running.id)!.released, undefined, "running 跳过");
  assert.equal(manager.get(gated.id)!.released, undefined, "待处理闸门跳过");
  assert.equal(manager.get(remoteControlled.id)!.released, undefined, "RC 已连接跳过");
  assert.equal(manager.get(recent.id)!.released, undefined, "未到时间跳过");
  const idleEvent = events.find((event) => event.type === "worker_released" && event.sessionId === releasable.id)!;
  assert.equal(idleEvent.payload.reason, "idle");
  assert.equal(idleEvent.payload.idleMinutes, 30);
  // N=0 整体关闭
  records.get(recent.id)!.lastActivityAt = old;
  await manager.releaseIdleSessions(0);
  assert.equal(manager.get(recent.id)!.released, undefined, "N=0 时不释放");
  await manager.releaseIdleSessions(30);
  assert.equal(manager.get(recent.id)!.released, true, "到时间后释放");
  await manager.shutdown();
}

// ── 6. setConfig / setRemoteControl 在 released 会话上先拉起 worker（ensureWorker）──
{
  const { manager, instances } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  await manager.setConfig(session.id, { permissionMode: "manual" });
  assert.equal(instances.length, 2, "setConfig 须先拉起 worker");
  assert.equal(manager.get(session.id)!.released, undefined);
  await manager.release(session.id, "manual");
  await manager.setRemoteControl(session.id, true);
  assert.equal(instances.length, 3, "setRemoteControl 须先拉起 worker");
  assert.equal(manager.get(session.id)!.remoteControl?.status, "connected");
  await manager.shutdown();
}

// ── 7. 释放后续接失败：广播 session_error、保持 released 与 idle，可重试 ──
{
  let failNext = false;
  const { manager, instances, events } = harness(() => {
    const fail = failNext;
    failNext = false;
    return fail;
  });
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  failNext = true;
  await assert.rejects(() => manager.sendUserMessage(session.id, { text: "会失败" }), /重新续接失败/);
  const after = manager.get(session.id)!;
  assert.equal(after.released, true, "续接失败保持 released");
  assert.equal(after.status, "idle", "续接失败不标 dead/error");
  const errorEvent = events.at(-1)!;
  assert.equal(errorEvent.type, "session_error");
  assert.equal(errorEvent.payload.source, "external_resume");
  await manager.sendUserMessage(session.id, { text: "重试" });
  assert.equal(instances.at(-1)!.sent.at(-1)!.text, "重试");
  assert.equal(manager.get(session.id)!.released, undefined);
  await manager.shutdown();
}

// ── 8. resumeCommand 的引号转义与三家命令形状 ──
{
  const { manager } = harness();
  const codex = await manager.create({ agent: "codex", cwd: quoteCwd, resumeSessionId: "codex-native-1", snapshot: "skip" });
  const codexResult = await manager.release(codex.id, "manual");
  assert.equal(codexResult.resumeCommand, `cd '${quoteCwd.replaceAll("'", "'\\''")}' && codex resume codex-native-1`);
  const kimi = await manager.create({ agent: "kimi", cwd: fixture, resumeSessionId: "session_kimi_1", snapshot: "skip" });
  const kimiResult = await manager.release(kimi.id, "manual");
  assert.equal(kimiResult.resumeCommand, `cd '${fixture}' && kimi -S session_kimi_1`);
  await manager.shutdown();
}

await rm(fixture, { recursive: true, force: true });
console.log("worker release tests passed");
