import { readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ConfigOptionId,
  DriverConfigSchema,
  PermissionDecision,
  SessionConfig,
} from "../types.js";
import { BaseDriver, errorMessage, parseJsonLine, withTimeout } from "./base.js";
import { StdioRpcProbe } from "./rpc-probe.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
}

interface KimiPermission {
  rpcId: string | number;
  method: "session/request_permission" | "terminal/create" | "fs/write_text_file";
  params: Record<string, any>;
}

interface TerminalState {
  process: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  done: Promise<void>;
}

interface AcpConfigOption {
  id?: string;
  name?: string;
  currentValue?: unknown;
  options?: Array<{ value?: unknown; name?: string; description?: string }>;
}

const KIMI_CONFIG_IDS: Record<ConfigOptionId, string> = {
  model: "model",
  effort: "thinking",
  permissionMode: "mode",
};

const KIMI_UNIFIED_IDS: Record<string, ConfigOptionId> = {
  model: "model",
  thinking: "effort",
  mode: "permissionMode",
};

const CONFIG_NAMES: Record<ConfigOptionId, string> = {
  model: "模型",
  effort: "推理强度",
  permissionMode: "审批模式",
};

export function kimiConfigSchemaFromOptions(configOptions: AcpConfigOption[]): DriverConfigSchema {
  return {
    source: "Kimi ACP session/new.configOptions",
    options: configOptions.flatMap((option) => {
      const id = KIMI_UNIFIED_IDS[String(option.id ?? "")];
      if (!id) return [];
      return [{
        id,
        name: CONFIG_NAMES[id],
        values: (option.options ?? []).flatMap((value) => {
          if (value.value === undefined) return [];
          return [{
            value: String(value.value),
            label: value.name ?? String(value.value),
            ...(value.description ? { description: value.description } : {}),
          }];
        }),
        default: option.currentValue === undefined ? "" : String(option.currentValue),
        mutable: true,
      }];
    }),
  };
}

export function kimiConfigFromOptions(configOptions: AcpConfigOption[]): SessionConfig {
  const config: SessionConfig = {};
  for (const option of configOptions) {
    const id = KIMI_UNIFIED_IDS[String(option.id ?? "")];
    if (id && option.currentValue !== undefined) config[id] = String(option.currentValue);
  }
  return config;
}

export async function probeKimiConfigSchema(cwd: string): Promise<DriverConfigSchema> {
  const probe = new StdioRpcProbe("kimi", ["acp"], cwd);
  let sessionId = "";
  try {
    await probe.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "workbench-meta", title: "Workbench metadata probe", version: "0.1.0" },
    });
    const result = await probe.request("session/new", { cwd, mcpServers: [] });
    sessionId = String(result?.sessionId ?? "");
    return kimiConfigSchemaFromOptions(Array.isArray(result?.configOptions) ? result.configOptions : []);
  } finally {
    if (sessionId) {
      try { await probe.request("session/close", { sessionId }, 1_000); } catch { /* probe shutdown remains authoritative */ }
    }
    await probe.close();
  }
}

export class KimiDriver extends BaseDriver {
  readonly kind = "kimi" as const;
  private rpcId = 1_000;
  private readonly rpc = new Map<number, PendingRpc>();
  private readonly permissions = new Map<string, KimiPermission>();
  private readonly terminals = new Map<string, TerminalState>();
  private nativeSessionId = "";
  private terminalCounter = 0;
  private configOptions: AcpConfigOption[] = [];

