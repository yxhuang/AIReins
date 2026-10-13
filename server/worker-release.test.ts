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

const [{ SessionManager, buildVSCodeUri }, { NativeConversationReader }, { loadRegistry }] = await Promise.all([
  import("./session-manager.js"),
  import("./native-conversation.js"),
  import("./persistence.js"),
]);

const uriCwd = "/home/user/projects/space dir";
assert.equal(buildVSCodeUri({ agent: "claude", nativeSessionId: claudeId, cwd: uriCwd }, ""), `vscode://anthropic.claude-code/open?session=${claudeId}`);
for (const agent of ["codex", "kimi"] as const) {
  assert.equal(buildVSCodeUri({ agent, cwd: uriCwd }, "ubuntu"), "vscode://vscode-remote/wsl+ubuntu/home/user/projects/space%20dir");
  assert.equal(buildVSCodeUri({ agent, cwd: uriCwd }, "", "wsl"), null);
}
assert.equal(buildVSCodeUri({ agent: "claude", cwd: uriCwd }, "ubuntu"), null);

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
  assert.equal(result.vscodeUri, `vscode://anthropic.claude-code/open?session=${claudeId}`);
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
  // 服务重启：已释放且有原生 id 的会话载入为 idle+released（下次发送原地续接）
  const reloaded = harness().manager.get(session.id)!;
  assert.equal(reloaded.status, "idle");
  assert.equal(reloaded.released, true);
}

// ── 1b. 退出 AIReins：活会话按释放处理，重启后发送以同一原生 ID 原地续接；没有原生 ID 的标 dead ──
{
  const { manager, instances, events } = harness();
  const live = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(live.id, { text: "第一轮" });
  instances[0]!.finish();
  await pendingMarks(manager, live.id);
  const fresh = await manager.create({ agent: "codex", cwd: fixture, snapshot: "skip" });
  // Claude 首条消息前就报 session_id，但原生存档未落盘：不能按释放处理
  const unprompted = await manager.create({ agent: "claude", cwd: fixture, snapshot: "skip" });
  instances.at(-1)!.options.callbacks.metadata({ nativeSessionId: "bbbbbbbb-2222-4222-8222-222222222222" });
  await manager.shutdown();
  await assert.rejects(() => manager.create({ agent: "codex", cwd: fixture, snapshot: "skip" }), /正在退出/);
  // 停服期间在 VSCode/CLI 续聊：重启后首次发送要补上这段
  await appendFile(claudePath, `${[
    JSON.stringify({ type: "user", uuid: "u9", message: { role: "user", content: "停服时问题" } }),
    JSON.stringify({ type: "assistant", uuid: "a9", message: { role: "assistant", content: [{ type: "text", text: "停服时回答" }] } }),
  ].join("\n")}\n`);
  assert.equal(instances[0]!.stopped, true);
  assert.equal(events.some((event) => event.type === "process_exited"), false, "退出触发的 exited 不得标 dead");
  assert.equal(events.find((event) => event.type === "worker_released")?.payload.reason, "shutdown");

  const next = harness();
  const reloaded = next.manager.get(live.id)!;
  assert.equal(reloaded.status, "idle");
  assert.equal(reloaded.released, true);
  assert.equal(next.manager.get(fresh.id)!.status, "dead");
  assert.equal(next.manager.get(unprompted.id)!.status, "dead");
  assert.equal(reloaded.releasedMark, undefined, "指纹只在注册表里，不对外");
  assert.ok((next.manager as unknown as { promptedSessions: Set<string> }).promptedSessions.has(live.id),
    "重载后切换配置要按续接重启");
  await next.manager.sendUserMessage(live.id, { text: "重启后继续" });
  const external = next.events.find((event) => event.type === "external_messages_added");
  assert.deepEqual((external?.payload.messages as Array<{ role: string; text?: string }> | undefined)
    ?.map((message) => `${message.role}:${message.text ?? ""}`), ["user:停服时问题", "assistant:停服时回答"]);
  assert.equal(next.instances.at(-1)!.options.resumeSessionId, claudeId);
  assert.equal(next.instances.at(-1)!.sent.at(-1)?.text, "重启后继续");
  assert.equal(next.manager.get(live.id)!.released, undefined);
  await next.manager.shutdown();
}

