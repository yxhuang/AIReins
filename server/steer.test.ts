import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentKind, DriverOptions, UnifiedEvent } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-steer-test-"));
process.env.WORKBENCH_HOME = join(fixture, "wb");
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(fixture, "claude");
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(fixture, "codex");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(fixture, "kimi");
const [{ SessionManager }, { ClaudeDriver }, { CodexDriver }, { KimiDriver }] = await Promise.all([
  import("./session-manager.js"), import("./drivers/claude.js"), import("./drivers/codex.js"), import("./drivers/kimi.js"),
]);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

// Fake CLI NDJSON transport. Keep the production serializers/RPC handler and driver lifecycle.
function fakeCli(kind: AgentKind, options: DriverOptions) {
  const Driver = { claude: ClaudeDriver, codex: CodexDriver, kimi: KimiDriver }[kind];
  const driver = new Driver(options);
  const internal = driver as any;
  const frames: any[] = [];
  let turn = 0, rejectSteer = false, holdStart = false;
  let heldReply: any;
  const receive = (frame: any) => internal.handleStdoutLine(JSON.stringify(frame));
  const reply = (frame: any, result: any) => receive({ id: frame.id, result });
  driver.child = { pid: 100, stdin: { writable: true, write(line: string) {
    const frame = JSON.parse(line); frames.push(frame);
    if (frame.method === "turn/start") {
      const response = { id: frame.id, result: { turn: { id: `turn-${++turn}` } } };
      if (holdStart) heldReply = response;
      else queueMicrotask(() => receive(response));
    } else if (frame.method === "turn/steer") {
      queueMicrotask(() => receive(rejectSteer
        ? { id: frame.id, error: { message: "active turn mismatch" } }
        : { id: frame.id, result: { turnId: `turn-${turn}` } }));
    } else if (frame.method === "turn/interrupt") queueMicrotask(() => reply(frame, {}));
  } } } as unknown as ChildProcessWithoutNullStreams;
  driver.start = async () => {
    internal.threadId = "thread-test";
    internal.nativeSessionId = "session-test";
    options.callbacks.metadata({}); // no real native history
    options.callbacks.status("idle");
  };
  driver.stop = async () => { internal.cancelQueuedPrompts?.("测试 worker 停止"); };
  const finish = (error = false) => {
    if (kind === "codex") receive({ method: "turn/completed", params: { turn: { id: `turn-${turn}`, status: "completed" } } });
    else if (kind === "claude") receive({ type: "result", subtype: "success", result: "OK" });
    else {
      const prompt = frames.filter(frame => frame.method === "session/prompt").at(-1);
      receive({ id: prompt.id, ...(error ? { error: { message: "prompt failed" } } : { result: { stopReason: "end_turn" } }) });
    }
  };
  return { driver, frames, receive, finish, options,
    holdStart: () => { holdStart = true; },
    releaseStart: () => { holdStart = false; receive(heldReply); },
    rejectSteer: () => { rejectSteer = true; },
    exit: () => internal.handleProcessExit(),
  };
}
const fakes: ReturnType<typeof fakeCli>[] = [];
const events: UnifiedEvent[] = [];
const manager = new SessionManager((kind, options) => {
  const fake = fakeCli(kind, options); fakes.push(fake); return fake.driver;
});
manager.onEvent(event => events.push(event));
const messages = (id: string) => events.filter(event => event.sessionId === id && event.type === "user_message");
try {
  for (const kind of ["claude", "codex", "kimi"] as const) {
    const session = await manager.create({ agent: kind, cwd: fixture, snapshot: "skip" });
    const h = fakes.at(-1)!;
    await manager.sendUserMessage(session.id, { text: "第一轮" });
    await settle();
    assert.equal(messages(session.id).at(-1)!.payload.steer, undefined, "空闲发送不标插话");
    const count = h.frames.length;
    await manager.sendUserMessage(session.id, { text: "只回复 OK" });
    assert.equal(messages(session.id).at(-1)!.payload.steer, true);
    if (kind === "claude") {
      assert.equal(h.frames.at(-1).type, "user");
      assert.equal(h.frames.at(-1).priority, undefined, "保持 CLI 默认 next，不能误用 now");
      assert.equal(h.frames.some(frame => frame.request?.subtype === "interrupt"), false);
      // 真实 CLI 注入插话时会回显（--replay-user-messages）；没回显的插话会在 result 后另起一轮。
      h.receive({ type: "user", message: { role: "user", content: [{ type: "text", text: "只回复 OK" }] } });
    } else if (kind === "codex") {
      assert.deepEqual(h.frames.at(-1).params, { threadId: "thread-test", expectedTurnId: "turn-1", input: [{ type: "text", text: "只回复 OK", text_elements: [] }] });
      assert.equal(h.frames.at(-1).method, "turn/steer");
      assert.equal(h.frames.filter(frame => frame.method === "turn/start").length, 1);
      const interruption = manager.interrupt(session.id); await interruption;
      assert.equal(h.frames.at(-1).params.turnId, "turn-1", "插话不能丢失中断目标");
    } else {
      assert.equal(h.frames.length, count, "Kimi busy 时不能再次发 session/prompt");
      assert.equal(messages(session.id).at(-1)!.payload.queued, true);
      await manager.sendUserMessage(session.id, { text: "第二条排队" });
      h.finish(); await settle();
      assert.equal(h.frames.at(-1).params.prompt[0].text, "只回复 OK");
      assert.equal(manager.get(session.id)!.status, "running", "队列排空前不能回到 idle");
      h.finish(); await settle();
      assert.equal(h.frames.at(-1).params.prompt[0].text, "第二条排队", "FIFO");
    }
    h.finish(); await settle();
    assert.equal(manager.get(session.id)!.status, "idle");
    await manager.sendUserMessage(session.id, { text: "普通新回合" });
    assert.equal(messages(session.id).at(-1)!.payload.steer, undefined);
    if (kind === "codex") assert.equal(h.frames.at(-1).method, "turn/start");
    h.finish(); await settle();
    // Gate policy: reject before writing to the CLI or emitting user_message.
    h.options.callbacks.status("running");
    h.options.callbacks.emit("permission_request", { requestId: "gate-1" });
    const before = h.frames.length, beforeMessages = messages(session.id).length;
    await assert.rejects(manager.sendUserMessage(session.id, { text: "闸门中插话" }), /待处理的审批闸门/);
    assert.equal(h.frames.length, before); assert.equal(messages(session.id).length, beforeMessages);
    h.options.callbacks.emit("permission_resolved", { requestId: "gate-1" });
    h.options.callbacks.status("idle");
  }

  // Start acknowledgment race, attachments, pending config, and steer rejection stay in one turn.
  {
    const s = await manager.create({ agent: "codex", cwd: fixture, snapshot: "skip" });
    const h = fakes.at(-1)!; h.holdStart();
    await manager.sendUserMessage(s.id, { text: "启动" });
    const image = join(fixture, "shot.png"), file = join(fixture, "note.txt");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47])); await writeFile(file, "note");
    await h.driver.setConfig({ model: null });
    const steering = manager.sendUserMessage(s.id, { text: "看 @note.txt", mentions: [{ type: "image", path: image, mimeType: "image/png" }, { type: "file", path: file }] });
    await settle(); assert.equal(h.frames.length, 1, "等待启动 ID，不另开回合");
    h.releaseStart(); await steering;
    const params = h.frames.at(-1).params;
    assert.equal(params.expectedTurnId, "turn-1");
    assert.equal(params.input.find((x: any) => x.type === "localImage").path, image);
    assert.equal(params.input.find((x: any) => x.type === "mention").path, file);
    assert.equal(Object.hasOwn(params, "model"), false, "插话不能携带新回合配置");
    assert.equal((h.driver as any).pendingConfigFields.has("model"), true);
    h.rejectSteer(); const before = messages(s.id).length;
    await assert.rejects(manager.sendUserMessage(s.id, { text: "被拒的插话" }), /active turn mismatch/);
    assert.equal(messages(s.id).length, before, "拒绝的插话不得记作已接受");
    assert.equal(manager.get(s.id)!.status, "running");
    h.finish(); await settle();
    await assert.rejects(h.driver.sendUserMessage({ text: "迟到" }, { steer: true }), /没有可插话的回合/);
  }

  for (const cancel of ["interrupt", "error", "exit"] as const) {
    const s = await manager.create({ agent: "kimi", cwd: fixture, snapshot: "skip" });
    const h = fakes.at(-1)!;
    await manager.sendUserMessage(s.id, { text: "工作" });
    await manager.sendUserMessage(s.id, { text: "排队" });
    if (cancel === "interrupt") { await manager.interrupt(s.id); h.finish(); }
    if (cancel === "error") h.finish(true);
    if (cancel === "exit") h.exit();
    await settle();
    assert.equal(h.frames.filter(frame => frame.method === "session/prompt").length, 1);
    assert.ok(events.some(event => event.sessionId === s.id && event.payload.source === "steer_queue" && /已取消/.test(String(event.payload.message))));
  }
  console.log("✅ steering：三家发送、Codex 回合/附件/拒绝竞态、Kimi FIFO/取消、审批闸门契约通过");
} finally { await manager.shutdown(); }
