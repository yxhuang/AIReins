import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentKind,
  Driver,
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  SessionConfig,
  UnifiedEvent,
  UserMessageInput,
} from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-session-manager-test-"));
process.env.WORKBENCH_HOME = fixture;

const [{ SessionManager }, { CLAUDE_CONFIG_SCHEMA, claudeLaunchArgs }] = await Promise.all([
  import("./session-manager.js"),
  import("./drivers/claude.js"),
]);

class FakeClaudeDriver implements Driver {
  readonly kind = "claude" as const;
  stopped = false;
  private config: SessionConfig;

  constructor(readonly options: DriverOptions, private readonly schema: DriverConfigSchema) {
    this.config = {
      model: options.config.model ?? null,
      effort: options.config.effort ?? null,
      permissionMode: options.config.permissionMode ?? "manual",
    };
  }

  async start(): Promise<void> {
    this.options.callbacks.metadata({
      ...(this.options.resumeSessionId ? { nativeSessionId: this.options.resumeSessionId } : {}),
      config: { ...this.config },
    });
    this.options.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return this.schema;
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    this.config = { ...this.config, ...config };
    return { ...this.config };
  }

  async sendUserMessage(_message: UserMessageInput): Promise<void> {
    this.options.callbacks.status("running");
  }

  async resolvePermission(
    _requestId: string,
    _decision: PermissionDecision,
    _updatedInput?: unknown,
  ): Promise<void> {}

  async interrupt(): Promise<void> {
    this.options.callbacks.status("idle");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.options.callbacks.exited({ code: 0, signal: null, expected: true });
  }

  finish(nativeSessionId: string): void {
    this.options.callbacks.metadata({ nativeSessionId });
    this.options.callbacks.emit("turn_completed", { result: "ok" });
    this.options.callbacks.status("idle");
  }

  requestApproval(): void {
    this.options.callbacks.emit("permission_request", {
      requestId: "permission-after-restart",
      gate: "control_request",
      toolName: "Write",
    });
  }
}

const instances: FakeClaudeDriver[] = [];
const factory = (agent: AgentKind, options: DriverOptions): Driver => {
  assert.equal(agent, "claude");
  const driver = new FakeClaudeDriver(options, CLAUDE_CONFIG_SCHEMA);
  instances.push(driver);
  return driver;
};
const manager = new SessionManager(factory);
const events: UnifiedEvent[] = [];
manager.onEvent((event) => events.push(event));

const modelOption = CLAUDE_CONFIG_SCHEMA.options.find((option) => option.id === "model");
const effortOption = CLAUDE_CONFIG_SCHEMA.options.find((option) => option.id === "effort");
assert.deepEqual([modelOption?.mutable, modelOption?.mutableVia], [true, "restart"]);
assert.deepEqual([effortOption?.mutable, effortOption?.mutableVia], [true, "restart"]);

const launchArgs = claudeLaunchArgs(
  { model: "sonnet", effort: "high", permissionMode: "manual" },
  "native-test-session",
);
assert.deepEqual(flagValue(launchArgs, "--resume"), "native-test-session");
assert.deepEqual(flagValue(launchArgs, "--model"), "sonnet");
assert.deepEqual(flagValue(launchArgs, "--effort"), "high");
assert.deepEqual(flagValue(launchArgs, "--permission-mode"), "manual");
assert.deepEqual(flagValue(launchArgs, "--permission-prompt-tool"), "stdio");

const created = await manager.create({ agent: "claude", cwd: process.cwd() });
assert.equal(created.nativeSessionId, undefined);
await assert.rejects(
  () => manager.setConfig(created.id, { model: "sonnet" }),
  /首轮完成前尚无 nativeSessionId/,
);
assert.equal(instances[0].stopped, false);

await manager.sendUserMessage(created.id, { text: "第一轮" });
await assert.rejects(
  () => manager.setConfig(created.id, { model: "sonnet" }),
  /当前回合尚未结束，请等待或中断后再切换/,
);
assert.equal(instances[0].stopped, false);
instances[0].finish("native-test-session");

const beforeRestartSeq = manager.get(created.id)!.seq;
const switched = await manager.setConfig(created.id, { model: "sonnet", effort: "high" });
assert.equal(instances.length, 2);
assert.equal(instances[0].stopped, true);
assert.equal(instances[1].options.resumeSessionId, "native-test-session");
assert.deepEqual(instances[1].options.config, {
  model: "sonnet",
  effort: "high",
  permissionMode: "manual",
});
assert.equal(switched.id, created.id);
assert.equal(switched.nativeSessionId, "native-test-session");
assert.equal(switched.status, "idle");
assert.ok(switched.seq > beforeRestartSeq);
assert.deepEqual(
  events.filter((event) => event.seq > beforeRestartSeq).map((event) => event.type),
  ["config_update_started", "config_updated"],
);
assert.equal(events.some((event) => event.type === "process_exited"), false);

instances[1].requestApproval();
const permissionEvent = events.at(-1)!;
assert.equal(permissionEvent.type, "permission_request");
assert.equal(permissionEvent.payload.gate, "control_request");

const resumed = await manager.create({
  agent: "claude",
  cwd: process.cwd(),
  resumeSessionId: "existing-native-session",
});
assert.deepEqual(resumed.resumedFrom, {
  agent: "claude",
  nativeSessionId: "existing-native-session",
});
assert.equal(resumed.nativeSessionId, "existing-native-session");

await manager.shutdown();
console.log(JSON.stringify({
  fixture,
  restartEvents: ["config_update_started", "config_updated"],
  resumeSessionId: instances[1].options.resumeSessionId,
  permissionGate: permissionEvent.payload.gate,
  resumedFrom: resumed.resumedFrom,
}));

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
