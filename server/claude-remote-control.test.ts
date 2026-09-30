import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudeDriver } from "./drivers/claude.js";
import type { DriverCallbacks, RemoteControlState, UnifiedEvent } from "./types.js";

const sent: Record<string, any>[] = [];
const states: RemoteControlState[] = [];
const events: { type: string; payload: Record<string, unknown> }[] = [];
const statuses: string[] = [];
const callbacks: DriverCallbacks = {
  emit: (type, payload = {}) => { events.push({ type, payload }); return undefined as UnifiedEvent | undefined; },
  metadata: (value) => { if (value.remoteControl) states.push(value.remoteControl); },
  commands: () => undefined,
  status: (status) => { statuses.push(status); },
  exited: () => undefined,
};
const driver = new ClaudeDriver({ sessionId: "test", cwd: process.cwd(), config: {}, callbacks });
(driver as unknown as { child: ChildProcessWithoutNullStreams }).child = {
  stdin: { writable: true, write: (line: string) => { sent.push(JSON.parse(line)); return true; } },
} as unknown as ChildProcessWithoutNullStreams;
const receive = (value: object) => (driver as unknown as { handleStdoutLine(line: string): void })
  .handleStdoutLine(JSON.stringify(value));
const user = (text: string, fields: object = {}) => ({
  type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...fields,
});

receive(user("RC is off"));
assert.equal(events.length, 0, "RC 关闭时不把普通 user 文本当远程消息");
assert.equal(statuses.length, 0, "RC 关闭时不改变会话状态");
receive({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] } });
assert.deepEqual(events.at(-1), { type: "tool_call_completed", payload: { toolCallId: "tool-1", result: "done", isError: false } });
assert.equal(statuses.length, 0, "RC 关闭时仍按原路径处理工具结果");

const enabling = driver.setRemoteControl(true);
assert.equal(states.at(-1)?.status, "connecting");
assert.deepEqual(sent.at(-1)?.request, { subtype: "remote_control", enabled: true });
receive(user("arrived while connecting"));
assert.deepEqual(events.at(-1), { type: "user_message", payload: { text: "arrived while connecting", source: "remote_control" } });
receive({ type: "system", subtype: "bridge_state", state: "unknown-future-state" });
assert.equal(states.at(-1)?.status, "connecting");
receive({ type: "control_response", response: { subtype: "success", request_id: sent.at(-1)?.request_id,
  response: { session_url: "https://claude.ai/code/session_01test" } } });
assert.equal((await enabling).status, "connected");
receive({ type: "system", subtype: "bridge_state", state: "ready" });
assert.equal(states.at(-1)?.status, "reconnecting");
receive({ type: "system", subtype: "bridge_state", state: "connected" });
assert.equal(states.at(-1)?.status, "connected");

const ignored = [
  user("subagent text", { parent_tool_use_id: "tool-123" }),
  user("synthetic text", { isSynthetic: true }),
  user("meta text", { isMeta: true }),
  user("compact text", { isCompactSummary: true }),
  user("transcript-only text", { isVisibleInTranscriptOnly: true }),
  user("sidechain text", { isSidechain: true }),
  { type: "user", message: { role: "user", isMeta: true, content: [{ type: "text", text: "nested meta" }] } },
  user("Base directory for this skill: /tmp/example"),
  user("<command-name>/help</command-name>"),
  user("<local-command-stdout>output</local-command-stdout>"),
  user("<system-reminder>injected</system-reminder>"),
  user("<skills_instructions>injected</skills_instructions>"),
];
const beforeIgnored = [events.length, statuses.length];
for (const message of ignored) receive(message);
assert.deepEqual([events.length, statuses.length], beforeIgnored, "子代理与合成/注入内容不得成为远程消息");

await driver.sendUserMessage({ text: "local message" });
receive({ type: "result", subtype: "success" });
const beforeDelayedEcho = [events.length, statuses.length];
receive(user("local message"));
assert.deepEqual([events.length, statuses.length], beforeDelayedEcho, "result 后的本机延迟回显不得重复渲染");
receive(user("phone message"));
assert.deepEqual(events.at(-1), { type: "user_message", payload: { text: "phone message", source: "remote_control" } });
assert.equal(statuses.at(-1), "running");

const disabling = driver.setRemoteControl(false);
assert.equal(states.at(-1)?.status, "disconnecting");
const beforeDisconnecting = [events.length, statuses.length];
receive(user("while disconnecting"));
assert.deepEqual([events.length, statuses.length], beforeDisconnecting);
receive({ type: "control_response", response: { subtype: "success", request_id: sent.at(-1)?.request_id, response: {} } });
assert.equal((await disabling).status, "disconnected");
const beforeOff = [events.length, statuses.length];
receive(user("RC is off again"));
assert.deepEqual([events.length, statuses.length], beforeOff);
receive({ type: "control_request", request_id: "secret-1", request: { subtype: "remote_control_work_secret" } });
assert.deepEqual(sent.at(-1)?.response, {
  subtype: "error", request_id: "secret-1",
  error: "不支持的 Claude control_request: remote_control_work_secret",
});
const failing = driver.setRemoteControl(true);
receive({ type: "control_response", response: { subtype: "error", request_id: sent.at(-1)?.request_id,
  error: "bridge unavailable" } });
await assert.rejects(failing, /bridge unavailable/);
assert.deepEqual(states.at(-1), { status: "error", reason: "bridge unavailable" });

console.log("Claude Remote Control 状态与控制请求通过");
