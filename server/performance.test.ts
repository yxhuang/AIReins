import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverOptions, UnifiedEvent } from "./types.js";
import type { NativeConversationReader } from "./native-conversation.js";

const home = mkdtempSync(join(tmpdir(), "wb-performance-test-"));
process.env.WORKBENCH_HOME = home;
const [{ SessionManager }, { ClaudeDriver }, { registryPath }] = await Promise.all([
  import("./session-manager.js"), import("./drivers/claude.js"), import("./persistence.js"),
]);
const { sessionTitle: frontendTitle } = await import(new URL("../frontend/src/format.ts", import.meta.url).href);
class TestClaude extends ClaudeDriver {
  async start() { this.callbacks.status("idle"); }
  async stop() {}
  receive(message: object) { this.handleStdoutLine(JSON.stringify(message)); }
}
const drivers: TestClaude[] = [];
const factory = (_kind: unknown, options: DriverOptions) => {
  const driver = new TestClaude(options); drivers.push(driver); return driver;
};
const reader = { capture: async () => undefined } as unknown as NativeConversationReader;
const manager = new SessionManager(factory, () => ({ model: null, effort: null, remoteControlAtStartup: false }), undefined, reader);
const session = await manager.create({ agent: "claude", cwd: home });
const driver = drivers[0]!;
const frames: UnifiedEvent[] = [];
manager.onEvent((event) => frames.push(event));
const callbacks = (driver as unknown as { callbacks: DriverOptions["callbacks"] }).callbacks;
const stream = (event: object) => driver.receive({ type: "stream_event", session_id: "native-test", event });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "Read", input: {} } });
const seq = manager.get(session.id)!.seq;
for (let i = 0; i < 200; i++) stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x" } });
assert.equal(frames.filter((event) => event.ephemeral).length, 1, "突发更新只推一次");
assert.equal(manager.get(session.id)!.seq, seq, "临时更新不占 seq");
assert.equal(manager.getSnapshot(session.id)!.events.some((event) => event.ephemeral), false);
assert.equal(manager.getEventsAfter(session.id, seq)!.events.length, 0, "临时更新不进 ring");
await wait(130);
assert.equal(frames.filter((event) => event.ephemeral).length, 2, "100ms trailing 推出最新参数");
assert.equal(frames.at(-1)!.payload.partialInput, "x".repeat(200));
assert.equal(frames.at(-1)!.seq, seq);
stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "y" } });
stream({ type: "content_block_stop", index: 0 });
assert.equal(frames.at(-2)!.ephemeral, true, "最终参数落盘前先推出待发更新");
assert.equal(frames.at(-2)!.payload.partialInput, "x".repeat(200) + "y");
assert.equal(frames.at(-1)!.payload.inputComplete, true);
assert.equal(manager.getSnapshot(session.id)!.events.at(-1)!.payload.input, "x".repeat(200) + "y");
for (const boundary of ["tool_call_completed", "permission_request", "turn_completed", "session_error"] as const) {
  callbacks.emit("tool_call_updated", { toolCallId: boundary, partialInput: "first" });
  callbacks.emit("tool_call_updated", { toolCallId: boundary, partialInput: "last" });
  callbacks.emit(boundary, { requestId: "gate", toolCallId: boundary });
  assert.equal(frames.at(-2)!.ephemeral, true);
  assert.equal(frames.at(-2)!.payload.partialInput, "last");
  assert.equal(frames.at(-1)!.type, boundary);
}
callbacks.emit("tool_call_updated", { toolCallId: "manager-error", partialInput: "first" });
callbacks.emit("tool_call_updated", { toolCallId: "manager-error", partialInput: "last" });
(manager as unknown as { emit(id: string, type: "session_error", payload: object): void }).emit(session.id, "session_error", { message: "manager failure" });
assert.equal(frames.at(-2)!.payload.partialInput, "last", "SessionManager 自身报错前也推出待发参数");
await wait(130);
assert.equal(frames.at(-1)!.type, "session_error", "完成后没有迟到 timer 更新");
assert.equal(manager.list()[0]!.pendingGateCount, 1);
callbacks.emit("permission_resolved", { requestId: "gate" });
assert.equal(manager.list()[0]!.pendingGateCount, 0);
callbacks.commands([{ name: "test", source: "claude", description: "one" }]);
const commandsSeq = manager.get(session.id)!.seq;
callbacks.commands([{ description: "one", source: "claude", name: "test" }]);
assert.equal(manager.get(session.id)!.seq, commandsSeq);
callbacks.commands([{ name: "test", source: "claude", description: "two" }]);
assert.equal(manager.get(session.id)!.seq, commandsSeq + 1);
const restored = new SessionManager(factory, () => ({ model: null, effort: null, remoteControlAtStartup: false }), undefined, reader);
assert.deepEqual(restored.getCommands(session.id), [{ name: "test", source: "claude", description: "two" }]);
const restoredInternal = restored as unknown as { workers: Map<string, TestClaude>; driverCallbacks(id: string, worker: () => TestClaude): DriverOptions["callbacks"] };
restoredInternal.workers.set(session.id, driver);
restoredInternal.driverCallbacks(session.id, () => driver).commands([{ name: "test", source: "claude", description: "two" }]);
assert.equal(restored.get(session.id)!.seq, commandsSeq + 1, "恢复后相同命令表仍去重");
assert.equal(restored.list()[0]!.pendingGateCount, 0, "dead 会话审批数为零");

