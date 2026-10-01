import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { menuFileUri, menuSettingsFiles, parseMcpAction, withMenuFileUris } from "./session-menu.js";
import type { Driver, DriverOptions } from "./types.js";

assert.deepEqual(parseMcpAction({ action: "toggle", serverName: "fixture", enabled: false }), { action: "toggle", serverName: "fixture", enabled: false });
assert.deepEqual(parseMcpAction({ action: "reconnect", serverName: "fixture" }), { action: "reconnect", serverName: "fixture" });
for (const input of [null, [], {}, { action: "toggle", serverName: "fixture", enabled: "false" }, { action: "reconnect", serverName: " " }, { action: "get_settings", serverName: "fixture" }, { action: "toggle", serverName: "bad\nname", enabled: true }]) {
  assert.throws(() => parseMcpAction(input));
}
assert.equal(menuFileUri("/a b/#c?.json", "Ubuntu Test"), "vscode://vscode-remote/wsl+Ubuntu%20Test/a%20b/%23c%3F.json");
assert.equal(menuFileUri("/a b/file", ""), "vscode://file/a%20b/file");
assert.equal(menuFileUri("relative", "Ubuntu"), null);
assert.equal(menuFileUri("/bad\npath", "Ubuntu"), null);
assert.equal(menuSettingsFiles("/project", "/config")[0].path, "/config/settings.json");
assert.deepEqual(withMenuFileUris([{ path: "relative" }, null])[0], { path: "relative", uri: null });

