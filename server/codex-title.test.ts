import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { CodexDriver } from "./drivers/codex.js";
import type { DriverCallbacks, DriverOptions } from "./types.js";

const metadata: any[] = [];
const callbacks: DriverCallbacks = {
  emit: () => undefined, metadata: value => { metadata.push(value); },
  commands() {}, status() {}, exited() {},
};
const driver = new CodexDriver({ sessionId: "wb-title", cwd: process.cwd(), config: {}, resumeSessionId: "native-thread", callbacks });
const internal = driver as any;
internal.spawnProcess = () => undefined;
internal.send = (frame: any) => {
  if (frame.id === undefined) return;
  const result = frame.method === "model/list" ? { data: [] }
    : frame.method === "config/read" ? { config: {} }
    : frame.method === "thread/resume" ? { thread: { id: "native-thread", name: "CLI生成的原生概括" } } : {};
  queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({ id: frame.id, result })));
};
await driver.start();
assert.equal(metadata.at(-1).nativeTitle, "CLI生成的原生概括");
internal.handleStdoutLine(JSON.stringify({ method: "thread/name/updated", params: { threadId: "native-thread", threadName: "更新后的概括" } }));
assert.equal(metadata.at(-1).nativeTitle, "更新后的概括");
const count = metadata.length;
for (const params of [{ threadId: "different", threadName: "错误会话" }, { threadId: "native-thread", threadName: null }]) {
  internal.handleStdoutLine(JSON.stringify({ method: "thread/name/updated", params }));
}
assert.equal(metadata.length, count);
console.log("PASS: Codex resume title, native name notification, foreign-thread/null isolation");

interface Scenario {
  name?: string;
  resume?: boolean;
  defer?: boolean;
  failure?: string;
  provider?: string;
  account?: string;
  titleModel?: boolean;
  titleModelHidden?: boolean;
  response?: string;
  nativeDuringRead?: string;
  writable?: boolean;
  holdStart?: boolean;
}

