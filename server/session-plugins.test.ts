import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudePlugins } from "./claude-plugins.js";
import type { Driver, DriverCallbacks, DriverOptions, UnifiedCommand } from "./types.js";

const root = await mkdtemp(join(tmpdir(), "workbench-session-plugins-"));
process.env.WORKBENCH_HOME = join(root, "wb");
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(root, "native");
const { SessionManager } = await import("./session-manager.js");
const { ClaudeDriver } = await import("./drivers/claude.js");

let enabled = true;
let reloadCount = 0;
let failReload = false;
const instances: DriverOptions[] = [];
const calls: string[][] = [];
const plugins = new ClaudePlugins(async (cwd, args) => {
  assert.equal(cwd, root);
  calls.push(args);
  if (args[0] === "list") return [{ id: "example@market", scope: "user", enabled }];
  enabled = args[0] === "enable";
  return { success: true };
});
const manager = new SessionManager((_agent, options): Driver => {
  instances.push(options);
  return {
    kind: "claude",
    start: async () => {
      options.callbacks.metadata({ nativeSessionId: "fixture-native-id" });
      options.callbacks.status("idle");
    },
    getConfigSchema: () => ({ source: "fixture", options: [] }),
    setConfig: async (config) => config,
    reloadPlugins: async () => {
      ++reloadCount;
      if (failReload) throw new Error("fixture reload failed");
    },
    sendUserMessage: async () => {},
    resolvePermission: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  };
}, () => ({ model: null, effort: null }), undefined, undefined, plugins);

try {
  const session = await manager.create({ agent: "claude", cwd: root, snapshot: "skip" });
  await manager.queryInfo(session.id, "plugins");
  await assert.rejects(manager.setPluginEnabled(session.id, "unknown@market", true), /最近一次列表/);
  assert.equal(calls.length, 1);
  const live = await manager.setPluginEnabled(session.id, "example@market", false, "user");
  assert.equal(live.reloaded, true);
  assert.equal(live.plugins[0].enabled, false);
  assert.equal(reloadCount, 1);
  assert.equal(calls.at(-1)?.[0], "list");
  failReload = true;
  const failed = await manager.setPluginEnabled(session.id, "example@market", true);
  assert.equal(failed.reloaded, false);
  assert.equal(failed.plugins[0].enabled, true, "重载失败仍刷新已保存的启用状态");
  assert.match(failed.reloadError!, /fixture reload failed/);
  await manager.release(session.id, "manual");
  const released = await manager.setPluginEnabled(session.id, "example@market", false);
  assert.equal(released.reloaded, false);
  assert.equal(instances.length, 1, "已释放会话切换不能启动 worker");
  assert.equal(reloadCount, 2);
  const dead = await manager.create({ agent: "claude", cwd: root, snapshot: "skip" });
  instances[1].callbacks.exited({ code: 0, signal: null, expected: true });
  assert.equal(manager.get(dead.id)?.status, "dead");
  await manager.queryInfo(dead.id, "plugins");
  assert.equal((await manager.setPluginEnabled(dead.id, "example@market", true)).reloaded, false);
  assert.equal(instances.length, 2, "已结束会话切换不能启动 worker");
  assert.equal(reloadCount, 2);

  // Mock stdio 验证真实 driver 的请求顺序、命令刷新及组件错误；不启动 Claude。
  const sent: { request_id: string; request: { subtype: string } }[] = [];
  let commands: UnifiedCommand[] = [];
  const callbacks: DriverCallbacks = {
    emit: () => undefined, metadata: () => {}, status: () => {}, exited: () => {},
    commands: (value) => { commands = value; },
  };
  const driver = new ClaudeDriver({ sessionId: "mock", cwd: root, config: {}, callbacks });
  (driver as unknown as { child: ChildProcessWithoutNullStreams }).child = {
    stdin: { writable: true, write: (line: string) => { sent.push(JSON.parse(line)); return true; } },
  } as unknown as ChildProcessWithoutNullStreams;
  const receive = (payload: unknown) => (driver as unknown as { handleStdoutLine(line: string): void })
    .handleStdoutLine(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: sent.at(-1)!.request_id, response: payload,
    } }));
  const reloading = driver.reloadPlugins();
  assert.deepEqual(sent.at(-1)!.request, { subtype: "get_settings" });
  receive({ effective: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1)!.request, { subtype: "reload_plugins" });
  receive({ commands: [{ name: "/example", description: "new plugin command" }], error_count: 0 });
  await reloading;
  assert.equal(commands[0].name, "example");
  const partial = driver.reloadPlugins();
  receive({ effective: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  receive({ commands: [], error_count: 1 });
  await assert.rejects(partial, /1 个错误/);
} finally {
  await manager.shutdown();
  await rm(root, { recursive: true, force: true });
}
console.log("✅ 插件切换：live/released/dead、重载失败、设置刷新顺序与命令更新");
