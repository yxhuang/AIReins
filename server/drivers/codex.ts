import type {
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  SessionConfig,
} from "../types.js";
import { mergeSessionConfig } from "../session-config.js";
import { BaseDriver, errorMessage, parseJsonLine, withTimeout } from "./base.js";
import { StdioRpcProbe } from "./rpc-probe.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
}

interface CodexPermission {
  rpcId: string | number;
  method: string;
  params: Record<string, any>;
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

interface CodexModelInfo {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

interface CodexEffectiveConfig {
  model?: unknown;
  model_reasoning_effort?: unknown;
}

export function codexConfigSchemaFromModels(
  models: CodexModelInfo[],
  effectiveConfig?: CodexEffectiveConfig,
): DriverConfigSchema {
  const builtInDefaultModel = models.find((model) => model.isDefault) ?? models[0];
  const configuredModel = typeof effectiveConfig?.model === "string" ? effectiveConfig.model : undefined;
  const effectiveModel = models.find((model) => (model.model ?? model.id) === configuredModel)
    ?? builtInDefaultModel;
  const configuredEffort = typeof effectiveConfig?.model_reasoning_effort === "string"
    ? effectiveConfig.model_reasoning_effort
    : undefined;
  const builtInEffort = CODEX_EFFORTS.includes(effectiveModel?.defaultReasoningEffort ?? "")
    ? effectiveModel!.defaultReasoningEffort!
    : null;
  // effectiveConfig === undefined 表示 config/read 不可用；此时宁可报告未知，也不猜内建默认值。
  const defaultModel = effectiveConfig === undefined
    ? null
    : configuredModel ?? (String(builtInDefaultModel?.model ?? builtInDefaultModel?.id ?? "") || null);
  const defaultEffort = effectiveConfig === undefined ? null : configuredEffort ?? builtInEffort;
  return {
    source: "Codex app-server config/read, model/list and v2 protocol schema",
    options: [
      {
        id: "model",
        name: "模型",
        values: [
          { value: null, label: "跟随 Codex 配置" },
          ...models.map((model) => ({
            value: String(model.model ?? model.id ?? ""),
            label: String(model.displayName ?? model.model ?? model.id ?? ""),
            ...(model.description ? { description: model.description } : {}),
          })).filter((value) => value.value),
        ],
        default: defaultModel,
        mutable: true,
      },
      {
        id: "effort",
        name: "推理强度",
        values: [
          { value: null, label: "跟随 Codex 配置" },
          ...CODEX_EFFORTS.map((value) => ({ value, label: value })),
        ],
        default: defaultEffort,
        mutable: true,
      },
      {
        id: "permissionMode",
        name: "审批模式",
        values: [
          { value: "untrusted", label: "Untrusted" },
          { value: "on-request", label: "On Request" },
          { value: "never", label: "Never" },
        ],
        default: "untrusted",
        mutable: true,
      },
    ],
  };
}

export async function probeCodexConfigSchema(cwd: string): Promise<DriverConfigSchema> {
  const probe = new StdioRpcProbe("codex", ["app-server", "--stdio"], cwd);
  try {
    await probe.request("initialize", {
      clientInfo: { name: "workbench-meta", title: "Workbench metadata probe", version: "0.1.0" },
      capabilities: null,
    });
    probe.notify("initialized", {});
    let effectiveConfig: CodexEffectiveConfig | undefined;
    try {
      const configResult = await probe.request("config/read", { cwd, includeLayers: false });
      effectiveConfig = configResult?.config ?? {};
    } catch { /* 旧版 app-server 没有 config/read 时，schema 默认值保持 null。 */ }
    const result = await probe.request("model/list", { limit: 100, includeHidden: false });
    return codexConfigSchemaFromModels(Array.isArray(result?.data) ? result.data : [], effectiveConfig);
  } finally {
    await probe.close();
  }
}

export class CodexDriver extends BaseDriver {
  readonly kind = "codex" as const;
  private rpcId = 1_000;
  private readonly rpc = new Map<number, PendingRpc>();
  private readonly permissions = new Map<string, CodexPermission>();
  private threadId = "";
  private turnId = "";
  private configSchema = codexConfigSchemaFromModels([], undefined);
  private sendModel: boolean;
  private sendEffort: boolean;

