import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityDriver } from "./drivers/antigravity.js";
import { createDriver, DRIVER_CAPABILITIES } from "./drivers/index.js";
import { selectEventPage } from "./event-pages.js";
import { NativeConversationReader } from "./native-conversation.js";
import { validateNativeDelete } from "./native-session-delete.js";
import type { DriverOptions, SessionRecord } from "./types.js";

const cwd = await mkdtemp(join(tmpdir(), "aireins-antigravity-test-"));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function harness({
  agent = "antigravity",
  resumeSessionId,
  thoughtOptions = ["low", "medium", "high"],
  thoughtCurrentValue = "medium",
  modeOptions = ["default", "accept-edits", "auto", "plan"],
  modeCurrentValue = "default",
  config = {},
}: {
  agent?: "antigravity" | "kimi";
  resumeSessionId?: string;
  thoughtOptions?: string[] | null;
  thoughtCurrentValue?: string | null;
  modeOptions?: string[];
  modeCurrentValue?: string | null;
  config?: DriverOptions["config"];
} = {}) {
  const frames: any[] = [], events: any[] = [], metadata: any[] = [], commands: any[] = [], spawns: any[] = [], statuses: string[] = [];
  const values: Record<string, string | null> = {
    model: "gemini-4-carbon",
    ...(thoughtOptions === null ? {} : { thought_level: thoughtCurrentValue }),
    mode: modeCurrentValue,
  };
  const configOptions = () => Object.entries(values).flatMap(([id, currentValue]) => {
    const opts = id === "model" ? ["gemini-4-carbon", "gemini-3.8-flash", "gemini-4-hydrogen", "orchestrator-carbon"]
      : id === "thought_level" ? (values.model === "orchestrator-carbon" ? null : thoughtOptions)
      : modeOptions;
    if (!opts) return [];
    return [{
      id,
      ...(currentValue === null || (id === "thought_level" && !opts.includes(currentValue)) ? {} : { currentValue }),
      options: opts.map(value => ({ value, name: value })),
    }];
  });
  const options: DriverOptions = { sessionId: "fixture", cwd, config, resumeSessionId,
    callbacks: { emit(type, payload) { events.push({ type, payload }); return undefined; },
      metadata(value) { metadata.push(value); }, commands(value) { commands.push(value); }, status(value) { statuses.push(value); }, exited() {} } };
  const driver = createDriver(agent, options);
  const internal = driver as any;
  const receive = (message: any) => internal.handleStdoutLine(JSON.stringify(message));
  internal.spawnProcess = (command: string, args: string[]) => spawns.push({ command, args });
  internal.send = (frame: any) => {
    frames.push(frame);
    if (frame.id === undefined || !frame.method || frame.method === "session/prompt") return;
    if (frame.method === "session/set_config_option") {
      values[frame.params.configId] = frame.params.value;
      if (frame.params.configId === "model" && frame.params.value === "orchestrator-carbon") delete values.thought_level;
    }
    queueMicrotask(() => receive({ id: frame.id, result: frame.method === "initialize" ? { protocolVersion: 1 }
      : { sessionId: resumeSessionId ?? "native-antigravity", configOptions: configOptions() } }));
  };
  const update = (value: any) => receive({ method: "session/update", params: { sessionId: resumeSessionId ?? "native-antigravity", update: value } });
  return { driver, frames, events, metadata, commands, spawns, receive, update, values, statuses, callbacks: options.callbacks };
}
const h = harness();
assert.ok(h.driver instanceof AntigravityDriver);
await h.driver.start();
assert.deepEqual(h.spawns, [{ command: "agy", args: ["acp"] }]);
assert.equal(h.driver.kind, "antigravity");
assert.equal(DRIVER_CAPABILITIES.antigravity.usage, "context");
assert.deepEqual(h.frames.filter(f => f.method === "session/set_config_option").map(f => f.params), [
  { sessionId: "native-antigravity", configId: "thought_level", value: "high" },
  { sessionId: "native-antigravity", configId: "mode", value: "auto" },
]);
assert.deepEqual(h.metadata.at(-1).config, { model: "gemini-4-carbon", effort: "high", permissionMode: "auto" });
assert.deepEqual(h.driver.getConfigSchema().options.map(o => o.id), ["model", "effort", "permissionMode"]);
assert.equal(h.driver.getConfigSchema().options.find(o => o.id === "effort")!.default, "high");
assert.equal(h.driver.getConfigSchema().options.find(o => o.id === "permissionMode")!.default, "auto");
await h.driver.setConfig({ model: "gemini-4-hydrogen", effort: "low", permissionMode: "plan" });
assert.ok(h.frames.some(f => f.params?.configId === "thought_level" && f.params.value === "low"));
await assert.rejects(h.driver.setConfig({ model: "unavailable-model" }), /Antigravity model/);
await assert.rejects(h.driver.setConfig({ effort: "max" }), /Antigravity effort/);

