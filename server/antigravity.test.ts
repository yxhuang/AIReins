import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityDriver } from "./drivers/antigravity.js";
import { createDriver, DRIVER_CAPABILITIES } from "./drivers/index.js";
import { NativeConversationReader } from "./native-conversation.js";
import { validateNativeDelete } from "./native-session-delete.js";
import type { DriverOptions, SessionRecord } from "./types.js";

const cwd = await mkdtemp(join(tmpdir(), "aireins-antigravity-test-"));
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(resumeSessionId?: string) {
  const frames: any[] = [], events: any[] = [], metadata: any[] = [], commands: any[] = [], spawns: any[] = [], statuses: string[] = [];
  const values: Record<string, string> = { model: "gemini-3.8-flash", thought_level: "high", mode: "default" };
  const configOptions = () => Object.entries(values).map(([id, currentValue]) => ({
    id, currentValue, options: (id === "model" ? ["gemini-3.8-flash", "gemini-4-hydrogen"]
      : id === "thought_level" ? ["low", "medium", "high"] : ["default", "accept-edits", "auto", "plan"])
      .map(value => ({ value, name: value })),
  }));
  const options: DriverOptions = { sessionId: "fixture", cwd, config: {}, resumeSessionId,
    callbacks: { emit(type, payload) { events.push({ type, payload }); return undefined; },
      metadata(value) { metadata.push(value); }, commands(value) { commands.push(value); }, status(value) { statuses.push(value); }, exited() {} } };
  const driver = createDriver("antigravity", options);
  assert.ok(driver instanceof AntigravityDriver);
  const internal = driver as any;
  const receive = (message: any) => internal.handleStdoutLine(JSON.stringify(message));
  internal.spawnProcess = (command: string, args: string[]) => spawns.push({ command, args });
  internal.send = (frame: any) => {
    frames.push(frame);
    if (frame.id === undefined || !frame.method || frame.method === "session/prompt") return;
    if (frame.method === "session/set_config_option") values[frame.params.configId] = frame.params.value;
    queueMicrotask(() => receive({ id: frame.id, result: frame.method === "initialize" ? { protocolVersion: 1 }
      : { sessionId: resumeSessionId ?? "native-antigravity", configOptions: configOptions() } }));
  };
  const update = (value: any) => receive({ method: "session/update", params: { sessionId: resumeSessionId ?? "native-antigravity", update: value } });
  return { driver, frames, events, metadata, commands, spawns, receive, update, values, statuses };
}
const h = harness();
await h.driver.start();
assert.deepEqual(h.spawns, [{ command: "agy", args: ["acp"] }]);
assert.equal(h.driver.kind, "antigravity");
assert.equal(DRIVER_CAPABILITIES.antigravity.usage, "context");
assert.deepEqual(h.metadata.at(-1).config, { model: "gemini-3.8-flash", effort: "high", permissionMode: "default" });
assert.deepEqual(h.driver.getConfigSchema().options.map(o => o.id), ["model", "effort", "permissionMode"]);
assert.equal(h.driver.getConfigSchema().options.find(o => o.id === "permissionMode")!.default, "default");
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
assert.equal(await h.driver.sendUserMessage({ text: "next" }, { steer: true }), undefined);
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
await h.driver.sendUserMessage({ text: "original" });
const original = h.frames.at(-1);
await h.driver.sendUserMessage({ text: "rejected addition" }, { steer: true });
const rejected = h.frames.at(-1);
h.receive({ id: rejected.id, error: { message: "addition rejected" } });
await settle();
assert.equal(h.statuses.at(-1), "running");
assert.ok(h.events.some(e => e.type === "session_error" && e.payload.message === "addition rejected"));
await h.driver.sendUserMessage({ text: "another addition" }, { steer: true });
const another = h.frames.at(-1);
h.receive({ id: another.id, result: { stopReason: "end_turn" } });
await settle();
assert.equal(h.statuses.at(-1), "running");
h.receive({ id: original.id, result: { stopReason: "end_turn" } });
await settle();
assert.equal(h.statuses.at(-1), "idle");
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

const resumed = harness("existing-native-session");
await resumed.driver.start();
assert.ok(resumed.frames.some(f => f.method === "session/resume" && f.params.sessionId === "existing-native-session"));
await resumed.driver.stop();
const record = { agent: "antigravity", nativeSessionId: "native-session" } as SessionRecord;
assert.equal(new NativeConversationReader().transcriptPath(record), undefined);
assert.equal(new NativeConversationReader().hasArchive(record), false);
assert.throws(() => validateNativeDelete(record), /Antigravity/);
console.log("PASS: Antigravity 官方 ACP 配置、流式消息、审批、附件、原生追加及并发响应、取消、续接及原生历史隔离");
