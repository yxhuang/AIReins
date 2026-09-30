import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentKind, Driver, DriverConfigSchema, DriverOptions, SessionConfig, SessionRecord, UserMessageInput } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-native-conversation-"));
process.env.WORKBENCH_HOME = join(fixture, "workbench");
const roots = {
  claude: join(fixture, "claude", "projects"),
  codex: join(fixture, "codex", "sessions"),
  kimi: join(fixture, "kimi", "sessions"),
};
const ids = {
  claude: "11111111-1111-4111-8111-111111111111",
  codex: "22222222-2222-4222-8222-222222222222",
  kimi: "session_kimi_fixture",
};
const paths = {
  claude: join(roots.claude, "project", `${ids.claude}.jsonl`),
  codex: join(roots.codex, "2026", "09", "27", `rollout-2026-09-27T00-00-00-${ids.codex}.jsonl`),
  kimi: join(roots.kimi, "workspace", ids.kimi, "agents", "main", "wire.jsonl"),
};
await Promise.all(Object.values(paths).map((path) => mkdir(join(path, ".."), { recursive: true })));
await mkdir(process.env.WORKBENCH_HOME, { recursive: true });
await writeLines(paths.claude, [
  { type: "user", uuid: "claude-user-1", message: { role: "user", content: "初始问题" } },
  { type: "assistant", uuid: "claude-assistant-1", message: { role: "assistant", content: [{ type: "text", text: "初始回答" }] } },
]);
await writeLines(paths.codex, [
  { type: "session_meta", payload: { id: ids.codex } },
  { type: "event_msg", payload: { type: "user_message", message: "初始问题" } },
  { type: "event_msg", payload: { type: "agent_message", message: "初始回答" } },
]);
await writeLines(paths.kimi, [
  { type: "turn.prompt", input: [{ type: "text", text: "初始问题" }] },
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "初始回答" } } },
]);

const [{ NativeConversationReader }, { SessionManager }] = await Promise.all([
  import("./native-conversation.js"),
  import("./session-manager.js"),
]);
const reader = new NativeConversationReader(roots);
const agents: AgentKind[] = ["claude", "codex", "kimi"];
const schema: DriverConfigSchema = { source: "fixture", options: [] };

class FakeDriver implements Driver {
  sent: UserMessageInput[] = [];
  stopped = false;
  started = false;
  constructor(readonly kind: AgentKind, readonly options: DriverOptions, readonly shouldFail = false) {}
  async start(): Promise<void> {
    if (this.shouldFail) throw new Error("fixture resume failed");
    this.started = true;
    this.options.callbacks.metadata({ nativeSessionId: this.options.resumeSessionId, nativeTranscriptPath: paths[this.kind] });
    this.options.callbacks.status("idle");
  }
  getConfigSchema(): DriverConfigSchema { return schema; }
  async setConfig(config: SessionConfig): Promise<SessionConfig> { return config; }
  async sendUserMessage(message: UserMessageInput): Promise<void> {
    assert.equal(this.started, true, "send must happen after resume start");
    this.sent.push(message);
    this.options.callbacks.status("running");
  }
  async resolvePermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; }
  finish(): void {
    this.options.callbacks.emit("turn_completed", {});
    this.options.callbacks.status("idle");
  }
}