h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
h.update({ sessionUpdate: "session_info_update", title: "Native title" });
h.update({ sessionUpdate: "usage_update", used: 37, size: 100 });
h.update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "read_file", kind: "read", rawInput: { path: "sample.ts" } });
h.update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] });
h.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "/context", description: "Show context" }] });
assert.equal(h.events.find(e => e.type === "agent_text_delta").payload.text, "hello");
assert.equal(h.events.find(e => e.type === "thought_delta").payload.text, "thinking");
assert.deepEqual(h.events.find(e => e.type === "usage_updated").payload, { used: 37, size: 100 });
assert.equal(h.metadata.at(-1).nativeTitle, "Native title");
assert.equal(h.commands.at(-1)[0].source, "antigravity");
assert.equal(h.events.find(e => e.type === "tool_call_completed").payload.isError, false);

const image = join(cwd, "fixture.png");
await writeFile(image, Buffer.from([0, 1, 2]));
await h.driver.sendUserMessage({ text: "first", mentions: [{ type: "image", path: image, mimeType: "image/png" }] });
const first = h.frames.at(-1);
assert.equal(first.method, "session/prompt");
assert.equal(first.params.prompt[1].type, "image");
assert.equal(first.params.prompt[1].data, "AAEC");
assert.ok((await h.driver.sendUserMessage({ text: "next" }, { steer: true }))?.promptId);
const next = h.frames.at(-1);
assert.notEqual(next, first, "Antigravity immediately forwards an additional prompt to the native ACP server");
assert.equal(next.params.prompt[0].text, "next");
h.receive({ id: first.id, result: { stopReason: "end_turn" } });
await settle();
assert.equal(h.statuses.at(-1), "running", "the first response cannot idle an outstanding native prompt");
h.receive({ id: next.id, result: { stopReason: "end_turn" } });
await settle();
assert.equal(h.statuses.at(-1), "idle");
assert.equal(h.events.filter(e => e.type === "turn_completed").length, 2);

// Native replies may arrive out of order; a rejected addition must not end the original turn.
const now = Date.now;
let promptClock = now();
Date.now = () => promptClock;
try {
  const originalReceipt = await h.driver.sendUserMessage({ text: "original" });
  const original = h.frames.at(-1);
  promptClock += 100;
  const rejectedReceipt = await h.driver.sendUserMessage({ text: "rejected addition" }, { steer: true });
  h.receive({ id: h.frames.at(-1).id, error: { message: "addition rejected" } });
  assert.equal(h.statuses.at(-1), "running");
  assert.equal(h.events.at(-1).type, "session_error");
  assert.equal(h.events.at(-1).payload.promptId, rejectedReceipt?.promptId);
  assert.equal(h.events.at(-1).payload.message, "addition rejected");
  promptClock += 150;
  const anotherReceipt = await h.driver.sendUserMessage({ text: "another addition" }, { steer: true });
  assert.ok(originalReceipt?.promptId && anotherReceipt?.promptId);
  assert.equal(new Set([originalReceipt.promptId, rejectedReceipt?.promptId, anotherReceipt.promptId]).size, 3);
  promptClock += 500;
  h.receive({ id: h.frames.at(-1).id, result: { stopReason: "end_turn" } });
  assert.equal(h.statuses.at(-1), "running");
  promptClock += 250;
  h.receive({ id: original.id, result: { stopReason: "end_turn" } });
  assert.equal(h.statuses.at(-1), "idle");
  assert.deepEqual(h.events.filter(e => e.type === "turn_completed").slice(-2)
    .map(e => [e.payload.promptId, e.payload.durationMs]), [
    [anotherReceipt.promptId, 500], [originalReceipt.promptId, 1000],
  ]);
} finally {
  Date.now = now;
}
await assert.rejects(h.driver.sendUserMessage({ text: "too late" }, { steer: true }), /当前回合已结束/);

