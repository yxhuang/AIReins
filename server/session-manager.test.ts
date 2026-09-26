import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

  reportInit(model: string, effort?: string): void {
    this.options.callbacks.metadata({
      effectiveConfig: {
        model: { value: model, source: "init" },
        ...(effort ? { effort: { value: effort, source: "init" } } : {}),
      },
    });
    this.options.callbacks.emit("config_updated", {
      effectiveFrom: "current_turn",
      reportedBy: "system/init",
    });
  }

  requestApproval(): void {
    this.options.callbacks.emit("permission_request", {
      requestId: "permission-after-restart",
      gate: "control_request",
      toolName: "Write",
    });
  }
}

class FakeDefaultDriver implements Driver {
  private config: SessionConfig;

  constructor(readonly kind: "codex" | "kimi", readonly options: DriverOptions) {
    this.config = kind === "codex"
      ? { model: "gpt-5.6-sol", effort: "xhigh", permissionMode: "untrusted" }
      : { model: "kimi-code/k3", effort: "high", permissionMode: "default" };
  }

  async start(): Promise<void> {
    this.options.callbacks.metadata({ config: { ...this.config } });
    this.options.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return {
      source: "test",
      options: [
        { id: "model", name: "模型", values: [{ value: this.config.model!, label: "default" }], default: this.config.model!, mutable: true },
        { id: "effort", name: "推理强度", values: [{ value: "low", label: "low" }, { value: this.config.effort!, label: "default" }], default: this.config.effort!, mutable: true },
        { id: "permissionMode", name: "审批模式", values: [{ value: this.config.permissionMode!, label: "default" }], default: this.config.permissionMode!, mutable: true },
      ],
    };
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    this.config = { ...this.config, ...config };
    this.options.callbacks.metadata({ config: { ...this.config } });
    return { ...this.config };
  }

