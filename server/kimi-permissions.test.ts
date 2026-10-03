import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiDriver } from "./drivers/kimi.js";

const modes = ["default", "plan", "auto", "yolo"] as const;
const root = await mkdtemp(join(tmpdir(), "wb-kimi-permissions-"));

function harness(mode?: string, resumeSessionId?: string) {
  const sent: any[] = [];
  const events: Array<{ type: string; payload: any }> = [];
  const metadata: any[] = [];
  const driver = new KimiDriver({
    sessionId: "test", cwd: root, config: { permissionMode: mode }, resumeSessionId,
    callbacks: {
      emit(type, payload) { events.push({ type, payload }); return undefined; },
      metadata(value) { metadata.push(value); },
      commands() {}, status() {}, exited() {},
    },
  });
  const internal = driver as any;
  const receive = (message: any) => internal.handleStdoutLine(JSON.stringify(message));
  const configOptions = (currentValue: string) => [{
    id: "mode", name: "Mode", currentValue,
    options: modes.map((value) => ({ value, name: value })),
  }];
  internal.spawnProcess = () => undefined;
  internal.send = (frame: any) => {
    sent.push(frame);
    // Only client RPC requests get mock replies; server-request responses do not.
    if (!frame.method || frame.id === undefined) return;
    const result = frame.method === "session/new" || frame.method === "session/resume"
      ? { sessionId: "native-test", configOptions: configOptions("yolo") }
      : frame.method === "session/set_config_option"
        ? { configOptions: configOptions(frame.params.value) } : {};
    queueMicrotask(() => receive({ jsonrpc: "2.0", id: frame.id, result }));
  };
  return { driver, internal, sent, events, metadata, receive };
}

// 新建与续接都实际设置 UI 所选模式，不能继承机器的 yolo 覆盖用户选择。
for (const mode of modes) {
  for (const resume of [false, true]) {
    const h = harness(mode, resume ? "native-existing" : undefined);
    await h.driver.start();
    assert.ok(h.sent.some((frame) => frame.method === (resume ? "session/resume" : "session/new")));
    assert.deepEqual(h.sent.find((frame) => frame.method === "session/set_config_option").params,
      { sessionId: "native-test", configId: "mode", value: mode });
    assert.equal(h.metadata.at(-1).config.permissionMode, mode);
  }
}
{
  const h = harness();
  await h.driver.start();
  assert.equal(h.sent.find((frame) => frame.method === "session/set_config_option").params.value, "auto");
  assert.equal(h.driver.getConfigSchema().options.find((option) => option.id === "permissionMode")?.default, "auto");
  const resumed = harness(undefined, "native-existing");
  await resumed.driver.start();
  assert.equal(resumed.sent.find((frame) => frame.method === "session/set_config_option").params.value, "default");
  for (const mode of ["yolo", "default", "auto", "plan"] as const) {
    assert.equal((await h.driver.setConfig({ permissionMode: mode })).permissionMode, mode);
    assert.equal(h.sent.at(-1).params.value, mode);
  }
  await assert.rejects(h.driver.setConfig({ permissionMode: "invalid" }), /不合法/);
}

// 原生标准审批仍原样转发，即使 CLI 在 yolo 下因自身策略请求审批也不能替它放行。
for (const mode of modes) {
  const h = harness(mode);
  await h.driver.start();
  const options = [
    { kind: "allow_once", optionId: "once" },
    { kind: "allow_always", optionId: "always" },
    { kind: "reject_once", optionId: "reject" },
  ];
  for (const [id, decision, optionId] of [[41, "allow", "once"], [42, "always", "always"], [43, "deny", "reject"]] as const) {
    const sentBefore = h.sent.length;
    h.receive({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: "native-test", toolCall: { title: "Shell" }, options,
    } });
    assert.equal(h.events.at(-1)?.type, "permission_request");
    assert.equal(h.events.at(-1)?.payload.gate, "session/request_permission");
    assert.equal(h.sent.length, sentBefore, "原生审批应等待用户决定");
    await h.driver.resolvePermission(`kimi:session/request_permission:${id}`, decision);
    assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
  }

  // 已获 CLI 放行的执行请求不再追加 Workbench 审批，保留真实文件/终端结果。
  const approvalsBefore = h.events.filter((event) => event.type === "permission_request").length;
  const file = join(root, `${mode}.txt`);
  h.receive({ jsonrpc: "2.0", id: 50, method: "fs/write_text_file", params: { path: file, content: `mode=${mode}` } });
  assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id: 50, result: {} });
  assert.equal(await readFile(file, "utf8"), `mode=${mode}`);
  h.receive({ jsonrpc: "2.0", id: 51, method: "terminal/create", params: {
    command: "/bin/sh", args: ["-c", 'printf "%s:%s:%s:%s" "$WB_TEST_MODE" "$PWD" "$WORKBENCH_PARENT_AGENT" "$WORKBENCH_PARENT_SESSION_ID"'],
    cwd: root, env: [{ name: "WB_TEST_MODE", value: mode }],
  } });
  const terminalId = h.sent.at(-1).result.terminalId;
  const terminal = h.internal.terminals.get(terminalId);
  await terminal.done;
  h.receive({ jsonrpc: "2.0", id: 52, method: "terminal/output", params: { terminalId } });
  assert.equal(h.sent.at(-1).result.output, `${mode}:${root}:kimi:native-test`);
  assert.equal(h.sent.at(-1).result.exitStatus.exitCode, 0);
  h.receive({ jsonrpc: "2.0", id: 53, method: "terminal/release", params: { terminalId } });
  assert.equal(h.internal.terminals.size, 0);
  assert.equal(h.events.filter((event) => event.type === "permission_request").length, approvalsBefore);
  assert.equal(h.internal.permissions.size, 0);

  h.receive({ jsonrpc: "2.0", id: 54, method: "fs/write_text_file", params: { path: join(root, "missing", "file.txt"), content: "test" } });
  assert.equal(h.sent.at(-1).error.code, -32000, "实际写入失败仍回传 RPC 错误");
}

console.log("✅ Kimi 权限：新建/续接/切换按所选模式；原生审批保留；文件与终端执行不重复审批");