for (const agent of agents) {
  const session = { agent, nativeSessionId: ids[agent], nativeTranscriptPath: paths[agent] } as SessionRecord;
  const baseline = await reader.capture(session);
  assert.ok(baseline, `${agent} should have a conversation fingerprint`);
  if (agent === "claude") assert.equal(baseline.identity, "uuid:claude-assistant-1");
  else assert.match(baseline.identity, /^\d+:[0-9a-f]{64}$/);
  await appendFile(paths[agent], `${JSON.stringify({ type: "metadata", title: "new title", usage: { tokens: 9 } })}\n`);
  assert.equal(await reader.changed(session, baseline), undefined, `${agent} metadata must not trigger restart`);

  const instances: FakeDriver[] = [];
  const manager = new SessionManager(
    (kind, options) => {
      const driver = new FakeDriver(kind, options);
      instances.push(driver);
      return driver;
    },
    () => ({ model: null, effort: null }),
    async () => null,
    reader,
  );
  const created = await manager.create({ agent, cwd: fixture, resumeSessionId: ids[agent], snapshot: "skip" });
  await appendFile(paths[agent], `${JSON.stringify({ type: "metadata", summary: "updated", token_count: 42 })}\n`);
  await manager.sendUserMessage(created.id, { text: "工作台第一轮" });
  assert.equal(instances.length, 1, `${agent} unchanged conversation must not restart`);
  instances[0]!.finish();
  await (manager as unknown as { pendingMarkReads: Map<string, Promise<void>> }).pendingMarkReads.get(created.id);

  // assistant-only-flush-lag: turn_completed ran before the local answer reached disk.
  const markBeforeFlush = await reader.capture(session);
  await appendFile(paths[agent], `${JSON.stringify(toolCall(agent, "local"))}\n${JSON.stringify(localAssistant(agent, 1))}\n`);
  const delayedOnly = await reader.changed(session, markBeforeFlush!);
  assert.ok(delayedOnly, `${agent}: assistant-only-flush-lag has a new native mark`);
  assert.deepEqual(delayedOnly.messages, [], `${agent}: assistant-only-flush-lag is not external`);
  await manager.sendUserMessage(created.id, { text: "工作台第二轮" });
  assert.equal(instances.length, 1, `${agent}: assistant-only-flush-lag must not restart`);
  assert.equal(manager.getSnapshot(created.id)!.events.some((event) => event.type === "external_messages_added"), false);
  const currentMark = (manager as unknown as { nativeMarks: Map<string, { identity: string }> }).nativeMarks.get(created.id);
  assert.equal(currentMark?.identity, delayedOnly.mark.identity, `${agent}: assistant-only-flush-lag must advance fingerprint`);
  instances[0]!.finish();
  await (manager as unknown as { pendingMarkReads: Map<string, Promise<void>> }).pendingMarkReads.get(created.id);

  // flush-lag-before-external-turn: discard the local answer before the first new user line.
  await appendFile(paths[agent], `${JSON.stringify(localAssistant(agent, 2))}\n${JSON.stringify(externalUser(agent))}\n${JSON.stringify(toolCall(agent, "external"))}\n${JSON.stringify(externalAssistant(agent))}\n`);
  await manager.sendUserMessage(created.id, { text: "工作台续聊" });
  assert.equal(instances.length, 2, `${agent}: flush-lag-before-external-turn must restart worker`);
  assert.equal(instances[0]!.stopped, true);
  assert.equal(instances[1]!.options.resumeSessionId, ids[agent]);
  assert.deepEqual(instances[1]!.sent.map((item) => item.text), ["工作台续聊"]);
  const transcript = manager.getSnapshot(created.id)!.events;
  const externalAt = transcript.findIndex((event) => event.type === "external_messages_added");
  const nextUserAt = transcript.findIndex((event, index) => index > externalAt && event.type === "user_message");
  assert.ok(externalAt >= 0 && nextUserAt > externalAt, `${agent} event must precede new user message`);
  assert.deepEqual((transcript[externalAt]!.payload.messages as Array<{ role: string; text: string }>).map((item) => `${item.role}:${item.text}`), [
    "user:外部问题", "tool:undefined", "assistant:外部回答",
  ], `${agent}: flush-lag-before-external-turn must omit local assistant replies`);
  assert.deepEqual(transcript.map((event) => event.seq), transcript.map((_, index) => index + 1));
  await manager.shutdown();
}

const missingInstances: FakeDriver[] = [];
const missingManager = new SessionManager(
  (agent, options) => {
    const driver = new FakeDriver(agent, options);
    missingInstances.push(driver);
    return driver;
  },
  () => ({ model: null, effort: null }),
  async () => null,
  new NativeConversationReader({ claude: join(fixture, "missing-claude") }),
);
const missing = await missingManager.create({ agent: "claude", cwd: fixture, resumeSessionId: "missing-native", snapshot: "skip" });
await missingManager.sendUserMessage(missing.id, { text: "仍能发送" });
assert.equal(missingInstances.length, 1);
assert.equal(missingInstances[0]!.sent.length, 1);
const beforeNativeId = await missingManager.create({ agent: "claude", cwd: fixture, snapshot: "skip" });
await missingManager.sendUserMessage(beforeNativeId.id, { text: "首轮没有原生 ID 也能发送" });
assert.equal(missingInstances.length, 2);
assert.equal(missingInstances[1]!.sent.length, 1);
await missingManager.shutdown();