const permission = (id: number) => h.receive({ id, method: "session/request_permission", params: {
  toolCall: { title: "write_file" }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
permission(500);
const gate = h.events.at(-1).payload.requestId;
assert.match(gate, /^antigravity:/);
await h.driver.resolvePermission(gate, "allow");
assert.deepEqual(h.frames.at(-1).result, { outcome: { outcome: "selected", optionId: "yes" } });
permission(501);
await h.driver.interrupt();
assert.equal(h.frames.at(-1).method, "session/cancel");
assert.ok(h.events.some(e => e.type === "permission_resolved" && e.payload.requestId.endsWith(":501")));
await h.driver.stop();

const resumed = harness({ resumeSessionId: "existing-native-session" });
await resumed.driver.start();
assert.ok(resumed.frames.some(f => f.method === "session/resume" && f.params.sessionId === "existing-native-session"));
assert.equal(resumed.metadata.at(-1).config.effort, "medium");
assert.equal(resumed.metadata.at(-1).config.permissionMode, "default");
assert.ok(!resumed.frames.some(f => f.method === "session/set_config_option"));
await resumed.driver.stop();

for (const config of [{}, { effort: "high", permissionMode: "auto" }]) {
  const restricted = harness({ config, thoughtOptions: ["low", "medium"], modeOptions: ["default", "accept-edits", "plan"] });
  await restricted.driver.start();
  assert.equal(restricted.metadata.at(-1).config.effort, "medium");
  assert.equal(restricted.metadata.at(-1).config.permissionMode, "default");
  assert.equal(restricted.driver.getConfigSchema().options.find(o => o.id === "effort")!.default, "medium");
  assert.equal(restricted.driver.getConfigSchema().options.find(o => o.id === "permissionMode")!.default, "default");
  assert.ok(!restricted.frames.some(f => f.method === "session/set_config_option"));
  await restricted.driver.stop();

  const missingCurrent = harness({ config, thoughtOptions: ["low", "medium"], modeOptions: ["default", "accept-edits", "plan"], modeCurrentValue: null });
  await missingCurrent.driver.start();
  assert.equal(missingCurrent.metadata.at(-1).config.effort, "medium");
  assert.equal(missingCurrent.metadata.at(-1).config.permissionMode, "default");
  assert.deepEqual(missingCurrent.frames.filter(f => f.method === "session/set_config_option").map(f => f.params), [
    { sessionId: "native-antigravity", configId: "mode", value: "default" },
  ]);
  await missingCurrent.driver.stop();
}
const orchestrator = harness({ config: { model: "orchestrator-carbon", effort: "high", permissionMode: "auto" } });
await orchestrator.driver.start();
assert.deepEqual(orchestrator.frames.filter(f => f.method === "session/set_config_option").map(f => f.params), [
  { sessionId: "native-antigravity", configId: "model", value: "orchestrator-carbon" },
  { sessionId: "native-antigravity", configId: "mode", value: "auto" },
]);
assert.deepEqual(orchestrator.metadata.at(-1).config, { model: "orchestrator-carbon", permissionMode: "auto" });
assert.ok(!orchestrator.driver.getConfigSchema().options.some(o => o.id === "effort"));
await orchestrator.driver.stop();

for (const resumeSessionId of [undefined, "existing-native-session"]) {
  const explicit = harness({ resumeSessionId, config: { effort: "low", permissionMode: "plan" } });
  await explicit.driver.start();
  assert.equal(explicit.metadata.at(-1).config.effort, "low");
  assert.equal(explicit.metadata.at(-1).config.permissionMode, "plan");
  assert.deepEqual(explicit.frames.filter(f => f.method === "session/set_config_option").map(f => f.params), [
    { sessionId: resumeSessionId ?? "native-antigravity", configId: "thought_level", value: "low" },
    { sessionId: resumeSessionId ?? "native-antigravity", configId: "mode", value: "plan" },
  ]);
  await explicit.driver.stop();
}
const record = { agent: "antigravity", nativeSessionId: "native-session" } as SessionRecord;
assert.equal(new NativeConversationReader().transcriptPath(record), undefined);
assert.equal(new NativeConversationReader().hasArchive(record), false);
assert.throws(() => validateNativeDelete(record), /Antigravity/);

// ── Antigravity 在途后台工具 + 原生子代理 + reactive wakeup + 同步帧序 + 中断边界 ──
{
  const timeline: string[] = [];
  const bg = harness();
  const internal = bg.driver as any;
  internal.reactiveSettleMs = 40;
  internal.reactiveWakeGraceMs = 180;
  internal.reactiveFallbackMs = 180;
  internal.reactiveSubagentGraceMs = 240;
  const origMeta = bg.callbacks.metadata;
  const origStatus = bg.callbacks.status;
  bg.callbacks.metadata = (value) => {
    if (value.backgroundTasks) timeline.push(`bg:${value.backgroundTasks.map((t) => t.id).join(",")}`);
    origMeta(value);
  };
  bg.callbacks.status = (value) => {
    timeline.push(`status:${value}`);
    origStatus(value);
  };
  await bg.driver.start();
  timeline.length = 0;

  // 1) 正常单轮工具全部完成后才 end_turn：不发布冗余 backgroundTasks，且 turn_completed 自带 durationMs
  await bg.driver.sendUserMessage({ text: "normal turn" });
  const p0 = bg.frames.at(-1);
  bg.update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "read_file", kind: "read", status: "in_progress" });
  bg.update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [] });
  bg.receive({ id: p0.id, result: { stopReason: "end_turn" } });
  await settle();
  assert.deepEqual(timeline, ["status:running", "status:idle"]);
  assert.equal(typeof bg.events.at(-1).payload.durationMs, "number");

  // 2) 委派 Codex 后台命令：end_turn 与 tool_call_update(completed) 同批到达；waiting_wake 期间的 usage_update 不缩短宽限期
  timeline.length = 0;
  await bg.driver.sendUserMessage({ text: "delegate to codex" });
  const p1 = bg.frames.at(-1);
  bg.update({ sessionUpdate: "tool_call", toolCallId: "codex-1", title: "delegate codex --name review", kind: "execute", status: "in_progress" });
  // 同批紧邻入站帧：先 RPC response，紧接着同批下一行工具完成
  bg.receive({ id: p1.id, result: { stopReason: "end_turn" } });
  bg.update({ sessionUpdate: "tool_call_update", toolCallId: "codex-1", status: "completed", content: [] });
  assert.deepEqual(timeline, ["status:running", "bg:codex-1", "status:idle", "bg:antigravity:reactive"],
    "同批到达时必须同步扣减 activePrompts 并进入 waiting_wake 宽限期");
  // waiting_wake 期间迟到的 usage_update 绝不能把宽限期缩成 settleMs
  bg.update({ sessionUpdate: "usage_update", used: 41, size: 100 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(timeline.at(-1), "bg:antigravity:reactive", "waiting_wake 阶段的 usage_update 不得提前清空后台状态");
  // 真正唤醒后吐出思考/正文，再发 usage_update 收尾确认后清空 backgroundTasks
  bg.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reviewing codex reply" } });
  bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Codex finished." } });
  bg.update({ sessionUpdate: "usage_update", used: 42, size: 100 });
  assert.equal(timeline.at(-1), "bg:antigravity:reactive", "awake 阶段 usage_update 后短暂确认窗口内仍保持活跃");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(timeline.at(-1), "bg:", "确认无后续工具调用后清空 backgroundTasks");
  const settledEvents = bg.events.length;
  for (const sessionUpdate of ["tool_call_update", "tool_call"]) {
    bg.update({ sessionUpdate, toolCallId: "codex-1", status: "in_progress", title: "late tool" });
    assert.equal(internal.inFlightTools.has("codex-1"), false);
    assert.equal(bg.events.length, settledEvents);
    assert.equal(timeline.at(-1), "bg:");
  }
  for (const [sessionUpdate, status] of [["tool_call", "failed"], ["tool_call_update", "cancelled"]]) {
    bg.update({ sessionUpdate, toolCallId: status, status });
    assert.equal(bg.events.at(-1).type, "tool_call_completed");
    assert.equal(bg.events.at(-1).payload.isError, true);
    const terminalEvents = bg.events.length;
    bg.update({ sessionUpdate: "tool_call_update", toolCallId: status, status: "pending" });
    assert.equal(bg.events.length, terminalEvents);
    assert.equal(internal.inFlightTools.has(status), false);
  }

  timeline.length = 0;
  await bg.driver.sendUserMessage({ text: "prompt A" });
  const promptA = bg.frames.at(-1);
  bg.update({ sessionUpdate: "tool_call", toolCallId: "cross-prompt", title: "delegate codex", status: "in_progress" });
  await bg.driver.sendUserMessage({ text: "prompt B" }, { steer: true });
  const promptB = bg.frames.at(-1);
  bg.receive({ id: promptA.id, result: { stopReason: "end_turn" } });
  bg.update({ sessionUpdate: "tool_call_update", toolCallId: "cross-prompt", status: "completed" });
  assert.deepEqual(timeline, ["status:running", "status:running"]);
  bg.receive({ id: promptB.id, result: { stopReason: "end_turn" } });
  assert.equal(internal.reactivePhase, "waiting_wake");
  assert.deepEqual(timeline.slice(-2), ["bg:antigravity:reactive", "status:idle"]);
  await bg.driver.interrupt();

  // 3) 两个原生子代理分别唤醒，只结算当前回报；工具唤醒期间两条记录均保留。
  timeline.length = 0;
  internal.reactiveSubagentGraceMs = 5_000;
  await bg.driver.sendUserMessage({ text: "launch native subagent" });
  const pSub = bg.frames.at(-1);
  for (const id of ["sub-1", "sub-2"]) {
    bg.update({ sessionUpdate: "tool_call", toolCallId: id, title: "Run invoke_subagent", kind: "other", status: "in_progress" });
    bg.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [] });
  }
  bg.update({ sessionUpdate: "tool_call", toolCallId: "review-tool", title: "delegate codex", status: "in_progress" });
  bg.receive({ id: pSub.id, result: { stopReason: "end_turn" } });
  assert.deepEqual(timeline, ["status:running", "bg:review-tool", "status:idle"]);
  bg.update({ sessionUpdate: "tool_call_update", toolCallId: "review-tool", status: "completed" });
  for (const [text, remaining] of [
    ["Codex finished", ["sub-1", "sub-2"]],
    ["First subagent finished", ["sub-2"]],
    ["Second subagent finished", []],
  ] as const) {
    bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    assert.equal(timeline.at(-1), "bg:antigravity:reactive");
    if (text === "First subagent finished") {
      bg.update({ sessionUpdate: "tool_call", toolCallId: "read-on-wake", title: "read_file", status: "in_progress" });
      bg.update({ sessionUpdate: "tool_call_update", toolCallId: "read-on-wake", status: "completed" });
    }
    bg.update({ sessionUpdate: "usage_update", used: 50, size: 100 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual([...internal.pendingNativeSubagents.keys()], remaining);
    assert.equal(timeline.at(-1), remaining.length ? "bg:antigravity:subagent" : "bg:");
  }

  // 4) interrupt 立即清空，且中断后迟到的非终态 tool_call_update 和流式输出不得重新挂起后台状态
  timeline.length = 0;
  await bg.driver.sendUserMessage({ text: "another delegate" });
  const p2 = bg.frames.at(-1);
  bg.update({ sessionUpdate: "tool_call", toolCallId: "codex-2", title: "delegate codex", kind: "execute", status: "in_progress" });
  bg.receive({ id: p2.id, result: { stopReason: "end_turn" } });
  assert.equal(timeline.at(-2), "bg:codex-2");
  const beforeInterrupt = bg.events.length;
  await bg.driver.interrupt();
  assert.equal(timeline.at(-1), "bg:");
  const toolEnd = bg.events.slice(beforeInterrupt).filter(e => e.type === "tool_call_completed");
  assert.deepEqual(toolEnd.map(e => e.payload), [
    { toolCallId: "codex-2", isError: true, status: "cancelled", content: "Cancelled" },
  ]);
  const eventCount = bg.events.length;
  bg.update({ sessionUpdate: "tool_call_update", toolCallId: "codex-2", title: "delegate codex", status: "in_progress" });
  bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late chunk" } });
  bg.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "late thought" } });
  bg.update({ sessionUpdate: "usage_update", used: 51, size: 100 });
  assert.equal(bg.events.length, eventCount);
  assert.equal(timeline.at(-1), "bg:", "中断后的迟到工具/流更新不得重新挂起黄点");

  await bg.driver.sendUserMessage({ text: "cancel active prompt" });
  const cancelled = bg.frames.at(-1);
  bg.update({ sessionUpdate: "tool_call", toolCallId: "cancelled-active", title: "run", status: "in_progress" });
  await bg.driver.interrupt();
  bg.receive({ id: cancelled.id, error: { message: "cancelled" } });
  const afterCancellation = bg.events.length;
  bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late after RPC failure" } });
  assert.equal(bg.events.length, afterCancellation);
  await bg.driver.sendUserMessage({ text: "new prompt" });
  const newPrompt = bg.frames.at(-1);
  for (const id of ["codex-2", "cancelled-active"]) {
    for (const status of ["in_progress", "completed", "failed", "in_progress"]) {
      bg.update({ sessionUpdate: "tool_call_update", toolCallId: id, title: "late old tool", status });
    }
    assert.equal(internal.inFlightTools.has(id), false);
  }
  assert.equal(bg.events.length, afterCancellation);
  const pageEvents = [
    { type: "user_message", payload: { text: "original" } },
    bg.events.find(e => e.type === "tool_call_started" && e.payload.toolCallId === "codex-2"),
    ...toolEnd,
    { type: "user_message", payload: { text: "next" } },
  ].map((event, index) => ({
    ...event, seq: index + 1, sessionId: "fixture", agentId: "fixture", timestamp: new Date().toISOString(),
  }));
  assert.equal(selectEventPage(pageEvents, 4).events.at(-1)?.type, "tool_call_completed");
  bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new reply" } });
  assert.equal(bg.events.at(-1).payload.text, "new reply");
  bg.receive({ id: newPrompt.id, result: { stopReason: "end_turn" } });
  await bg.driver.stop();
  assert.equal(internal.completedToolCallIds.size, 0);
}