function titleFixture(scenario: Scenario = {}, options?: DriverOptions) {
  const frames: any[] = [], events: any[] = [], titles: any[] = [], statuses: string[] = [];
  const fixtureCallbacks: DriverCallbacks = {
    emit(type, payload) { events.push({ type, payload }); return options?.callbacks.emit(type, payload); },
    metadata(value) { titles.push(value); options?.callbacks.metadata(value); },
    commands(value) { options?.callbacks.commands(value); },
    status(value) { statuses.push(value); options?.callbacks.status(value); },
    exited(value) { options?.callbacks.exited(value); },
  };
  const driver = new CodexDriver({
    sessionId: "wb-auto-title", cwd: "/tmp", config: { model: "main-model", effort: "high", permissionMode: "full-access" },
    ...(scenario.resume ? { resumeSessionId: "main-thread" } : {}), ...options, callbacks: fixtureCallbacks,
  });
  const internal = driver as any;
  let releaseStart = () => {};
  const notify = (method: string, params: any) => internal.handleStdoutLine(JSON.stringify({ method, params }));
  const complete = (text = scenario.response ?? '{"title":"修复登录超时"}', status = "completed") => {
    notify("item/completed", { threadId: "title-thread", turnId: "title-turn", item: { type: "agentMessage", id: "title-item", text } });
    notify("turn/completed", { threadId: "title-thread", turn: { id: "title-turn", status } });
  };
  internal.spawnProcess = () => undefined;
  internal.send = (frame: any) => {
    frames.push(frame);
    if (frame.id === undefined || !frame.method) return;
    const temporary = frame.params?.ephemeral || frame.params?.threadId === "title-thread";
    let result: any = {};
    if (frame.method === "config/read") result = { config: { model_provider: scenario.provider ?? "openai", mcp_servers: { external: { command: "must-not-run" } } } };
    if (frame.method === "model/list") result = { data: [
      { model: "main-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
      ...(scenario.titleModel === false || (scenario.titleModelHidden && !frame.params.includeHidden)
        ? [] : [{ model: "gpt-5.6-luna", hidden: scenario.titleModelHidden ?? false }]),
    ] };
    if (frame.method === "account/read") result = { account: { type: scenario.account ?? "chatgpt" } };
    if (frame.method === "thread/start" || frame.method === "thread/resume") {
      result = { thread: { id: temporary ? "title-thread" : "main-thread", name: temporary ? null : scenario.name },
        model: temporary ? frame.params.model : "main-model", modelProvider: scenario.provider ?? "openai",
        reasoningEffort: "high", approvalPolicy: temporary ? "never" : "never", approvalsReviewer: "user",
        sandbox: { type: temporary && !scenario.writable ? "readOnly" : "dangerFullAccess" } };
      if (temporary && !scenario.holdStart) notify("thread/started", { thread: { id: "title-thread", ephemeral: true, source: "vscode", threadSource: "thread_title" } });
    }
    if (frame.method === "turn/start") {
      result = { turn: { id: temporary ? "title-turn" : "main-turn" } };
      if (temporary) {
        // Real app-server notifications can precede the turn/start reply.
        notify("turn/started", { threadId: "title-thread", turn: { id: "title-turn" } });
        notify("item/agentMessage/delta", { threadId: "title-thread", turnId: "title-turn", delta: "hidden" });
        notify("thread/tokenUsage/updated", { threadId: "title-thread", tokenUsage: { total: { totalTokens: 123 } } });
        if (!scenario.defer && scenario.failure !== "turn/start") complete();
      }
    }
    if (frame.method === "thread/read") result = { thread: { id: "main-thread", name: scenario.nativeDuringRead ?? null } };
    const respond = () => {
      if (temporary && frame.method === "thread/start" && scenario.holdStart) {
        notify("thread/started", { thread: { id: "title-thread", ephemeral: true, source: "vscode", threadSource: "thread_title" } });
      }
      const error = scenario.failure === frame.method && (temporary || ["account/read", "thread/name/set", "thread/read"].includes(frame.method)
        || (frame.method === "config/read" && frames.filter(f => f.method === "config/read").length > 1))
        ? { message: "offline / quota" } : undefined;
      internal.handleStdoutLine(JSON.stringify({ id: frame.id, ...(error ? { error } : { result }) }));
      if (!error && frame.method === "thread/name/set") notify("thread/name/updated", { threadId: "main-thread", threadName: frame.params.name });
    };
    if (temporary && frame.method === "thread/start" && scenario.holdStart) releaseStart = respond;
    else queueMicrotask(respond);
  };
  const userItem = (text = "请修复登录页面的超时问题") => notify("item/completed", {
    threadId: "main-thread", turnId: "main-turn", item: { type: "userMessage", id: "user-item", content: [{ type: "text", text }] },
  });
  return { driver, internal, frames, events, titles, statuses, notify, complete, userItem, releaseStart: () => releaseStart() };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const temporaryStarts = (fixture: ReturnType<typeof titleFixture>) => fixture.frames.filter(f => f.method === "thread/start" && f.params.ephemeral);
const renames = (fixture: ReturnType<typeof titleFixture>) => fixture.frames.filter(f => f.method === "thread/name/set");

{
  const f = titleFixture();
  await f.driver.start();
  await f.driver.sendUserMessage({ text: "请修复登录页面的超时问题" });
  await f.internal.startingTurn;
  const configBefore = structuredClone(f.internal.config);
  const before = { events: f.events.length, statuses: f.statuses.length };
  f.userItem(); f.userItem("第二条输入");
  await f.internal.titleTask;
  assert.equal(temporaryStarts(f).length, 1, "new unnamed thread generates exactly once");
  assert.equal(renames(f).length, 1);
  assert.equal(f.titles.at(-1).nativeTitle, "修复登录超时");
  assert.equal(f.internal.turnId, "main-turn", "temporary turn cannot replace the main turn ID");
  assert.equal(f.events.length, before.events, "hidden text/usage/turn events do not enter the main transcript");
  assert.equal(f.statuses.length, before.statuses, "temporary completion does not set the main session idle");
  assert.deepEqual(f.internal.config, configBefore);
  const start = temporaryStarts(f)[0].params;
  assert.equal(start.model, "gpt-5.6-luna");
  assert.equal(start.modelProvider, "openai");
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.threadSource, "thread_title", "Feature(thread_title) serializes without a prefix");
  for (const key of ["runtimeWorkspaceRoots", "dynamicTools", "environments", "selectedCapabilityRoots"]) assert.deepEqual(start[key], []);
  assert.deepEqual(start.config.mcp_servers, { external: { enabled: false } });
  for (const feature of ["hooks", "plugins", "apps", "shell_tool", "unified_exec", "multi_agent", "memories"]) assert.equal(start.config[`features.${feature}`], false);
  const turn = f.frames.find(f => f.method === "turn/start" && f.params.threadId === "title-thread").params;
  assert.equal(turn.effort, "low");
  assert.deepEqual(turn.outputSchema, { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 36 } }, required: ["title"], additionalProperties: false });
  assert.match(turn.input[0].text, /^Generate a concise, single-line task title of at most 36 characters/);
  assert.match(turn.input[0].text, /Write in the user's language/);
  assert.match(turn.input[0].text, /User prompt:\n请修复/);
  assert(f.frames.some(f => f.method === "thread/unsubscribe" && f.params.threadId === "title-thread"));
  f.userItem(); await tick(); assert.equal(temporaryStarts(f).length, 1);
  f.notify("item/agentMessage/delta", { threadId: "title-thread", delta: "late hidden" });
  assert.equal(f.events.length, before.events, "late temporary notifications remain hidden");
}

