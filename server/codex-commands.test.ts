import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COMMANDS, codexSkillInputs, codexSkillsForCwd, parseCodexCommand } from "./codex-commands.js";
import { CodexDriver } from "./drivers/codex.js";
import type { DriverCallbacks, DriverOptions, UserMessageInput } from "./types.js";
import type { NativeConversationReader } from "./native-conversation.js";

assert.equal(CODEX_COMMANDS.length, 8);
for (const name of ["undo", "init", "diff", "prompts:mine", "config/value/write"]) {
  assert.throws(() => parseCodexCommand({ name }), /未知/);
}
assert.throws(() => parseCodexCommand({ name: "compact", arguments: "foo" }), /不接受参数/);
assert.throws(() => parseCodexCommand({ name: "review", arguments: 1 }), /arguments/);
assert.throws(() => parseCodexCommand({ name: "review", arguments: "x".repeat(8001) }), /arguments/);
assert.deepEqual(parseCodexCommand({ name: "review", arguments: " 看类型 " }), { name: "review", arguments: "看类型" });

const cwd = process.cwd();
const enabled = { name: "test-skill", description: "unique", path: "/skills/test/SKILL.md", scope: "user", enabled: true };
const listing = { data: [
  { cwd, skills: [enabled, { ...enabled, name: "off", enabled: false }], errors: [{ path: "/broken", message: "bad" }] },
  { cwd: "/other", skills: [{ ...enabled, name: "other" }], errors: [] },
] };
const parsed = codexSkillsForCwd(listing, cwd);
assert.deepEqual(parsed.skills, [enabled]);
assert.equal(parsed.errors.length, 1);
assert.deepEqual(codexSkillInputs("中文 $test-skill $test-skill", parsed.skills), [{ type: "skill", name: enabled.name, path: enabled.path }]);
for (const text of ["$test-skill-extra", "$test-skill/path", "foo$test-skill", "\\$test-skill", "$off", "$20"]) {
  assert.deepEqual(codexSkillInputs(text, parsed.skills), []);
}
assert.equal(codexSkillInputs("$a.b", [{ ...enabled, name: "a.b" }]).length, 1);
assert.throws(() => codexSkillInputs("$test-skill", [enabled, { ...enabled, path: "/other/SKILL.md" }]), /重复/);

