import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { DriverOptions, UnifiedEvent } from "./types.js";
import type { NativeConversationReader } from "./native-conversation.js";
import { parseSideQuestion, parseTaskId, supportsClaudeFastMode } from "./session-menu.js";
import { cleanSessionConfig, configFromCreateInput } from "./session-config.js";

const root = mkdtempSync(join(tmpdir(), "wb-menu-controls-"));
process.env.WORKBENCH_HOME = join(root, "wb");
process.env.CLAUDE_CONFIG_DIR = join(root, "config");
const [{ ClaudeDriver }, { SessionManager }] = await Promise.all([import("./drivers/claude.js"), import("./session-manager.js")]);
const models = [{ value: "default", resolvedModel: "opus-native", supportsFastMode: true }, { value: "opus", resolvedModel: "opus-native", supportsFastMode: true }, { value: "haiku", resolvedModel: "haiku-native" }];
assert.equal(supportsClaudeFastMode(models, null), true);
for (const model of ["opus", "opus[1m]", "opus-native", "opus-native[1m]"]) assert.equal(supportsClaudeFastMode(models, model), true);
for (const model of ["haiku", "haiku-native", "unknown"]) assert.equal(supportsClaudeFastMode(models, model), false);
assert.equal(supportsClaudeFastMode([{ value: "opus" }], "opus"), false);
assert.equal(supportsClaudeFastMode(null, "opus"), false);
assert.deepEqual(cleanSessionConfig({ thinkingLevel: "off", model: " haiku " }), { thinkingLevel: "off", model: "haiku" });
assert.equal(configFromCreateInput({ agent: "codex", cwd: root, config: { thinkingLevel: "off" } }).thinkingLevel, undefined);
assert.deepEqual(parseSideQuestion({ question: " q ", history: [{ question: "old", response: "answer", extra: "discard" }] }), { question: "q", history: [{ question: "old", response: "answer" }] });
for (const value of [null, [], {}, { question: " " }, { question: "x".repeat(20001) }, { question: "q", history: Array(21).fill({ question: "q", response: "a" }) }, { question: "q", history: [null] }]) assert.throws(() => parseSideQuestion(value));
for (const value of [null, {}, { taskId: " " }, { taskId: "x\ny" }]) assert.throws(() => parseTaskId(value));
assert.equal(parseTaskId({ taskId: "task1" }), "task1");