  async sendUserMessage(_message: UserMessageInput): Promise<void> {}
  async resolvePermission(
    _requestId: string,
    _decision: PermissionDecision,
    _updatedInput?: unknown,
  ): Promise<void> {}
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

const instances: FakeClaudeDriver[] = [];
const factory = (agent: AgentKind, options: DriverOptions): Driver => {
  if (agent !== "claude") return new FakeDefaultDriver(agent, options);
  const driver = new FakeClaudeDriver(options, CLAUDE_CONFIG_SCHEMA);
  instances.push(driver);
  return driver;
};
const manager = new SessionManager(factory, () => ({ model: "opus", effort: "high" }));
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
assert.deepEqual({
  configModel: created.config.model,
  configEffort: created.config.effort,
  model: created.model,
  effort: created.effort,
  effectiveModel: created.effectiveModel,
  effectiveEffort: created.effectiveEffort,
  effectiveModelSource: created.effectiveModelSource,
  effectiveEffortSource: created.effectiveEffortSource,
}, {
  configModel: null,
  configEffort: null,
  model: null,
  effort: null,
  effectiveModel: "opus",
  effectiveEffort: "high",
  effectiveModelSource: "settings",
  effectiveEffortSource: "settings",
});
await manager.sendUserMessage(created.id, { text: "第一轮" });
await assert.rejects(
  () => manager.setConfig(created.id, { model: "sonnet" }),
  /当前回合尚未结束，请等待或中断后再切换/,
);
assert.equal(instances[0].stopped, false);
instances[0].reportInit("claude-opus-5");
const afterInit = manager.get(created.id)!;
assert.equal(afterInit.config.model, null);
assert.equal(afterInit.config.effort, null);
assert.equal(afterInit.model, "claude-opus-5");
assert.equal(afterInit.effort, null);
assert.equal(afterInit.effectiveModel, "claude-opus-5");
assert.equal(afterInit.effectiveModelSource, "init");
assert.equal(afterInit.effectiveEffort, "high");
assert.equal(afterInit.effectiveEffortSource, "settings");
const initEvent = events.at(-1)!;
assert.equal(initEvent.type, "config_updated");
assert.equal(initEvent.payload.effectiveModel, "claude-opus-5");
assert.equal(initEvent.payload.effectiveEffort, "high");
assert.equal(initEvent.payload.effectiveModelSource, "init");
assert.equal(initEvent.payload.effectiveEffortSource, "settings");
assert.equal(manager.list().find((session) => session.id === created.id)!.effectiveModel, "claude-opus-5");
assert.equal(manager.getSnapshot(created.id)!.session.effectiveEffort, "high");
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
assert.equal(switched.config.model, "sonnet");
assert.equal(switched.effectiveModel, "sonnet");
assert.equal(switched.effectiveModelSource, "session");
assert.equal(switched.effectiveEffort, "high");
assert.equal(switched.effectiveEffortSource, "session");
assert.ok(switched.seq > beforeRestartSeq);
assert.deepEqual(
  events.filter((event) => event.seq > beforeRestartSeq).map((event) => event.type),
  ["config_update_started", "config_updated"],
);
const restartConfigEvent = events.at(-1)!;
assert.equal(restartConfigEvent.payload.effectiveModel, "sonnet");
assert.equal(restartConfigEvent.payload.effectiveModelSource, "session");
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

const overridden = await manager.create({
  agent: "claude",
  cwd: process.cwd(),
  config: { model: "haiku" },
});
assert.equal(overridden.config.model, "haiku");
assert.equal(overridden.model, "haiku");
assert.equal(overridden.effectiveModel, "haiku");
assert.equal(overridden.effectiveModelSource, "session");
instances.at(-1)!.reportInit("claude-haiku-4-5-20251001");
const overriddenAfterInit = manager.get(overridden.id)!;
assert.equal(overriddenAfterInit.config.model, "haiku");
assert.equal(overriddenAfterInit.model, "claude-haiku-4-5-20251001");
assert.equal(overriddenAfterInit.effectiveModelSource, "init");

// 首条消息前 claude 已报 session_id，但原生存档还没落盘：切换应按新配置开新 worker，不续接
const fresh = await manager.create({ agent: "claude", cwd: process.cwd() });
instances.at(-1)!.options.callbacks.metadata({ nativeSessionId: "unsaved-native-session" });
const freshSwitched = await manager.setConfig(fresh.id, { model: "sonnet" });
assert.equal(instances.at(-2)!.stopped, true);
assert.equal(instances.at(-1)!.options.resumeSessionId, undefined);
assert.equal(freshSwitched.config.model, "sonnet");
assert.equal(freshSwitched.status, "idle");
assert.equal(freshSwitched.nativeSessionId, undefined);
// 导入的历史会话即使本次没发过消息，存档也已存在，必须续接
await manager.setConfig(resumed.id, { model: "sonnet" });
assert.equal(instances.at(-1)!.options.resumeSessionId, "existing-native-session");

const codex = await manager.create({ agent: "codex", cwd: process.cwd() });
assert.deepEqual({ model: codex.model, effort: codex.effort, permissionMode: codex.permissionMode }, {
  model: "gpt-5.6-sol",
  effort: "xhigh",
  permissionMode: "untrusted",
});
assert.equal(Object.hasOwn(codex, "effectiveModel"), false);
const updatedCodex = await manager.setConfig(codex.id, { effort: "low" });
assert.equal(updatedCodex.effort, "low");
const codexConfigEvent = events.at(-1)!;
assert.equal(codexConfigEvent.payload.effectiveFrom, "next_turn");
assert.equal(Object.hasOwn(codexConfigEvent.payload, "effectiveModel"), false);

const kimi = await manager.create({ agent: "kimi", cwd: process.cwd() });
assert.deepEqual({ model: kimi.model, effort: kimi.effort, permissionMode: kimi.permissionMode }, {
  model: "kimi-code/k3",
  effort: "high",
  permissionMode: "default",
});
assert.equal(Object.hasOwn(kimi, "effectiveModel"), false);

let snapshotFinished = false;
let driverStartedAfterSnapshot = false;
let snapshotCalls = 0;
const snapshotFactory = (agent: AgentKind, options: DriverOptions): Driver => {
  assert.equal(agent, "codex");
  const driver = new FakeDefaultDriver("codex", options);
  const start = driver.start.bind(driver);
  driver.start = async () => {
    driverStartedAfterSnapshot = snapshotFinished;
    await start();
  };
  return driver;
};
const snapshotManager = new SessionManager(
  snapshotFactory,
  () => ({ model: null, effort: null }),
  async () => {
    snapshotCalls += 1;
    snapshotFinished = true;
    return "/tmp/workbench-test-snapshot";
  },
);
const snapshotted = await snapshotManager.create({ agent: "codex", cwd: process.cwd() });
assert.equal(driverStartedAfterSnapshot, true);
assert.equal(snapshotted.snapshotPath, "/tmp/workbench-test-snapshot");
assert.equal(snapshotCalls, 1);
await snapshotManager.create({ agent: "codex", cwd: process.cwd(), snapshot: "skip" });
assert.equal(snapshotCalls, 1);
await snapshotManager.shutdown();

const snapshotWarningEvents: UnifiedEvent[] = [];
let warningDriverStarted = false;
const snapshotFailureManager = new SessionManager(
  (_agent, options) => {
    const driver = new FakeDefaultDriver("codex", options);
    const start = driver.start.bind(driver);
    driver.start = async () => {
      warningDriverStarted = true;
      await start();
    };
    return driver;
  },
  () => ({ model: null, effort: null }),
  async () => {
    throw new Error("snapshot test failure");
  },
);
snapshotFailureManager.onEvent((event) => snapshotWarningEvents.push(event));
const createdDespiteSnapshotFailure = await snapshotFailureManager.create({ agent: "codex", cwd: process.cwd() });
assert.equal(warningDriverStarted, true);
assert.equal(createdDespiteSnapshotFailure.status, "idle");
const snapshotWarning = snapshotWarningEvents.find((event) => (
  event.type === "session_error" && event.payload.source === "snapshot"
));
assert.equal(snapshotWarning?.payload.severity, "warning");
assert.equal(snapshotWarning?.payload.nonBlocking, true);
await snapshotFailureManager.shutdown();

await manager.shutdown();

const emptySettingsManager = new SessionManager(factory, () => ({ model: null, effort: null }));
const reloadedOverride = emptySettingsManager.get(overridden.id)!;
assert.equal(reloadedOverride.config.model, "haiku");
assert.equal(reloadedOverride.model, "claude-haiku-4-5-20251001");
assert.equal(reloadedOverride.effectiveModel, "claude-haiku-4-5-20251001");
assert.equal(reloadedOverride.effectiveModelSource, "init");
const noSettings = await emptySettingsManager.create({ agent: "claude", cwd: process.cwd() });
assert.equal(noSettings.effectiveModel, null);
assert.equal(noSettings.effectiveEffort, null);
assert.equal(noSettings.effectiveModelSource, null);
assert.equal(noSettings.effectiveEffortSource, null);
await emptySettingsManager.shutdown();

await rm(fixture, { recursive: true, force: true });
console.log(JSON.stringify({
  fixtureCleaned: true,
  restartEvents: ["config_update_started", "config_updated"],
  resumeSessionId: instances[1].options.resumeSessionId,
  permissionGate: permissionEvent.payload.gate,
  resumedFrom: resumed.resumedFrom,
}));

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