  constructor(options: DriverOptions) {
    super(options);
    this.sendModel = Boolean(options.config.model);
    this.sendEffort = Boolean(options.config.effort);
  }

  async start(): Promise<void> {
    this.spawnProcess("codex", ["app-server", "--stdio"]);
    const initialized = await withTimeout(this.request("initialize", {
      clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
      capabilities: null,
    }), 15_000, "Codex initialize");
    if (!initialized) throw new Error("Codex initialize 未返回 result");
    this.notify("initialized", {});
    let effectiveConfig: CodexEffectiveConfig | undefined;
    try {
      const configResult = await withTimeout(this.request("config/read", {
        cwd: this.cwd,
        includeLayers: false,
      }), 15_000, "Codex config/read");
      effectiveConfig = configResult?.config ?? {};
    } catch (error) {
      this.callbacks.emit("raw_event", {
        source: "codex",
        method: "config/read",
        warning: `无法读取有效配置，未覆盖项将报告为 null：${errorMessage(error)}`,
      });
    }
    const models = await withTimeout(this.request("model/list", {
      limit: 100,
      includeHidden: false,
    }), 15_000, "Codex model/list");
    this.configSchema = codexConfigSchemaFromModels(
      Array.isArray(models?.data) ? models.data : [],
      effectiveConfig,
    );
    this.validateConfig(this.config);
    const modelOption = this.configSchema.options.find((option) => option.id === "model");
    const effortOption = this.configSchema.options.find((option) => option.id === "effort");
    this.config = {
      model: this.config.model ?? modelOption?.default,
      effort: this.config.effort ?? effortOption?.default,
      permissionMode: this.config.permissionMode ?? "untrusted",
    };
    const threadOverrides = {
      ...(this.sendModel && this.config.model ? { model: this.config.model } : {}),
      approvalPolicy: this.config.permissionMode,
      ...(this.sendEffort && this.config.effort
        ? { config: { model_reasoning_effort: this.config.effort } }
        : {}),
    };
    const result = this.resumeSessionId
      ? await withTimeout(this.request("thread/resume", {
        threadId: this.resumeSessionId,
        cwd: this.cwd,
        ...threadOverrides,
      }), 15_000, "Codex thread/resume")
      : await withTimeout(this.request("thread/start", {
        cwd: this.cwd,
        ...threadOverrides,
        sandbox: "workspace-write",
        ephemeral: false,
        serviceName: "workbench",
      }), 15_000, "Codex thread/start");
    this.threadId = result?.thread?.id ?? result?.id ?? this.resumeSessionId ?? "";
    if (!this.threadId) throw new Error("Codex 未返回 thread id");
    this.config = {
      model: typeof result?.model === "string" ? result.model : this.config.model ?? null,
      effort: typeof result?.reasoningEffort === "string"
        ? result.reasoningEffort
        : result?.reasoningEffort === null ? null : this.config.effort ?? null,
      permissionMode: typeof result?.approvalPolicy === "string"
        ? result.approvalPolicy
        : this.config.permissionMode ?? "untrusted",
    };
    this.callbacks.metadata({
      nativeSessionId: this.threadId,
      nativeTranscriptPath: result?.thread?.path,
      config: { ...this.config },
    });
    this.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return this.configSchema;
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    this.validateConfig(config);
    this.config = mergeSessionConfig(this.config, config);
    if (config.model !== undefined) this.sendModel = true;
    if (config.effort !== undefined) this.sendEffort = true;
    this.callbacks.metadata({ config: { ...this.config } });
    return { ...this.config };
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread 尚未就绪");
    this.callbacks.status("running");
    this.turnId = "";
    void this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: this.config.permissionMode ?? "untrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      ...(this.sendModel && this.config.model ? { model: this.config.model } : {}),
      ...(this.sendEffort && this.config.effort ? { effort: this.config.effort } : {}),
    }).then((result) => {
      if (result?.turn?.id) this.turnId = result.turn.id;
    }).catch((error) => {
      this.callbacks.emit("session_error", { message: errorMessage(error), source: "turn/start" });
      this.callbacks.status("error");
    });
  }