const frames: any[] = [];
const statuses: string[] = [];
const catalog: any[] = [];
let rejectCompact = false;
const callbacks: DriverCallbacks = {
  emit: () => undefined, metadata: () => {}, commands: commands => catalog.push(commands),
  status: status => statuses.push(status), exited: () => {},
};
const driver = new CodexDriver({ sessionId: "test", cwd, config: {}, callbacks });
const internal = driver as any;
internal.spawnProcess = () => {};
internal.send = (frame: any) => {
  frames.push(frame);
  if (frame.id === undefined) return;
  const result = frame.method === "skills/list" ? listing
    : frame.method === "config/read" ? { config: { model: "test-model", model_reasoning_effort: "high" } }
    : frame.method === "model/list" ? { data: [{ id: "test-model", model: "test-model", isDefault: true }] }
    : frame.method === "thread/start" ? { thread: { id: "thread-test" }, model: "test-model", sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" }
    : frame.method === "mcpServerStatus/list" ? { data: [{ name: frame.params.cursor ? "two" : "one" }], nextCursor: frame.params.cursor ? null : "page-two" }
    : frame.method === "thread/read" ? { thread: { id: "thread-test" } }
    : frame.method === "review/start" || frame.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
  queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({ id: frame.id,
    ...(rejectCompact && frame.method === "thread/compact/start" ? { error: { message: "compact rejected" } } : { result }),
  })));
};
await driver.start();
assert.deepEqual(catalog[0], CODEX_COMMANDS);
const status = await driver.executeCommand("status") as any;
assert.equal(status.thread.id, "thread-test");
assert.deepEqual(frames.at(-1).params, { threadId: "thread-test", includeTurns: false });
const mcp = await driver.executeCommand("mcp") as any;
assert.equal(mcp.data.length, 2);
assert.equal(frames.at(-1).params.cursor, "page-two");
assert.equal(frames.at(-1).params.threadId, "thread-test");
await driver.sendUserMessage({ text: "$test-skill 只报告指令里的 unique" });
assert.equal(frames.at(-1).method, "turn/start");
assert.deepEqual(frames.at(-1).params.input[1], { type: "skill", name: enabled.name, path: enabled.path });
assert.equal(frames.at(-1).params.input[0].text.startsWith("$test-skill"), true);
await new Promise(resolve => setImmediate(resolve));
await driver.executeCommand("interrupt");
assert.equal(frames.at(-1).method, "turn/interrupt");
assert.deepEqual(frames.at(-1).params, { threadId: "thread-test", turnId: "turn-test" });
await driver.executeCommand("compact");
assert.deepEqual(frames.at(-1).params, { threadId: "thread-test" });
assert.equal(statuses.at(-1), "running", "ack 不冒充压缩完成");
internal.handleStdoutLine(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "compact-turn", status: "completed" } } }));
assert.equal(statuses.at(-1), "idle");
await driver.executeCommand("review", "只读审查");
assert.deepEqual(frames.at(-1).params, { threadId: "thread-test", delivery: "inline", target: { type: "custom", instructions: "只读审查" } });
await driver.executeCommand("review");
assert.deepEqual(frames.at(-1).params.target, { type: "uncommittedChanges" });
rejectCompact = true;
await assert.rejects(driver.executeCommand("compact"), /compact rejected/);
assert.equal(statuses.at(-1), "idle");
const count = frames.length;
await assert.rejects(driver.executeCommand("init"), /未知/);
assert.equal(frames.length, count);

process.env.WORKBENCH_HOME = mkdtempSync(join(tmpdir(), "wb-codex-commands-test-"));
const { SessionManager } = await import("./session-manager.js");
const options: DriverOptions[] = [];
const executions: string[] = [];
const manager = new SessionManager((agent, opts) => {
  options.push(opts);
  return {
    kind: agent, start: async () => { opts.callbacks.status("idle"); },
    getConfigSchema: () => ({ options: [], source: "test" }), setConfig: async c => c,
    queryInfo: async kind => ({ kind }), executeCommand: async name => { executions.push(name); opts.callbacks.status("running"); return {}; },
    sendUserMessage: async () => {}, resolvePermission: async () => {}, interrupt: async () => {}, stop: async () => {},
  };
}, () => ({ model: null, effort: null }));
try {
  const session = await manager.create({ agent: "codex", cwd, snapshot: "skip" });
  assert.deepEqual(await manager.queryInfo(session.id, "skills"), { kind: "skills" });
  await assert.rejects(manager.queryInfo(session.id, "settings"), /未知/);
  await manager.executeCodexCommand(session.id, { name: "compact" });
  await assert.rejects(manager.executeCodexCommand(session.id, { name: "compact" }), /执行与审批/);
  assert.deepEqual(executions, ["compact"]);
  options[0].callbacks.status("idle");
  await assert.rejects(manager.executeCodexCommand(session.id, { name: "interrupt" }), /没有可中断/);
  const next = await manager.executeCodexCommand(session.id, { name: "new" }) as any;
  assert.notEqual(next.session.id, session.id);
  assert.equal(next.session.cwd, session.cwd);
  assert.equal(manager.get(session.id)?.status, "idle", "new 保留原线程");
  await manager.sendUserMessage(session.id, { command: { name: "status" } });
  await assert.rejects(manager.sendUserMessage(session.id, { text: "mixed", command: { name: "review" } }), /不能附带/);
} finally { await manager.shutdown(); }
console.log("✅ Codex 命令 RPC、分页、状态限制、skill 路径解析与白名单");

