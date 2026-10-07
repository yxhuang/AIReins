import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudeDriver } from "./drivers/claude.js";
import type { DriverCallbacks, UnifiedEvent } from "./types.js";

// 插话赶不上当前回合时，CLI 在 result 之后另起一轮；这期间会话不能显示空闲。
const statuses: string[] = [];
const callbacks: DriverCallbacks = {
  emit: () => undefined as UnifiedEvent | undefined,
  metadata: () => undefined,
  commands: () => undefined,
  status: (status) => { statuses.push(status); },
  exited: () => undefined,
};
const driver = new ClaudeDriver({ sessionId: "test", cwd: process.cwd(), config: {}, callbacks });
(driver as unknown as { child: ChildProcessWithoutNullStreams }).child = {
  stdin: { writable: true, write: () => true },
} as unknown as ChildProcessWithoutNullStreams;
const receive = (value: object) => (driver as unknown as { handleStdoutLine(line: string): void })
  .handleStdoutLine(JSON.stringify(value));
const echo = (text: string) => receive({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const result = () => receive({ type: "result", subtype: "success", result: "OK" });

await driver.sendUserMessage({ text: "first" });
echo("first");
await driver.sendUserMessage({ text: "late steer" });
result();
assert.equal(statuses.at(-1), "running", "未回显的插话会另起一轮，result 后保持 running");
echo("late steer");
result();
assert.equal(statuses.at(-1), "idle", "排队那轮结束后转空闲");

await driver.sendUserMessage({ text: "second" });
echo("second");
await driver.sendUserMessage({ text: "injected steer" });
echo("injected steer");
result();
assert.equal(statuses.at(-1), "idle", "已在当前回合注入的插话不多等一轮");

await driver.sendUserMessage({ text: "multi" });
echo("multi");
await driver.sendUserMessage({ text: "queued A" });
await driver.sendUserMessage({ text: "queued B" });
result();
assert.equal(statuses.at(-1), "running");
echo("queued A");
result();
assert.equal(statuses.at(-1), "running", "CLI 把排队插话拆成多轮时，B 那轮也保持 running");
echo("queued B");
result();
assert.equal(statuses.at(-1), "idle");

await driver.sendUserMessage({ text: "lost" });
echo("lost");
await driver.sendUserMessage({ text: "never echoed" });
result();
assert.equal(statuses.at(-1), "running");
result();
assert.equal(statuses.at(-1), "idle", "整轮没有插话回显就放弃等待，不永久卡在 running");

await driver.sendUserMessage({ text: "third" });
await driver.sendUserMessage({ text: "steer then stop" });
await driver.interrupt();
result();
assert.equal(statuses.at(-1), "idle", "中断后不等排队插话");
// 用户按停止：CLI 回显打断标记并以 error_during_execution 收尾，应回到空闲而非出错
const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
callbacks.emit = ((type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return undefined; }) as DriverCallbacks["emit"];
(driver as unknown as { remoteControl: { status: string } }).remoteControl.status = "connected";
await driver.sendUserMessage({ text: "long task" });
echo("long task");
await driver.interrupt();
echo("[Request interrupted by user]");
receive({ type: "result", subtype: "error_during_execution", is_error: true });
assert.equal(statuses.at(-1), "idle", "打断后的 error_during_execution 不进 error");
assert.ok(!events.some(e => e.type === "user_message"), "打断标记不当远程消息");
assert.equal(events.find(e => e.type === "turn_completed")?.payload.interrupted, true);
await driver.sendUserMessage({ text: "next" });
receive({ type: "result", subtype: "error_during_execution", is_error: true });
assert.equal(statuses.at(-1), "error", "未打断的真实错误照常报 error");
console.log("claude-steer-status ok");