  async resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`Codex permission_request 不存在：${requestId}`);
    let protocolDecision: unknown = decision === "deny" ? "cancel" : "accept";
    if (decision === "always") {
      const amendment = pending.params.availableDecisions?.find(
        (item: unknown) => item && typeof item === "object" && "acceptWithExecpolicyAmendment" in item,
      );
      if (amendment) protocolDecision = amendment;
    }
    this.send({ jsonrpc: "2.0", id: pending.rpcId, result: { decision: protocolDecision } });
    this.permissions.delete(requestId);
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  async stop(): Promise<void> {
    if (this.threadId && this.child?.stdin.writable) {
      try {
        await withTimeout(this.request("thread/unsubscribe", { threadId: this.threadId }), 1_000, "Codex unsubscribe");
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
      this.callbacks.emit("raw_event", { source: "codex", raw: message });
      return;
    }
    if (APPROVAL_METHODS.has(message.method) && Object.hasOwn(message, "id")) {
      const requestId = `codex:${String(message.id)}`;
      this.permissions.set(requestId, { rpcId: message.id, method: message.method, params: message.params ?? {} });
      this.callbacks.emit("permission_request", {
        requestId,
        gate: message.method,
        toolName: this.approvalToolName(message.method),
        input: message.params ?? {},
        availableDecisions: message.params?.availableDecisions ?? [],
      });
      return;
    }
    this.handleNotification(message.method, message.params ?? {});
  }

  private handleNotification(method: string, params: Record<string, any>): void {
    if (method === "item/agentMessage/delta") {
      this.callbacks.emit("agent_text_delta", { text: params.delta ?? "", itemId: params.itemId });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.callbacks.emit("thought_delta", { text: params.delta ?? "", itemId: params.itemId });
      return;
    }
    if (method === "item/started") {
      const item = params.item ?? {};
      if (this.isToolItem(item.type)) {
        this.callbacks.emit("tool_call_started", {
          toolCallId: item.id,
          toolName: item.type,
          input: item,
        });
      }
      return;
    }
    if (method === "item/completed") {
      const item = params.item ?? {};
      if (this.isToolItem(item.type)) {
        this.callbacks.emit("tool_call_completed", {
          toolCallId: item.id,
          toolName: item.type,
          result: item,
          isError: item.status === "failed" || item.status === "declined",
        });
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.callbacks.emit("usage_updated", { usage: params.tokenUsage ?? {}, turnId: params.turnId });
      return;
    }
    if (method === "turn/started") {
      this.turnId = params.turn?.id ?? params.turnId ?? this.turnId;
      this.callbacks.status("running");
      return;
    }
    if (method === "turn/completed") {
      this.turnId = params.turn?.id ?? params.turnId ?? this.turnId;
      this.callbacks.emit("turn_completed", {
        turnId: this.turnId,
        status: params.turn?.status,
        error: params.turn?.error,
      });
      this.callbacks.status(params.turn?.status === "failed" ? "error" : "idle");
      return;
    }
    const quiet = new Set([
      "remoteControl/status/changed", "thread/started", "thread/status/changed",
      "thread/goal/cleared", "mcpServer/startupStatus/updated", "serverRequest/resolved",
      "account/rateLimits/updated",
    ]);
    if (!quiet.has(method)) this.callbacks.emit("raw_event", { source: "codex", method, params });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.rpcId++;
    return new Promise((resolve, reject) => {
      this.rpc.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private isToolItem(type: unknown): boolean {
    return ![undefined, "userMessage", "agentMessage", "reasoning"].includes(type as string | undefined);
  }

  private approvalToolName(method: string): string {
    if (method.includes("commandExecution")) return "commandExecution";
    if (method.includes("fileChange")) return "fileChange";
    return "permissions";
  }

  private validateConfig(config: SessionConfig): void {
    for (const [id, value] of Object.entries(config)) {
      if (value === undefined || value === null) continue;
      const option = this.configSchema.options.find((item) => item.id === id);
      if (!option) throw new Error(`Codex 不支持配置项：${id}`);
      if (!option.values.some((item) => item.value === value)) {
        throw new Error(`Codex ${id} 不合法：${value}`);
      }
    }
  }
}