for (const scenario of [{ name: "原生标题" }, { resume: true }]) {
  const f = titleFixture(scenario); await f.driver.start(); f.userItem(); await tick();
  assert.equal(temporaryStarts(f).length, 0, "existing titles and resumed sessions do not generate");
}
for (const scenario of [{ provider: "custom" }, { account: "apiKey" }, { titleModel: false }]) {
  const f = titleFixture(scenario); await f.driver.start(); f.userItem(); await f.internal.titleTask;
  assert.equal(temporaryStarts(f)[0].params.model, "main-model", "TUI model fallback");
  const turn = f.frames.find(f => f.method === "turn/start").params;
  assert(!Object.hasOwn(turn, "effort"), "fallback keeps the native configured effort");
}
{
  const f = titleFixture({ titleModelHidden: true }); await f.driver.start(); f.userItem(); await f.internal.titleTask;
  assert.equal(temporaryStarts(f)[0].params.model, "gpt-5.6-luna", "TUI catalog includes hidden title models");
  assert(!f.driver.getConfigSchema().options.find(o => o.id === "model")!.values.some(v => v.value === "gpt-5.6-luna"), "hidden models stay out of the main model picker");
}
for (const scenario of [
  { failure: "thread/start" }, { failure: "turn/start" }, { failure: "thread/name/set" }, { failure: "thread/read" },
  { response: "not JSON" }, { response: '{"title":"","other":1}' }, { response: "x".repeat(8193) },
  { nativeDuringRead: "已有原生名称" }, { writable: true },
]) {
  const f = titleFixture(scenario); await f.driver.start(); f.userItem(); await f.internal.titleTask;
  assert(!f.titles.some(t => t.nativeTitle === "修复登录超时"), `failure keeps the first-input fallback: ${JSON.stringify(scenario)}`);
  assert(!f.events.some(e => e.type === "session_error" || e.type === "permission_request"));
  assert(!f.statuses.includes("error"));
  f.userItem(); await tick(); assert.equal(temporaryStarts(f).length, 1, "failure is not retried");
}
{
  const f = titleFixture({ failure: "config/read" }); await f.driver.start(); f.userItem(); await f.internal.titleTask;
  assert.equal(temporaryStarts(f).length, 0, "unreadable effective MCP config fails closed");
  assert.equal(f.events.length, 0);
}
{
  const f = titleFixture({ response: JSON.stringify({ title: "  “修复\n登录超时！”  " }) });
  await f.driver.start(); f.userItem("中😀".repeat(1000)); await f.internal.titleTask;
  const prompt = f.frames.find(f => f.method === "turn/start").params.input[0].text;
  assert(Buffer.byteLength(prompt) <= 960); assert(!prompt.includes("\uFFFD"));
  assert.equal(renames(f)[0].params.name, "修复 登录超时！");
}
{
  const f = titleFixture({ defer: true }); await f.driver.start(); f.userItem(); await tick();
  f.notify("thread/name/updated", { threadId: "main-thread", threadName: "原生手动名" });
  f.complete(); await f.internal.titleTask;
  assert.equal(renames(f).length, 0, "a late native name cancels automatic writeback");
}
{
  const f = titleFixture({ defer: true }); await f.driver.start();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.userItem(); await tick(); mock.timers.tick(30_000); await f.internal.titleTask;
    assert.equal(renames(f).length, 0);
    assert(f.frames.some(f => f.method === "turn/interrupt" && f.params.threadId === "title-thread"));
    assert(f.frames.some(f => f.method === "thread/unsubscribe" && f.params.threadId === "title-thread"));
    assert.equal(f.events.length, 0); assert(!f.statuses.includes("error"));
  } finally { mock.timers.reset(); }
}
{
  const f = titleFixture({ holdStart: true }); await f.driver.start();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.userItem(); await tick(); mock.timers.tick(30_000); await f.internal.titleTask;
    // A started notification may arrive after the generation deadline, before its RPC reply.
    f.releaseStart();
    assert(f.frames.some(f => f.method === "thread/unsubscribe" && f.params.threadId === "title-thread"), "late thread is detached immediately");
    await tick();
    assert(!f.frames.some(f => f.method === "turn/start"), "late creation never starts a model turn");
    assert.equal(renames(f).length, 0);
  } finally { mock.timers.reset(); }
}
for (const finish of ["failed", "stop", "exit"] as const) {
  const f = titleFixture({ defer: true }); await f.driver.start(); f.userItem(); await tick();
  if (finish === "failed") f.complete('{"title":"不应写回"}', "failed");
  else if (finish === "stop") await f.driver.stop();
  else f.internal.handleProcessExit();
  await f.internal.titleTask;
  assert.equal(renames(f).length, 0, `${finish}: no writeback`);
  assert(!f.events.some(e => e.type === "session_error"));
}
{
  const f = titleFixture({ defer: true }); await f.driver.start(); f.userItem(); await tick();
  f.notify("item/commandExecution/requestApproval", { threadId: "title-thread" });
  f.internal.handleStdoutLine(JSON.stringify({ id: 999, method: "item/tool/requestUserInput", params: { threadId: "title-thread" } }));
  await f.internal.titleTask;
  assert(!f.events.some(e => e.type === "permission_request"));
  assert(f.frames.some(f => f.id === 999 && f.error), "unexpected hidden tool request is rejected");
}

