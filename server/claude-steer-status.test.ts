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
console.log("claude-steer-status ok");