for (const text of ["", " hello \n world ", "中文标题".repeat(10), "a".repeat(31), "😀test"]) {
  const sample = await manager.create({ agent: "claude", cwd: home });
  const cb = (drivers.at(-1)! as unknown as { callbacks: DriverOptions["callbacks"] }).callbacks;
  cb.emit("user_message", { text }); cb.emit("user_message", { text: "later" });
  const events = manager.getSnapshot(sample.id)!.events;
  assert.equal(manager.list().find((item) => item.id === sample.id)!.title, frontendTitle({}, events));
}

for (const agent of ["codex", "kimi"] as const) {
  const other = await manager.create({ agent, cwd: home });
  const cb = (drivers.at(-1)! as unknown as { callbacks: DriverOptions["callbacks"] }).callbacks;
  const seq = manager.get(other.id)!.seq;
  cb.emit("tool_call_updated", { toolCallId: "t", partialInput: "first" });
  cb.emit("tool_call_updated", { toolCallId: "t", partialInput: "last" });
  assert.equal(manager.get(other.id)!.seq, seq + 2, "Codex/Kimi 更新仍为持久事件");
  assert.equal(manager.getSnapshot(other.id)!.events.at(-1)!.ephemeral, undefined);
}

callbacks.status("running");
const baseline = readFileSync(registryPath, "utf8");
const inode = statSync(registryPath).ino;
for (let i = 0; i < 100; i++) callbacks.emit("agent_text_delta", { text: "a" });
assert.equal(readFileSync(registryPath, "utf8"), baseline, "流式事件不逐条重写登记表");
assert.equal(statSync(registryPath).ino, inode);
await wait(1050);
assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).find((item: { id: string }) => item.id === session.id).seq, manager.get(session.id)!.seq);
const unchanged = statSync(registryPath).ino;
callbacks.metadata({ nativeSessionId: "native-test" });
assert.equal(statSync(registryPath).ino, unchanged, "未变 metadata 不写盘");
let metadataCalls = 0;
const metadata = callbacks.metadata;
callbacks.metadata = (value) => { metadataCalls++; metadata(value); };
for (let i = 0; i < 20; i++) driver.receive({ type: "assistant", session_id: "native-test" });
assert.equal(metadataCalls, 0, "Claude 不重复报告相同 session_id");
callbacks.emit("agent_text_delta", { text: "final" });
callbacks.status("idle");
assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).find((item: { id: string }) => item.id === session.id).seq, manager.get(session.id)!.seq, "状态边界立即保存");
callbacks.emit("agent_text_delta", { text: "shutdown" });
await manager.shutdown();
assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).find((item: { id: string }) => item.id === session.id).seq, manager.get(session.id)!.seq, "退出保存未写内容");
await restored.shutdown();
console.log("✅ performance: ephemeral/throttle/flush, commands recovery, summary/title, registry batching/shutdown");