class FixtureCLI extends ClaudeDriver {
  ready!: Promise<void>;
  start() { return this.ready = super.start(); }
  frames: Record<string, any>[] = [];
  failThinking = false;
  pendingSide = false;
  protected spawnProcess(_command: string, _args: string[], _options: SpawnOptionsWithoutStdio) {
    this.child = { pid: 123, stdin: { writable: true } } as unknown as ChildProcessWithoutNullStreams;
    this.callbacks.metadata({ nativeSessionId: "fixture-native" });
  }
  protected send(value: unknown) {
    const frame = value as Record<string, any>; this.frames.push(frame);
    if (frame.type !== "control_request" || (frame.request.subtype === "side_question" && this.pendingSide)) return;
    queueMicrotask(() => this.receive({ type: "control_response", response: { request_id: frame.request_id,
      subtype: this.failThinking && frame.request.subtype === "set_max_thinking_tokens" ? "error" : "success",
      ...(this.failThinking ? { error: "thinking rejected" } : { response: frame.request.subtype === "initialize" ? { commands: [], models } : frame.request.subtype === "side_question" ? { response: "4", synthetic: false } : {} }) } }));
  }
  receive(value: unknown) { this.handleStdoutLine(JSON.stringify(value)); }
  async stop() {}
  async sendUserMessage() { this.callbacks.status("running"); }
  metadata(value: Parameters<DriverOptions["callbacks"]["metadata"]>[0]) { this.callbacks.metadata(value); }
  gate() { this.callbacks.emit("permission_request", { requestId: "gate" }); }
  idle() { this.callbacks.status("idle"); }
}
const drivers: FixtureCLI[] = [];
const nativeReader = { capture: async () => ({ nativeSessionId: "fixture-native", path: join(root, "native"), size: 0 }), changed: async () => undefined } as unknown as NativeConversationReader;
const manager = new SessionManager((_agent, opts) => { const cli = new FixtureCLI(opts); drivers.push(cli); return cli; }, () => ({ model: null, effort: null }), async () => null, nativeReader);
const events: UnifiedEvent[] = []; manager.onEvent(event => events.push(event));
try {
  const session = await manager.create({ agent: "claude", cwd: root, snapshot: "skip", config: { model: "haiku", thinkingLevel: "off" }, resumeSessionId: "fixture-native" });
  await drivers[0].ready;
  const cli = drivers[0];
  assert.deepEqual(cli.frames[1].request, { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 });
  assert.equal(manager.get(session.id)!.config.thinkingLevel, "off");
  assert.deepEqual(await manager.queryInfo(session.id, "capabilities"), { supportsFastMode: false });
  await manager.setThinking(session.id, true);
  assert.deepEqual(cli.frames.at(-1)!.request, { subtype: "set_max_thinking_tokens", max_thinking_tokens: 31999, thinking_display: null });
  assert.equal(manager.get(session.id)!.config.thinkingLevel, "default_on");
  assert.equal(events.at(-1)!.type, "config_updated");
  await manager.sendUserMessage(session.id, { text: "fixture" });
  await manager.setThinking(session.id, false); // busy safe, like extension
  assert.equal(manager.get(session.id)!.config.thinkingLevel, "off");
  cli.failThinking = true;
  await assert.rejects(manager.setThinking(session.id, true), /thinking rejected/);
  assert.equal(manager.get(session.id)!.config.thinkingLevel, "off", "失败不能持久化未应用值"); cli.failThinking = false;
  cli.receive({ type: "result", is_error: true });
  await manager.setThinking(session.id, false); // 回复出错不等于 worker 已结束。
  cli.metadata({ backgroundTasks: [{ id: "task1", type: "shell", description: "fixture task" }] });
  await assert.rejects(manager.stopTask(session.id, "other"), /不在当前/);
  await manager.stopTask(session.id, "task1");
  assert.deepEqual(cli.frames.at(-1)!.request, { subtype: "stop_task", task_id: "task1" });
  assert.equal(manager.get(session.id)!.backgroundTasks?.length, 1, "success 不能伪造任务列表");
  cli.receive({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  assert.equal(manager.get(session.id)!.backgroundTasks?.length, 0);
  const before = events.length;
  const answer = await manager.askSideQuestion(session.id, { question: "2+2?", history: [{ question: "old", response: "a" }] }, new AbortController().signal);
  assert.deepEqual(answer, { response: "4", synthetic: false });
  assert.equal(events.length, before, "侧问不写入主线事件");
  cli.pendingSide = true;
  const cancel = new AbortController();
  const side = manager.askSideQuestion(session.id, { question: "cancel me" }, cancel.signal);
  const rejected = assert.rejects(side, /取消/);
  await new Promise(resolve => setImmediate(resolve));
  const sideId = cli.frames.at(-1)!.request_id;
  cli.receive({ type: "system", subtype: "control_request_progress", request_id: sideId, status: "started" });
  assert.equal(events.length, before);
  await assert.rejects(manager.askSideQuestion(session.id, { question: "duplicate" }, cancel.signal), /尚未结束/);
  await assert.rejects(manager.setConfig(session.id, { model: "opus" }), /侧问结束/);
  cancel.abort(); await rejected;
  assert.deepEqual(cli.frames.at(-1), { type: "control_cancel_request", request_id: sideId });
  cli.receive({ type: "control_response", response: { subtype: "success", request_id: sideId, response: { response: "late" } } });
  assert.equal(events.length, before, "取消后的迟到答案不进事件流"); cli.pendingSide = false; cli.idle();
  await manager.release(session.id, "manual");
  await manager.setThinking(session.id, true);
  assert.equal(drivers.length, 1, "释放后只保存，不启动 worker");
  assert.equal(manager.get(session.id)!.config.thinkingLevel, "default_on");
  await manager.queryInfo(session.id, "capabilities");
  assert.equal(drivers.length, 2);
  assert.deepEqual(drivers[1].frames[1].request, { subtype: "set_max_thinking_tokens", max_thinking_tokens: 31999, thinking_display: null });
  const saved = JSON.parse(readFileSync(join(root, "wb", "sessions.json"), "utf8"));
  assert.match(JSON.stringify(saved), /"thinkingLevel":"default_on"/);
  // Follow configured model and CLI's actual init model, rather than model-name guessing.
  await drivers[1].setConfig({ model: "opus" });
  assert.deepEqual(await drivers[1].queryInfo("menu_capabilities"), { supportsFastMode: true });
  await drivers[1].setConfig({ model: null });
  drivers[1].receive({ type: "system", subtype: "init", model: "haiku-native" });
  assert.deepEqual(await drivers[1].queryInfo("menu_capabilities"), { supportsFastMode: false });
  await assert.rejects(manager.stopTask(session.id, "task1"), /不在当前/);
} finally { await manager.shutdown(); }
console.log("✅ Claude 菜单：Thinking 持久化/续接/失败、Fast 能力、任务白名单、侧问并发/取消/事件隔离");