  async start(): Promise<void> {
    this.spawnProcess("kimi", ["acp"]);
    await withTimeout(this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
    }), 15_000, "Kimi initialize");

    const requestedConfig = { ...this.config };
    const result = this.resumeSessionId
      ? await withTimeout(this.request("session/resume", {
        sessionId: this.resumeSessionId,
        cwd: this.cwd,
        mcpServers: [],
      }), 15_000, "Kimi session/resume")
      : await withTimeout(this.request("session/new", { cwd: this.cwd, mcpServers: [] }), 15_000, "Kimi session/new");
    this.nativeSessionId = result?.sessionId ?? this.resumeSessionId ?? "";
    if (!this.nativeSessionId) throw new Error("Kimi 未返回 sessionId");
    this.updateConfigOptions(result?.configOptions ?? []);

    if (requestedConfig.model) await this.applyConfigOption("model", requestedConfig.model);
    if (requestedConfig.effort) await this.applyConfigOption("effort", requestedConfig.effort);
    // 安全边界：即使 session/new 声称 currentModeId=default，也必须实际设置 mode。
    await this.applyConfigOption("permissionMode", requestedConfig.permissionMode ?? "default");
    this.callbacks.metadata({
      nativeSessionId: this.nativeSessionId,
      config: { ...this.config },
    });
    this.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return kimiConfigSchemaFromOptions(this.configOptions);
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    const entries = (["model", "effort", "permissionMode"] as ConfigOptionId[])
      .filter((id) => config[id] !== undefined);
    if (entries.length === 0) throw new Error("Kimi set_config 没有可修改的配置项");
    for (const id of entries) await this.applyConfigOption(id, config[id]!);
    const current = { ...this.config };
    this.callbacks.metadata({ config: current });
    return current;
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.nativeSessionId) throw new Error("Kimi session 尚未就绪");
    this.callbacks.status("running");
    void this.request("session/prompt", {
      sessionId: this.nativeSessionId,
      prompt: [{ type: "text", text }],
    }).then((result) => {
      this.callbacks.emit("turn_completed", {
        stopReason: result?.stopReason,
        result,
      });
      this.callbacks.status("idle");
    }).catch((error) => {
      this.callbacks.emit("session_error", { message: errorMessage(error), source: "session/prompt" });
      this.callbacks.status("error");
    });
  }

  async resolvePermission(requestId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`Kimi permission_request 不存在：${requestId}`);
    if (pending.method === "session/request_permission") {
      this.resolveStandardPermission(pending, decision);
    } else if (pending.method === "terminal/create") {
      this.resolveTerminalGate(pending, decision, updatedInput);
    } else {
      this.resolveWriteGate(pending, decision, updatedInput);
    }
    this.permissions.delete(requestId);
  }

  async interrupt(): Promise<void> {
    if (!this.nativeSessionId) return;
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.nativeSessionId } });
  }

  async stop(): Promise<void> {
    for (const terminal of this.terminals.values()) {
      if (terminal.process.exitCode === null && terminal.process.signalCode === null) terminal.process.kill("SIGTERM");
    }
    if (this.nativeSessionId && this.child?.stdin.writable) {
      try {
        await withTimeout(this.request("session/close", { sessionId: this.nativeSessionId }), 1_000, "Kimi session/close");
      } catch { /* process shutdown remains authoritative */ }
    }
    await super.stop();
  }

  protected handleStdoutLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      this.callbacks.emit("raw_event", { source: "stdout", raw: line });
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      const id = Number(message.id);
      const pending = this.rpc.get(id);
      if (pending) {
        this.rpc.delete(id);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") {
      this.callbacks.emit("raw_event", { source: "kimi", raw: message });
      return;
    }
    if (Object.hasOwn(message, "id")) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method === "session/update") {
      this.handleSessionUpdate(message.params ?? {});
      return;
    }
    this.callbacks.emit("raw_event", { source: "kimi", method: message.method, params: message.params ?? {} });
  }

  private handleServerRequest(message: Record<string, any>): void {
    const method = message.method as string;
    if (method === "session/request_permission") {
      this.queuePermission(message, "session/request_permission", "session/request_permission", {
        toolName: message.params?.toolCall?.title ?? "tool",
        toolCall: message.params?.toolCall,
        options: message.params?.options ?? [],
      });
      return;
    }
    if (method === "terminal/create") {
      // 最终闸门：无论 mode 或上游标准审批是否已经放行，都不能直接执行。
      this.queuePermission(message, "terminal/create", "terminal/create", {
        toolName: "terminal/create",
        input: message.params ?? {},
        finalGate: true,
      });
      return;
    }
    if (method === "fs/write_text_file") {
      // 最终闸门：ACP 的 fs 回退路径与 terminal 路径同等敏感。
      this.queuePermission(message, "fs/write_text_file", "fs/write_text_file", {
        toolName: "fs/write_text_file",
        input: message.params ?? {},
        finalGate: true,
      });
      return;
    }
    if (method === "fs/read_text_file") {
      this.handleReadTextFile(message.id, message.params ?? {});
      return;
    }
    if (method === "terminal/output") {
      this.handleTerminalOutput(message.id, message.params ?? {});
      return;
    }
    if (method === "terminal/wait_for_exit") {
      this.handleTerminalWait(message.id, message.params ?? {});
      return;
    }
    if (method === "terminal/release") {
      this.handleTerminalRelease(message.id, message.params ?? {});
      return;
    }
    this.replyError(message.id, -32601, `Workbench 未实现 Kimi 方法：${method}`);
  }

  private queuePermission(
    message: Record<string, any>,
    pendingMethod: KimiPermission["method"],
    gate: string,
    payload: Record<string, unknown>,
  ): void {
    const requestId = `kimi:${gate}:${String(message.id)}`;
    this.permissions.set(requestId, {
      rpcId: message.id,
      method: pendingMethod,
      params: message.params ?? {},
    });
    this.callbacks.emit("permission_request", { requestId, gate, ...payload });
  }

  private resolveStandardPermission(pending: KimiPermission, decision: PermissionDecision): void {
    const options = pending.params.options ?? [];
    const desiredKind = decision === "deny" ? "reject_once" : decision === "always" ? "allow_always" : "allow_once";
    const option = options.find((item: any) => item.kind === desiredKind)
      ?? options.find((item: any) => decision === "deny" ? String(item.kind).startsWith("reject") : String(item.kind).startsWith("allow"));
    const outcome = option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" };
    this.replyResult(pending.rpcId, { outcome });
  }

  private resolveTerminalGate(pending: KimiPermission, decision: PermissionDecision, updatedInput?: unknown): void {
    if (decision === "deny") {
      this.replyError(pending.rpcId, -32001, "用户拒绝 terminal/create");
      return;
    }
    const params = this.mergedParams(pending.params, updatedInput);
    const terminalId = `workbench-${this.sessionId}-${++this.terminalCounter}`;
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const envEntries = Array.isArray(params.env) ? params.env : [];
    const env = { ...process.env };
    for (const entry of envEntries) {
      if (entry && typeof entry.name === "string") env[entry.name] = String(entry.value ?? "");
    }
    const outputLimit = Math.max(1, Number(params.outputByteLimit) || 4 * 1024 * 1024);
    const processHandle = spawn(String(params.command), args, {
      cwd: typeof params.cwd === "string" ? params.cwd : this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finish!: () => void;
    const state: TerminalState = {
      process: processHandle,
      output: "",
      truncated: false,
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    const collect = (chunk: Buffer) => {
      const remaining = outputLimit - Buffer.byteLength(state.output);
      if (remaining <= 0) {
        state.truncated = true;
        return;
      }
      const slice = chunk.subarray(0, remaining);
      state.output += slice.toString("utf8");
      if (slice.length < chunk.length) state.truncated = true;
    };
    processHandle.stdout.on("data", collect);
    processHandle.stderr.on("data", collect);
    processHandle.on("close", (code, signal) => {
      state.exitCode = code ?? undefined;
      state.signal = signal ?? undefined;
      finish();
    });
    processHandle.on("error", (error) => {
      state.output += error.message;
      finish();
    });
    this.terminals.set(terminalId, state);
    this.replyResult(pending.rpcId, { terminalId });
  }

  private resolveWriteGate(pending: KimiPermission, decision: PermissionDecision, updatedInput?: unknown): void {
    if (decision === "deny") {
      this.replyError(pending.rpcId, -32001, "用户拒绝 fs/write_text_file");
      return;
    }
    const params = this.mergedParams(pending.params, updatedInput);
    try {
      writeFileSync(String(params.path), String(params.content ?? ""), "utf8");
      this.replyResult(pending.rpcId, {});
    } catch (error) {
      this.replyError(pending.rpcId, -32000, errorMessage(error));
    }
  }

  private handleReadTextFile(id: string | number, params: Record<string, any>): void {
    try {
      let content = readFileSync(String(params.path), "utf8");
      const startLine = Math.max(1, Number(params.line) || 1);
      const limit = Number(params.limit);
      if (startLine > 1 || Number.isFinite(limit)) {
        const lines = content.split("\n");
        content = lines.slice(startLine - 1, Number.isFinite(limit) ? startLine - 1 + limit : undefined).join("\n");
      }
      this.replyResult(id, { content });
    } catch (error) {
      this.replyError(id, -32000, errorMessage(error));
    }
  }

  private handleTerminalOutput(id: string | number, params: Record<string, any>): void {
    const terminal = this.terminals.get(String(params.terminalId));
    if (!terminal) {
      this.replyError(id, -32602, "unknown terminal");
      return;
    }
    this.replyResult(id, {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitCode !== undefined ? {
        exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal ?? null },
      } : {}),
    });
  }

  private handleTerminalWait(id: string | number, params: Record<string, any>): void {
    const terminal = this.terminals.get(String(params.terminalId));
    if (!terminal) {
      this.replyError(id, -32602, "unknown terminal");
      return;
    }
    void terminal.done.then(() => this.replyResult(id, {
      exitCode: terminal.exitCode ?? null,
      signal: terminal.signal ?? null,
    }));
  }

  private handleTerminalRelease(id: string | number, params: Record<string, any>): void {
    const terminal = this.terminals.get(String(params.terminalId));
    if (!terminal) {
      this.replyError(id, -32602, "unknown terminal");
      return;
    }
    this.terminals.delete(String(params.terminalId));
    this.replyResult(id, {});
  }

  private handleSessionUpdate(params: Record<string, any>): void {
    const update = params.update ?? {};
    const type = update.sessionUpdate;
    if (type === "config_option_update") {
      this.updateConfigOptions(update.configOptions ?? []);
      this.callbacks.metadata({ config: { ...this.config } });
      return;
    }
    if (type === "current_mode_update" && typeof update.currentModeId === "string") {
      this.config.permissionMode = update.currentModeId;
      this.callbacks.metadata({ config: { ...this.config } });
      return;
    }
    if (type === "agent_message_chunk") {
      this.callbacks.emit("agent_text_delta", { text: update.content?.text ?? "" });
      return;
    }
    if (type === "agent_thought_chunk") {
      this.callbacks.emit("thought_delta", { text: update.content?.text ?? "" });
      return;
    }
    if (type === "tool_call") {
      this.callbacks.emit("tool_call_started", {
        toolCallId: update.toolCallId,
        toolName: update.title,
        input: update.rawInput ?? update.content ?? [],
        status: update.status,
      });
      return;
    }
    if (type === "tool_call_update") {
      const payload = {
        toolCallId: update.toolCallId,
        toolName: update.title,
        input: update.rawInput,
        content: update.content,
        status: update.status,
      };
      if (["completed", "failed"].includes(update.status)) {
        this.callbacks.emit("tool_call_completed", { ...payload, isError: update.status === "failed" });
      } else {
        this.callbacks.emit("tool_call_updated", payload);
      }
      return;
    }
    if (type === "usage_update") {
      this.callbacks.emit("usage_updated", { used: update.used, size: update.size });
      return;
    }
    const quiet = new Set([
      "available_commands_update", "session_info_update",
    ]);
    if (!quiet.has(type)) this.callbacks.emit("raw_event", { source: "kimi", update });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.rpcId++;
    return new Promise((resolve, reject) => {
      this.rpc.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async applyConfigOption(id: ConfigOptionId, value: string): Promise<void> {
    const schema = this.getConfigSchema();
    const option = schema.options.find((item) => item.id === id);
    if (!option) throw new Error(`Kimi session/new 未提供配置项：${id}`);
    if (!option.values.some((item) => item.value === value)) {
      throw new Error(`Kimi ${id} 不合法：${value}`);
    }
    const result = await withTimeout(this.request("session/set_config_option", {
      sessionId: this.nativeSessionId,
      configId: KIMI_CONFIG_IDS[id],
      value,
    }), 15_000, `Kimi session/set_config_option(${id})`);
    if (Array.isArray(result?.configOptions)) {
      this.updateConfigOptions(result.configOptions);
    } else {
      this.config[id] = value;
    }
  }

  private updateConfigOptions(configOptions: AcpConfigOption[]): void {
    this.configOptions = configOptions;
    this.config = kimiConfigFromOptions(configOptions);
  }

  private replyResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private mergedParams(original: Record<string, any>, updatedInput?: unknown): Record<string, any> {
    return updatedInput && typeof updatedInput === "object"
      ? { ...original, ...updatedInput as Record<string, any> }
      : original;
  }
}