const root = await mkdtemp(join(tmpdir(), "wb-session-menu-"));
process.env.WORKBENCH_HOME = join(root, "wb");
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(root, "native");
const { SessionManager } = await import("./session-manager.js");
const { ClaudeDriver } = await import("./drivers/claude.js");
const queries: string[] = [];
const actions: unknown[] = [];
const options: DriverOptions[] = [];
let starts = 0;
const manager = new SessionManager((_agent, opts): Driver => {
  options.push(opts);
  return {
    kind: "claude", start: async () => { starts++; opts.callbacks.status("idle"); },
    getConfigSchema: () => ({ source: "fixture", options: [] }), setConfig: async config => config,
    queryInfo: async subtype => {
      queries.push(subtype);
      return { files: [{ path: "/fixture/CLAUDE.md" }], output_style: "default", available_output_styles: ["default", "Concise"],
        effective: { outputStyle: "Concise" }, hooks: [], state: { rules: [] }, skills: [], enabled: false, sections: [], text: "conversation", default_filename: "conversation.txt" };
    },
    manageMcp: async action => { actions.push(action); return { mcpServers: [] }; },
    sendUserMessage: async () => {}, resolvePermission: async () => {}, interrupt: async () => {}, stop: async () => {},
  };
}, () => ({ model: null, effort: null }));
try {
  const session = await manager.create({ agent: "claude", cwd: root, snapshot: "skip" });
  for (const [kind, subtype] of Object.entries({ status: "get_status", usage: "get_usage", memory: "get_memory_dialog", instructions: "get_memory_dialog", skills: "get_skills_dialog", sandbox: "get_sandbox_dialog", export: "export_conversation" })) {
    await manager.queryInfo(session.id, kind);
    assert.equal(queries.at(-1), subtype);
  }
  const memory = await manager.queryInfo(session.id, "memory") as { files: { uri: string }[] };
  assert.match(memory.files[0].uri, /^vscode:\/\//);
  const hooks = await manager.queryInfo(session.id, "hooks") as { settingsFiles: unknown[] };
  assert.equal(hooks.settingsFiles.length, 3);
  const output = await manager.queryInfo(session.id, "output") as { outputStyle: string };
  assert.equal(output.outputStyle, "Concise", "刷新磁盘设置，不能返回 initialize 缓存中的旧样式");
  assert.deepEqual(queries.slice(-2), ["initialize", "get_settings"]);
  await assert.rejects(manager.queryInfo(session.id, "arbitrary_control"), /未知查看项/);
  await manager.manageMcp(session.id, { action: "toggle", serverName: "fixture", enabled: false });
  assert.equal(actions.length, 1);
  options[0].callbacks.status("running");
  await assert.rejects(manager.manageMcp(session.id, { action: "reconnect", serverName: "fixture" }), /回复与审批结束/);
  assert.equal(actions.length, 1);
  options[0].callbacks.exited({ code: 0, signal: null, expected: true });
  await manager.queryInfo(session.id, "settings");
  assert.equal(starts, 1, "设置文件链接不启动已结束的 worker");
  await assert.rejects(manager.manageMcp(session.id, { action: "reconnect", serverName: "fixture" }));
  const codex = await manager.create({ agent: "codex", cwd: root, snapshot: "skip" });
  await manager.queryInfo(codex.id, "status");
  assert.equal(queries.at(-1), "status");
  await assert.rejects(manager.queryInfo(codex.id, "settings"), /未知 Codex/);
  await assert.rejects(manager.manageMcp(codex.id, { action: "reconnect", serverName: "fixture" }), /仅 Claude/);

  // 验证 driver 的请求字段、真实响应关联、错误传播、列表白名单与读回。
  const sent: { request_id: string; request: Record<string, unknown> }[] = [];
  const driver = new ClaudeDriver({ sessionId: "mock", cwd: root, config: {}, callbacks: { emit: () => undefined, metadata: () => {}, status: () => {}, exited: () => {}, commands: () => {} } });
  (driver as unknown as { child: ChildProcessWithoutNullStreams }).child = {
    stdin: { writable: true, write: (line: string) => { sent.push(JSON.parse(line)); return true; } },
  } as unknown as ChildProcessWithoutNullStreams;
  const receive = (response: unknown, error?: string) => (driver as unknown as { handleStdoutLine(line: string): void }).handleStdoutLine(JSON.stringify({ type: "control_response", response: {
    request_id: sent.at(-1)!.request_id, subtype: error ? "error" : "success", ...(error ? { error } : { response }),
  } }));
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const disabled = driver.manageMcp({ action: "toggle", serverName: "fixture", enabled: false });
  assert.deepEqual(sent.at(-1)!.request, { subtype: "mcp_status" });
  receive({ mcpServers: [{ name: "fixture", status: "connected" }] }); await tick();
  assert.deepEqual(sent.at(-1)!.request, { subtype: "mcp_toggle", serverName: "fixture", enabled: false });
  receive({}); await tick();
  assert.deepEqual(sent.at(-1)!.request, { subtype: "mcp_status" });
  receive({ mcpServers: [{ name: "fixture", status: "disabled" }] });
  assert.equal((await disabled as { mcpServers: { status: string }[] }).mcpServers[0].status, "disabled");
  const unknown = driver.manageMcp({ action: "reconnect", serverName: "unknown" });
  const rejectedUnknown = assert.rejects(unknown, /不在当前会话列表/);
  receive({ mcpServers: [{ name: "fixture" }] }); await rejectedUnknown;
  assert.equal(sent.at(-1)!.request.subtype, "mcp_status");
  const failed = driver.manageMcp({ action: "reconnect", serverName: "fixture" });
  const rejected = assert.rejects(failed, /reconnect failed/);
  receive({ mcpServers: [{ name: "fixture" }] }); await tick();
  assert.deepEqual(sent.at(-1)!.request, { subtype: "mcp_reconnect", serverName: "fixture" });
  receive(null, "reconnect failed"); await rejected;
  const stale = driver.manageMcp({ action: "reconnect", serverName: "fixture" });
  receive({ mcpServers: [{ name: "fixture" }] }); await tick(); receive({}); await tick(); receive(null, "refresh failed");
  assert.equal((await stale as { refreshError: string }).refreshError, "refresh failed");
} finally {
  await manager.shutdown();
}
console.log("✅ Slash 扩展：参数边界、协议链接、查看映射、MCP 字段/错误/读回与运行状态限制");