// ── 1c. 释放尚未停完时续接必须等旧进程；旧代回调不得污染新代 ──
{
  const { manager, instances, events } = harness();
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "竞态第一轮" });
  const old = instances[0]!;
  old.finish();
  await pendingMarks(manager, session.id);
  const reader = (manager as unknown as { nativeReader: InstanceType<typeof NativeConversationReader> }).nativeReader;
  reader.changed = async () => undefined;
  reader.capture = async () => undefined;
  let finishStop!: () => void;
  const stopGate = new Promise<void>(resolve => { finishStop = resolve; });
  old.stop = async () => {
    await stopGate;
    old.stopped = true;
    old.options.callbacks.exited({ code: 0, signal: null, expected: true });
  };
  const releasing = manager.release(session.id, "manual");
  const sending = manager.sendUserMessage(session.id, { text: "释放期间发送" });
  sending.catch(() => undefined);
  try {
    // 清空本轮微任务与 IO 回调；stop 由门闩控制，不依赖耗时或 sleep。
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(instances.length, 1, "旧 stop 未完成前不得起新 worker");
    assert.equal(old.stopped, false);
  } finally {
    finishStop();
    await releasing;
    await sending;
  }
  assert.equal(instances.length, 2);
  assert.equal(manager.get(session.id)?.released, undefined);
  assert.equal(manager.get(session.id)?.status, "running");
  old.options.callbacks.status("dead");
  old.options.callbacks.metadata({ remoteControl: { status: "disconnected" } });
  old.options.callbacks.emit("session_error", { message: "迟到的旧代错误" });
  old.options.callbacks.exited({ code: 0, signal: null, expected: true });
  assert.equal(manager.get(session.id)?.status, "running");
  assert.ok(!events.some(event => event.payload.message === "迟到的旧代错误"));
  const releasedIndex = events.findIndex(event => event.type === "worker_released");
  const messageIndex = events.findIndex(event => event.type === "user_message" && event.payload.text === "释放期间发送");
  assert.ok(releasedIndex >= 0 && messageIndex > releasedIndex);
  await manager.shutdown();
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
  // 后台任务（委派的 codex 等）在跑时不许释放：释放会连带杀掉它
  instances.at(-1)!.options.callbacks.metadata({ backgroundTasks: [{ id: "b1", type: "local_bash", description: "delegate codex" }] });
  assert.equal(manager.get(session.id)!.backgroundTasks?.length, 1);
  await assert.rejects(() => manager.release(session.id, "manual"), /后台任务/);
  instances.at(-1)!.options.callbacks.metadata({ backgroundTasks: [] });
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

// ── 6b. 并发恢复共享任务；失败清除任务后仍可重试 ──
for (const operation of ["remote", "send", "failure"] as const) {
  let failNext = false;
  const { manager, instances } = harness(() => { const fail = failNext; failNext = false; return fail; });
  const session = await manager.create({ agent: "claude", cwd: fixture, resumeSessionId: claudeId, snapshot: "skip" });
  await manager.sendUserMessage(session.id, { text: "初始回合" });
  instances[0]!.finish();
  await pendingMarks(manager, session.id);
  await manager.release(session.id, "manual");
  let releaseCheck!: () => void;
  const gate = new Promise<void>(resolve => { releaseCheck = resolve; });
  let checks = 0;
  const reader = (manager as unknown as { nativeReader: InstanceType<typeof NativeConversationReader> }).nativeReader;
  reader.changed = async () => { checks++; await gate; return undefined; };
  failNext = operation === "failure";
  const first = manager.setRemoteControl(session.id, true);
  first.catch(() => undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = operation === "send"
    ? manager.sendUserMessage(session.id, { text: "并发发送" })
    : manager.setRemoteControl(session.id, false);
  second.catch(() => undefined);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(checks, 1, "两个调用共用一个原生检查");
    assert.equal(instances.length, 1, "检查尚未结束不得起 worker");
    const { SessionBusyError } = await import("./session-manager.js");
    await assert.rejects(manager.remove(session.id), SessionBusyError, "检查窗口的移除是可重试忙态");
  } finally { releaseCheck(); }
  const results = await Promise.allSettled([first, second]);
  assert.equal(instances.length, 2, "只创建一个续接 worker");
  if (operation === "failure") {
    assert.ok(results.every(result => result.status === "rejected"));
    await manager.setRemoteControl(session.id, true);
    assert.equal(instances.length, 3, "失败后清除在途任务，下一调用可重试");
  } else {
    assert.ok(results.every(result => result.status === "fulfilled"));
    if (operation === "send") assert.equal(instances[1]!.sent.at(-1)?.text, "并发发送");
  }
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
