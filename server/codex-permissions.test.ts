import assert from "node:assert/strict";
import { CodexDriver, codexConfigSchemaFromModels } from "./drivers/codex.js";
import { isRiskyConfig } from "./session-config.js";
import type { DriverCallbacks, SessionConfig } from "./types.js";

// 权限是 approvalPolicy + reviewer + sandbox 的组合；只改菜单标签不足以通过这些协议检查。
const schema = codexConfigSchemaFromModels([], {}).options.find((item) => item.id === "permissionMode")!;
assert.equal(schema.default, "on-request");
assert.deepEqual(schema.values.map((item) => [item.value, item.label]), [
  ["on-request", "Ask for approval"],
  ["auto-review", "Approve for me"],
  ["full-access", "Full access"],
]);

const expected = {
  "on-request": { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", type: "workspaceWrite" },
  "auto-review": { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", type: "workspaceWrite" },
  "full-access": { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access", type: "dangerFullAccess" },
  "never": { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write", type: "workspaceWrite" },
  "untrusted": { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", type: "workspaceWrite" },
} as const;

function harness(config: SessionConfig = {}, resumeSessionId?: string) {
  const sent: any[] = [];
  const events: Array<{ type: string; payload: any }> = [];
  const metadata: any[] = [];
  let failNextTurn = false;
  let threadResponseOverride: Record<string, unknown> = {};
  const callbacks: DriverCallbacks = {
    emit: (type, payload) => { events.push({ type, payload }); return undefined; },
    metadata: (value) => { metadata.push(value); },
    commands: () => undefined,
    status: () => undefined,
    exited: () => undefined,
  };
  const driver = new CodexDriver({ sessionId: "test", cwd: process.cwd(), config, resumeSessionId, callbacks });
  const internal = driver as any;
  internal.spawnProcess = () => undefined;
  internal.send = (frame: any) => {
    sent.push(frame);
    if (frame.id === undefined) return;
    const params = frame.params;
    const result = frame.method === "initialize" ? {}
      : frame.method === "config/read" ? { config: { model: "test-model", model_reasoning_effort: "high" } }
      : frame.method === "model/list" ? { data: [{ id: "test-model", isDefault: true }] }
      : frame.method === "thread/start" || frame.method === "thread/resume" ? {
        thread: { id: "thread-test" }, model: "test-model", reasoningEffort: "high",
        approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
        sandbox: { type: params.sandbox === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite" },
        ...threadResponseOverride,
      } : { turn: { id: "turn-test" } };
    const fail = frame.method === "turn/start" && failNextTurn;
    if (fail) failNextTurn = false;
    queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({
      id: frame.id, ...(fail ? { error: { message: "managed policy rejected permissions" } } : { result }),
    })));
  };
  return {
    driver, sent, events, metadata,
    rejectTurn: () => { failNextTurn = true; },
    overrideThread: (value: Record<string, unknown>) => { threadResponseOverride = value; },
  };
}

function check(params: any, mode: keyof typeof expected, turn = false) {
  const want = expected[mode];
  assert.equal(params.approvalPolicy, want.approvalPolicy);
  assert.equal(params.approvalsReviewer, want.approvalsReviewer);
  if (turn) {
    assert.equal(params.sandboxPolicy.type, want.type);
    if (want.type === "workspaceWrite") {
      assert.equal(params.sandboxPolicy.networkAccess, false);
      assert.deepEqual(params.sandboxPolicy.writableRoots, []);
    } else assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" });
  } else assert.equal(params.sandbox, want.sandbox);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const mode of ["on-request", "auto-review", "full-access"] as const) {
  for (const resume of [false, true]) {
    const h = harness({ permissionMode: mode }, resume ? "existing-thread" : undefined);
    await h.driver.start();
    const method = resume ? "thread/resume" : "thread/start";
    check(h.sent.find((frame) => frame.method === method).params, mode);
    assert.equal(h.metadata.at(-1).config.permissionMode, mode, "回报不得只用 approvalPolicy 覆盖组合模式");
    await h.driver.sendUserMessage({ text: "test" });
    await settle();
    check(h.sent.find((frame) => frame.method === "turn/start").params, mode, true);
  }
}

// 未传配置的初始回合明确采用人工审批，不受全局 reviewer / sandbox 的意外组合影响。
{
  const h = harness();
  await h.driver.start();
  check(h.sent.find((frame) => frame.method === "thread/start").params, "on-request");
}

// 热切换同时修改三项；切回人工审批必须撤销 auto_review / dangerFullAccess。
{
  const h = harness();
  await h.driver.start();
  for (const mode of ["auto-review", "full-access", "on-request"] as const) {
    await h.driver.setConfig({ permissionMode: mode });
    await h.driver.sendUserMessage({ text: "test" });
    await settle();
    check(h.sent.filter((frame) => frame.method === "turn/start").at(-1).params, mode, true);
    const confirmed = h.events.filter((event) => event.type === "config_updated").at(-1)!;
    assert.equal(confirmed.payload.effectiveFrom, "current_turn");
    assert.equal(confirmed.payload.riskyMode, mode === "full-access");
    assert.equal(confirmed.payload.effectiveConfig.permissionMode, mode);
  }
  h.rejectTurn();
  await h.driver.setConfig({ permissionMode: "auto-review" });
  const before = h.events.filter((event) => event.type === "config_updated").length;
  await h.driver.sendUserMessage({ text: "test" });
  await settle();
  assert.equal(h.events.filter((event) => event.type === "config_updated").length, before, "拒绝时不能宣称已生效");
  assert.equal(h.events.at(-1)?.type, "session_error");
  await h.driver.sendUserMessage({ text: "retry" });
  await settle();
  assert.equal(h.events.filter((event) => event.type === "config_updated").length, before + 1);
}

// 历史 Never 与 Untrusted 保留原限制，不通过重命名放宽权限；新会话不能再选旧策略。
for (const mode of ["never", "untrusted"] as const) {
  const h = harness({ permissionMode: mode }, "old-thread");
  await h.driver.start();
  check(h.sent.find((frame) => frame.method === "thread/resume").params, mode);
  await h.driver.sendUserMessage({ text: "test" });
  await settle();
  check(h.sent.find((frame) => frame.method === "turn/start").params, mode, true);
  await h.driver.setConfig({ permissionMode: "on-request" });
  await assert.rejects(h.driver.setConfig({ permissionMode: mode }), /不合法/);
  await assert.rejects(harness({ permissionMode: mode }).driver.start(), /不合法/);
}

// 实际返回的 reviewer 决定显示；旧 guardian_subagent 值与当前 auto_review 同义。
{
  const h = harness({ permissionMode: "auto-review" });
  h.overrideThread({ approvalsReviewer: "user" });
  await h.driver.start();
  assert.equal(h.metadata.at(-1).config.permissionMode, "on-request");
  const legacyReviewer = harness({ permissionMode: "auto-review" });
  legacyReviewer.overrideThread({ approvalsReviewer: "guardian_subagent" });
  await legacyReviewer.driver.start();
  assert.equal(legacyReviewer.metadata.at(-1).config.permissionMode, "auto-review");
}
assert.equal(isRiskyConfig("codex", { permissionMode: "full-access" }), true);
assert.equal(isRiskyConfig("codex", { permissionMode: "auto-review" }), false);
assert.equal(isRiskyConfig("codex", { permissionMode: "on-request" }), false);
console.log("✅ Codex 权限菜单、新建/续接、逐轮切换、旧会话兼容和拒绝反馈全部通过");