for (const wakeOffset of [499, 501]) {
  const bg = harness();
  const internal = bg.driver as any;
  internal.reactiveSubagentGraceMs = 500;
  internal.reactiveSettleMs = 10;
  await bg.driver.start();
  let clock = now();
  const started = clock;
  Date.now = () => clock;
  try {
    await bg.driver.sendUserMessage({ text: "start subagents with staggered expiry" });
    const initial = bg.frames.at(-1);
    for (const [id, elapsed] of [["expires-first", 0], ["still-pending", 300]] as const) {
      clock = started + elapsed;
      bg.update({ sessionUpdate: "tool_call", toolCallId: id, title: "invoke_subagent", status: "in_progress" });
      bg.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    }
    bg.receive({ id: initial.id, result: { stopReason: "end_turn" } });
    clock = started + wakeOffset;
    bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First subagent returned" } });
    bg.update({ sessionUpdate: "usage_update", used: 1, size: 100 });
    clock = started + 502;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual([...internal.pendingNativeSubagents.keys()], ["still-pending"]);
    assert.equal(bg.metadata.at(-1).backgroundTasks[0]?.id, "antigravity:subagent");
    bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second subagent returned" } });
    bg.update({ sessionUpdate: "usage_update", used: 2, size: 100 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(internal.pendingNativeSubagents.size, 0);
    assert.deepEqual(bg.metadata.at(-1).backgroundTasks, []);
  } finally {
    Date.now = now;
    await bg.driver.stop();
  }
}

for (const wakeOrder of ["after new batch", "between batches", "retention expired", "new prompt during settle"]) {
  const bg = harness();
  const internal = bg.driver as any;
  internal.reactiveSubagentGraceMs = 50;
  internal.reactiveSettleMs = 5;
  await bg.driver.start();
  const started = now();
  let clock = started;
  Date.now = () => clock;
  try {
    const startSubagent = async (id: string) => {
      await bg.driver.sendUserMessage({ text: `start ${id}` });
      const promptId = bg.frames.at(-1).id;
      bg.update({ sessionUpdate: "tool_call", toolCallId: id, title: "invoke_subagent", status: "in_progress" });
      bg.update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
      bg.receive({ id: promptId, result: { stopReason: "end_turn" } });
      assert.equal(bg.metadata.at(-1).backgroundTasks[0]?.id, "antigravity:subagent");
    };
    const startWake = (text: string) => {
      bg.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      bg.update({ sessionUpdate: "usage_update", used: 1, size: 100 });
    };
    const wake = async (text: string) => {
      startWake(text);
      await new Promise(resolve => setTimeout(resolve, 20));
    };
    await startSubagent("expired");
    clock = started + 51;
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepEqual(bg.metadata.at(-1).backgroundTasks, []);
    assert.equal(internal.pendingNativeSubagents.size, 0);
    if (wakeOrder === "between batches") {
      await wake("Expired subagent returned before the new batch");
      assert.deepEqual(bg.metadata.at(-1).backgroundTasks, []);
    }
    if (wakeOrder === "retention expired") clock = started + 100;
    if (wakeOrder === "new prompt during settle") {
      startWake("Expired subagent returned just before the new prompt");
      assert.equal(internal.reactivePhase, "awake");
      assert.equal(internal.settlingExpiredSubagentDeadline, started + 100);
    }
    await startSubagent("new");
    if (wakeOrder === "after new batch") {
      await wake("Expired subagent returned during the new batch");
      assert.deepEqual([...internal.pendingNativeSubagents.keys()], ["new"]);
      assert.equal(bg.metadata.at(-1).backgroundTasks[0]?.id, "antigravity:subagent");
    }
    await wake("New subagent returned");
    assert.equal(internal.pendingNativeSubagents.size, 0, wakeOrder);
    assert.deepEqual(bg.metadata.at(-1).backgroundTasks, []);
  } finally {
    Date.now = now;
    await bg.driver.stop();
  }
}

for (const failed of [false, true]) {
  const bg = harness();
  const internal = bg.driver as any;
  await bg.driver.start();
  let clock = now();
  Date.now = () => clock;
  try {
    await bg.driver.sendUserMessage({ text: "start background tool" });
    const initial = bg.frames.at(-1);
    bg.update({ sessionUpdate: "tool_call", toolCallId: "waiting-tool", title: "delegate codex", status: "in_progress" });
    bg.receive({ id: initial.id, result: { stopReason: "end_turn" } });
    bg.update({ sessionUpdate: "tool_call_update", toolCallId: "waiting-tool", status: "completed" });
    assert.equal(internal.reactivePhase, "waiting_wake");
    const originalDeadline = clock + internal.reactiveWakeGraceMs;
    clock += 1000;
    await bg.driver.sendUserMessage({ text: "send another prompt before wake" });
    clock += 1000;
    const secondId = bg.frames.at(-1).id;
    bg.receive(failed ? { id: secondId, error: { message: "second prompt failed" } }
      : { id: secondId, result: { stopReason: "end_turn" } });
    if (failed) assert.ok(bg.events.some(event => event.type === "session_error" && event.payload.message === "second prompt failed"));
    assert.equal(internal.reactivePhase, "waiting_wake");
    assert.equal(bg.metadata.at(-1).backgroundTasks[0]?.id, "antigravity:reactive");
    assert.equal(internal.wakeGraceEndsAtMs, originalDeadline);
    assert.equal(bg.statuses.at(-1), "idle", "后台等待需保持可中断的 idle 状态");
  } finally {
    Date.now = now;
    await bg.driver.stop();
  }
}

{
  const kimi = harness({ agent: "kimi" });
  await kimi.driver.start();
  const active = await kimi.driver.sendUserMessage({ text: "active" });
  const rpc = kimi.frames.at(-1);
  const queued = await Promise.all(["B", "C"].map(text => kimi.driver.sendUserMessage({ text }, { steer: true })));
  assert.ok(queued.every(receipt => receipt?.queued && receipt.promptId));
  assert.equal(kimi.frames.filter(frame => frame.method === "session/prompt").length, 1);
  kimi.receive({ id: rpc.id, error: { message: "active failed" } });
  const errors = kimi.events.filter(event => event.type === "session_error").map(event => event.payload);
  assert.deepEqual(errors.find(payload => payload.source === "steer_queue")?.cancelledPromptIds,
    queued.map(receipt => receipt?.promptId));
  assert.equal(errors.find(payload => payload.source === "session/prompt")?.promptId, active?.promptId);
  assert.equal(kimi.frames.filter(frame => frame.method === "session/prompt").length, 1);
  await kimi.driver.stop();
}

console.log("PASS: Antigravity 官方 ACP 配置、流式消息、审批、附件、原生追加及并发响应、取消、续接、后台续跑保活及原生历史隔离");