const compactCalls: { agent: string; method: string; input: unknown }[] = [];
const compactWorkers: DriverOptions[] = [];
let compactWait = Promise.resolve();
const compactor = new SessionManager((agent, opts) => {
  compactWorkers.push(opts);
  const invoke = async (method: string, input: unknown) => {
    compactCalls.push({ agent, method, input });
    await compactWait;
    opts.callbacks.status("running");
  };
  return {
    kind: agent,
    start: async () => {
      opts.callbacks.metadata({ nativeSessionId: opts.resumeSessionId ?? `native-${opts.sessionId}` });
      opts.callbacks.status("idle");
    },
    getConfigSchema: () => ({ options: [], source: "test" }), setConfig: async config => config,
    executeCommand: name => invoke("executeCommand", name),
    sendUserMessage: (message: UserMessageInput) => invoke("sendUserMessage", message),
    askSideQuestion: async () => { await compactWait; return {}; },
    resolvePermission: async () => {}, interrupt: async () => {}, stop: async () => {},
  };
}, () => ({ model: null, effort: null }), undefined, {
  capture: async () => ({ path: "/fixture", identity: "saved", offset: 0, size: 0 }),
  changed: async () => undefined,
} as unknown as NativeConversationReader);
try {
  for (const agent of ["claude", "codex", "kimi"] as const) {
    const session = await compactor.create({ agent, cwd, snapshot: "skip" });
    await new Promise<void>(resolve => setImmediate(resolve));
    const originalWorker = compactWorkers.at(-1)!;
    originalWorker.callbacks.status("running");
    await assert.rejects(compactor.compactContext(session.id), /执行与审批/);
    originalWorker.callbacks.status("idle");
    originalWorker.callbacks.emit("permission_request", { requestId: "compact-gate" });
    await assert.rejects(compactor.compactContext(session.id), /执行与审批/);
    originalWorker.callbacks.emit("permission_resolved", { requestId: "compact-gate" });
    originalWorker.callbacks.metadata({ backgroundTasks: [{ id: "compact-background", type: "agent", description: "running" }] });
    await assert.rejects(compactor.compactContext(session.id), /执行与审批/);
    originalWorker.callbacks.metadata({ backgroundTasks: [] });
    assert.equal(compactCalls.filter(call => call.agent === agent).length, 0);

    let finish!: () => void;
    compactWait = new Promise<void>(resolve => { finish = resolve; });
    const compressing = compactor.compactContext(session.id);
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(compactor.compactContext(session.id), /执行与审批/);
    finish();
    await compressing;
    assert.deepEqual(compactCalls.at(-1), { agent, method: agent === "codex" ? "executeCommand" : "sendUserMessage",
      input: agent === "codex" ? "compact" : { command: { name: "compact" } } });
    assert.equal(compactCalls.filter(call => call.agent === agent).length, 1, "duplicate requests cannot reach the native worker");
    const command = compactor.getSnapshot(session.id)!.events.filter(event => event.type === "user_message").at(-1)!;
    assert.deepEqual(command.payload, { command: { name: "compact" } }, "compression uses native commands without summary text");

    originalWorker.callbacks.status("idle");
    if (agent !== "kimi") {
      compactWait = new Promise<void>(resolve => { finish = resolve; });
      const side = compactor.askSideQuestion(session.id, { question: "side" }, new AbortController().signal);
      await assert.rejects(compactor.compactContext(session.id), /执行与审批/);
      finish();
      await side;
    }
    compactWait = Promise.resolve();
    await compactor.release(session.id, "manual");
    await compactor.compactContext(session.id);
    assert.equal(compactWorkers.at(-1)!.resumeSessionId, `native-${session.id}`, "released sessions resume the same native conversation");
    assert.equal(compactor.get(session.id)!.released, undefined);
  }
  await assert.rejects(compactor.compactContext("missing"), /会话不存在/);
} finally { await compactor.shutdown(); }
console.log("✅ 三家原生压缩路由、运行/审批/重复/侧问守卫与已释放会话原地续接");