// Exercise the production manager boundary, including renames and list/transcript isolation.
const home = mkdtempSync(join(tmpdir(), "wb-codex-auto-title-"));
process.env.WORKBENCH_HOME = home;
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(home, "native-empty");
const { SessionManager } = await import("./session-manager.js");
const fixtures = new Map<string, ReturnType<typeof titleFixture>>();
const manager = new SessionManager((_agent, options) => {
  const f = titleFixture({ defer: true }, options); fixtures.set(options.sessionId, f); return f.driver;
});
try {
  const s = await manager.create({ agent: "codex", cwd: home, config: {} });
  const f = fixtures.get(s.id)!;
  await manager.sendUserMessage(s.id, { text: "原始用户输入" });
  f.userItem(); await tick();
  const before = manager.getSnapshot(s.id)!;
  assert.equal(manager.list().length, 1, "temporary thread never registers a AIReins session");
  assert.equal(manager.get(s.id)!.nativeSessionId, "main-thread");
  f.complete(); await f.internal.titleTask;
  assert.equal(manager.get(s.id)!.title, "修复登录超时");
  assert.deepEqual(manager.getSnapshot(s.id)!.events, before.events);
  assert.equal(manager.list().length, 1);

  for (const timing of ["before", "during"] as const) {
    const s = await manager.create({ agent: "codex", cwd: home, config: {} });
    const f = fixtures.get(s.id)!;
    if (timing === "before") manager.updateOrganization(s.id, { customTitle: "用户手动名" });
    await manager.sendUserMessage(s.id, { text: "首轮用户输入" });
    f.userItem(); await tick();
    if (timing === "during") {
      manager.updateOrganization(s.id, { customTitle: "用户手动名" });
      f.complete(); await f.internal.titleTask;
    }
    assert.equal(renames(f).length, 0, `${timing}: manual title prevents writeback`);
    assert.equal(manager.get(s.id)!.title, "用户手动名");
    if (timing === "before") assert.equal(temporaryStarts(f).length, 0);
    manager.updateOrganization(s.id, { customTitle: "" });
    f.userItem(); await tick();
    assert.equal(renames(f).length, 0, "clearing a manual title does not schedule a second attempt");
  }
} finally { await manager.shutdown(); }
let earlyFixture!: ReturnType<typeof titleFixture>;
const earlyManager = new SessionManager((_agent, options) => {
  earlyFixture = titleFixture({}, options); return earlyFixture.driver;
}, undefined, async () => {
  const session = earlyManager.list().find(s => s.status === "starting")!;
  earlyManager.updateOrganization(session.id, { customTitle: "worker创建前的手动名" });
  return null;
});
try {
  const s = await earlyManager.create({ agent: "codex", cwd: home, config: {}, snapshot: "auto" });
  await earlyManager.sendUserMessage(s.id, { text: "首轮用户输入" });
  earlyFixture.userItem(); await tick(); await earlyFixture.internal.titleTask;
  assert.equal(temporaryStarts(earlyFixture).length, 0, "manual rename during async snapshot precedes worker creation");
  assert.equal(earlyManager.get(s.id)!.title, "worker创建前的手动名");
} finally { await earlyManager.shutdown(); }
console.log("PASS: native automatic title flow, once/new-only, model selection, read-only isolation, cancellation, timeout/failure fallback, hidden list/transcript");