const runningInstances: FakeDriver[] = [];
const runningManager = new SessionManager(
  (agent, options) => {
    const driver = new FakeDriver(agent, options);
    runningInstances.push(driver);
    return driver;
  },
  () => ({ model: null, effort: null }),
  async () => null,
  reader,
);
const running = await runningManager.create({ agent: "codex", cwd: fixture, resumeSessionId: ids.codex, snapshot: "skip" });
await runningManager.sendUserMessage(running.id, { text: "进行中" });
await appendFile(paths.codex, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "运行期外部消息" } })}\n`);
await runningManager.sendUserMessage(running.id, { text: "运行中发送不检测" });
assert.equal(runningInstances.length, 1);
assert.equal(runningInstances[0]!.sent.length, 2);
await runningManager.shutdown();

const failInstances: FakeDriver[] = [];
const failManager = new SessionManager(
  (agent, options) => {
    const driver = new FakeDriver(agent, options, failInstances.length > 0);
    failInstances.push(driver);
    return driver;
  },
  () => ({ model: null, effort: null }),
  async () => null,
  reader,
);
const failing = await failManager.create({ agent: "claude", cwd: fixture, resumeSessionId: ids.claude, snapshot: "skip" });
await appendFile(paths.claude, `${JSON.stringify({ type: "user", uuid: "claude-user-fail", message: { role: "user", content: "外部失败轮" } })}\n`);
await assert.rejects(() => failManager.sendUserMessage(failing.id, { text: "绝不能给旧 worker" }), /重新续接失败；本轮未发送/);
assert.equal(failInstances[0]!.sent.length, 0);
assert.equal(failManager.get(failing.id)!.status, "error");
assert.equal(failManager.getSnapshot(failing.id)!.events.at(-1)!.type, "session_error");
await failManager.shutdown();

console.log("native conversation fixtures passed");

async function writeLines(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function externalUser(agent: AgentKind): unknown {
  if (agent === "claude") return { type: "user", uuid: "claude-user-2", message: { role: "user", content: "外部问题" } };
  if (agent === "codex") return { type: "event_msg", payload: { type: "user_message", message: "外部问题" } };
  return { type: "turn.prompt", input: [{ type: "text", text: "外部问题" }] };
}

function externalAssistant(agent: AgentKind): unknown {
  if (agent === "claude") return { type: "assistant", uuid: "claude-assistant-2", message: { role: "assistant", content: [{ type: "text", text: "外部回答" }] } };
  if (agent === "codex") return { type: "event_msg", payload: { type: "agent_message", message: "外部回答" } };
  return { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "外部回答" } } };
}

function localAssistant(agent: AgentKind, turn: number): unknown {
  if (agent === "claude") return {
    type: "assistant", uuid: `claude-local-assistant-${turn}`,
    message: { role: "assistant", content: [{ type: "text", text: `本端回复 ${turn}` }] },
  };
  if (agent === "codex") return { type: "event_msg", payload: { type: "agent_message", message: `本端回复 ${turn}` } };
  return { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: `本端回复 ${turn}` } } };
}

function toolCall(agent: AgentKind, id: string): unknown {
  if (agent === "claude") return { type: "assistant", uuid: `tool-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "pwd" } }] } };
  if (agent === "codex") return { type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"pwd"}' } };
  return { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: id, name: "Bash", args: { command: "pwd" } } };
}

// A tool-only late flush advances the mark without creating an external turn.
for (const agent of agents) {
  const session = { agent, nativeSessionId: ids[agent], nativeTranscriptPath: paths[agent] } as SessionRecord;
  const mark = await reader.capture(session);
  await appendFile(paths[agent], `${JSON.stringify(toolCall(agent, "last"))}\n`);
  const change = await reader.changed(session, mark!);
  assert.ok(change);
  assert.deepEqual(change.messages, []);
  if (agent === "claude") assert.equal(change.mark.identity, "uuid:tool-last");
  await appendFile(paths[agent], `${JSON.stringify({ type: "metadata", usage: 42 })}\n`);
  assert.equal(await reader.changed(session, change.mark), undefined);
  if (agent === "claude") {
    await appendFile(paths.claude, `${JSON.stringify({ type: "user", uuid: "result-only", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "last", content: "ok" }] } })}\n`);
    assert.equal(await reader.changed(session, change.mark), undefined, "tool results must not destabilize the call-line UUID fingerprint");
  }
}
const { boundExternalMessages } = await import("./native-conversation.js");
const huge = Array.from({ length: 150 }, (_, index) => ({
  role: "tool" as const, timestamp: null,
  tool: { id: String(index), name: "Bash", input: "中".repeat(3900), result: "r".repeat(3900), status: "ok" as const },
}));
const bounded = boundExternalMessages("native", [{ role: "user", text: "external", timestamp: null }, ...huge]);
assert.equal(bounded.truncated, true);
assert.ok(Buffer.byteLength(JSON.stringify({ nativeSessionId: "native", ...bounded })) <= 512 * 1024);
assert.equal(bounded.messages[0]?.role, "user");
assert.ok(bounded.messages[1]?.role === "tool" && bounded.messages[1].tool.input === "[truncated]");
assert.equal(huge[0]!.tool.input.length, 3900, "original messages remain untouched");
const bigText = boundExternalMessages("native", [{ role: "user", timestamp: null, text: "中".repeat(600000) }]);
assert.ok(Buffer.byteLength(JSON.stringify({ nativeSessionId: "native", ...bigText })) <= 512 * 1024);
assert.equal(bigText.truncated, true);
console.log("native tool-only flush, stable fingerprint and event cap passed");
