import type {
  ConfigOptionId,
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  UserMessageInput,
} from "../types.js";
import { relative, sep } from "node:path";
import { isRiskyConfig, mergeSessionConfig } from "../session-config.js";
import { BaseDriver, errorMessage, parseJsonLine, userMessageText, withTimeout } from "./base.js";
import { StdioRpcProbe } from "./rpc-probe.js";
import { CODEX_COMMANDS, codexSkillInputs, codexSkillsForCwd, parseCodexCommand } from "../codex-commands.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
}

interface CodexPermission {
  rpcId: string | number;
  method: string;
  params: Record<string, any>;
}

interface CodexQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  isOther: boolean;
}

interface CodexUserInput {
  rpcId: string | number;
  questions: CodexQuestion[];
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

interface CodexPermissions {
  approvalPolicy: unknown;
  approvalsReviewer: "user" | "auto_review";
  sandbox: "workspace-write" | "danger-full-access";
  sandboxPolicy: Record<string, unknown>;
}

function codexPermissions(mode: string): CodexPermissions {
  const sandbox = mode === "full-access" ? "danger-full-access" : "workspace-write";
  return {
    approvalPolicy: mode === "full-access" || mode === "never" ? "never"
      : mode === "untrusted" ? "untrusted" : "on-request",
    approvalsReviewer: mode === "auto-review" ? "auto_review" : "user",
    sandbox,
    sandboxPolicy: sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
      : {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
  };
}

function permissionModeFromResult(result: any, requested: string): string {
  if (result?.approvalPolicy === "untrusted") return "untrusted";
  const sandboxType = result?.sandbox?.type;
  const reviewer = result?.approvalsReviewer;
  if (result?.approvalPolicy === "never") {
    return sandboxType === "dangerFullAccess" ? "full-access" : "never";
  }
  if (result?.approvalPolicy === "on-request") {
    if (sandboxType && sandboxType !== "workspaceWrite") {
      throw new Error("Codex 返回的沙盒与所选权限模式不一致");
    }
    return reviewer === "auto_review" || reviewer === "guardian_subagent" ? "auto-review"
      : reviewer === "user" ? "on-request" : requested;
  }
  return requested;
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
        name: "权限模式",
        values: [
          { value: "on-request", label: "Ask for approval", description: "在工作区内执行，额外权限由你审批" },
          { value: "auto-review", label: "Approve for me", description: "保留工作区沙盒，额外权限由 Codex 自动审核" },
          { value: "full-access", label: "Full access", description: "不使用沙盒，也不弹出执行审批" },
        ],
        default: "on-request",
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
  private readonly userInputs = new Map<string, CodexUserInput>();
  private threadId = "";
  private turnId = "";
  private configSchema = codexConfigSchemaFromModels([], undefined);
  private sendModel: boolean;
  private sendEffort: boolean;
  private clearModelNextTurn = false;
  private clearEffortNextTurn = false;
  private readonly pendingConfigFields = new Set<ConfigOptionId>();
  private applyingConfig?: ApplyingConfig;

  constructor(options: DriverOptions) {
    super(options);
    // 旧会话的 never 只关闭审批，不能因菜单升级而自动获得 Full access。
    this.config.permissionMode ??= "on-request";
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
      permissionMode: this.config.permissionMode ?? "on-request",
    };
    const permissions = codexPermissions(this.config.permissionMode!);
    const threadOverrides = {
      ...(this.sendModel && this.config.model ? { model: this.config.model } : {}),
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandbox: permissions.sandbox,
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
      permissionMode: permissionModeFromResult(result, this.config.permissionMode ?? "on-request"),
    };
    this.callbacks.metadata({
      nativeSessionId: this.threadId,
      nativeTranscriptPath: result?.thread?.path,
      config: { ...this.config },
    });
    this.callbacks.status("idle");
    this.callbacks.commands(CODEX_COMMANDS.map(c => ({ ...c })));
  }

  async queryInfo(kind: string): Promise<unknown> {
    if (kind === "skills") {
      const result = await withTimeout(this.request("skills/list", { cwds: [this.cwd], forceReload: true }), 15_000, "Codex skills/list");
      return codexSkillsForCwd(result, this.cwd);
    }
    if (kind === "status") {
      const result = await withTimeout(this.request("thread/read", { threadId: this.threadId, includeTurns: false }), 15_000, "Codex thread/read");
      return { ...result, config: { ...this.config } };
    }
    if (kind === "model" || kind === "mcp") {
      const method = kind === "model" ? "model/list" : "mcpServerStatus/list";
      const data: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await withTimeout(this.request(method, {
          limit: 100, ...(cursor ? { cursor } : {}),
          ...(kind === "model" ? { includeHidden: false } : { threadId: this.threadId }),
        }), 15_000, `Codex ${method}`);
        if (Array.isArray(result?.data)) data.push(...result.data);
        cursor = result?.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Codex 分页 cursor 重复");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { data, nextCursor: null };
    }
    throw new Error(`未知 Codex 查看项：${kind}`);
  }

  async executeCommand(name: string, args?: string): Promise<unknown> {
    const command = parseCodexCommand({ name, arguments: args });
    if (["status", "model", "mcp", "skills"].includes(name)) return this.queryInfo(name);
    if (name === "interrupt") {
      if (!this.turnId) throw new Error("当前没有可中断的执行");
      await withTimeout(this.interrupt(), 15_000, "Codex turn/interrupt");
      return { message: "中断请求已接受；以执行结束事件为准" };
    }
    if (name !== "compact" && name !== "review") throw new Error("新会话必须通过 Workbench 会话管理器创建");
    this.callbacks.status("running");
    this.turnId = "";
    try {
      const result = await withTimeout(this.request(name === "compact" ? "thread/compact/start" : "review/start", {
        threadId: this.threadId,
        ...(name === "review" ? { delivery: "inline", target: command.arguments
          ? { type: "custom", instructions: command.arguments }
          : { type: "uncommittedChanges" } } : {}),
      }), 15_000, `Codex ${name}`);
      if (result?.turn?.id) this.turnId = result.turn.id;
      return { ...result, message: name === "compact" ? "压缩请求已接受；进度显示在当前对话" : "审查已开始；结果显示在当前对话" };
    } catch (error) {
      this.callbacks.status("idle");
      throw error;
    }
  }

  getConfigSchema(): DriverConfigSchema {
    return this.configSchema;
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    this.validateConfig(config);
    this.config = mergeSessionConfig(this.config, config);
    this.config.permissionMode ??= "on-request";
    if (config.model !== undefined) {
      this.sendModel = config.model !== null;
      this.clearModelNextTurn = config.model === null;
      if (config.model === null) this.config.model = this.configDefault("model");
      this.pendingConfigFields.add("model");
    }
    if (config.effort !== undefined) {
      this.sendEffort = config.effort !== null;
      this.clearEffortNextTurn = config.effort === null;
      if (config.effort === null) this.config.effort = this.configDefault("effort");
      this.pendingConfigFields.add("effort");
    }
    if (config.permissionMode !== undefined) this.pendingConfigFields.add("permissionMode");
    this.callbacks.metadata({ config: { ...this.config } });
    return { ...this.config };
  }

  async sendUserMessage(message: UserMessageInput): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread 尚未就绪");
    if (message.command) throw new Error("Codex 命令必须通过会话命令接口执行");
    const input: Record<string, unknown>[] = [];
    let text = userMessageText(message);
    const textElements: Array<{ byteRange: { start: number; end: number }; placeholder: string }> = [];
    let searchFrom = 0;
    // text_elements 与 mention 项只覆盖文件引用；图片走 localImage（schema 见 spikes/PROTOCOL-NOTES.md）
    const fileMentions = (message.mentions ?? []).filter((mention) => mention.type === "file");
    const imageMentions = (message.mentions ?? []).filter((mention) => mention.type === "image");
    for (const mention of fileMentions) {
      const name = this.mentionPath(mention.path);
      const marker = `@${name}`;
      let markerIndex = text.indexOf(marker, searchFrom);
      if (markerIndex < 0) {
        text = `${text}${text ? "\n" : ""}${marker}`;
        markerIndex = text.length - marker.length;
      }
      const start = Buffer.byteLength(text.slice(0, markerIndex), "utf8");
      textElements.push({
        byteRange: { start, end: start + Buffer.byteLength(marker, "utf8") },
        placeholder: marker,
      });
      searchFrom = markerIndex + marker.length;
    }
    if (text) input.push({ type: "text", text, text_elements: textElements });
    for (const mention of fileMentions) {
      const name = this.mentionPath(mention.path);
      input.push({
        type: "mention",
        name,
        path: mention.path,
      });
    }
    for (const mention of imageMentions) {
      input.push({
        type: "localImage",
        path: mention.path,
      });
    }
    if (/\$[^\s]+/.test(text)) {
      const listing = await this.queryInfo("skills") as ReturnType<typeof codexSkillsForCwd>;
      input.push(...codexSkillInputs(text, listing.skills));
    }
    this.callbacks.status("running");
    this.turnId = "";
    const applyingConfig = this.capturePendingConfig();
    const permissions = codexPermissions(this.config.permissionMode ?? "on-request");
    void this.request("turn/start", {
      threadId: this.threadId,
      input,
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
      ...(applyingConfig?.clearModel
        ? { model: null }
        : this.sendModel && this.config.model ? { model: this.config.model } : {}),
      ...(applyingConfig?.clearEffort
        ? { effort: null }
        : this.sendEffort && this.config.effort ? { effort: this.config.effort } : {}),
    }).then((result) => {
      if (result?.turn?.id) this.turnId = result.turn.id;
      this.confirmAppliedConfig(applyingConfig, this.turnId);
    }).catch((error) => {
      this.restorePendingConfig(applyingConfig);
      this.callbacks.emit("session_error", { message: errorMessage(error), source: "turn/start" });
      this.callbacks.status("error");
    });
  }

  async resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    const userInput = this.userInputs.get(requestId);
    if (userInput) {
      if (updatedInput !== undefined) throw new Error("Codex 提问不接受 updatedInput");
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      if (decision !== "deny") {
        if (!questionAnswers) throw new Error("Codex 提问缺少 questionAnswers");
        if (Object.keys(questionAnswers).length !== userInput.questions.length) {
          throw new Error("Codex 提问必须回答全部问题");
        }
        for (const question of userInput.questions) {
          if (!Object.hasOwn(questionAnswers, question.question)) {
            throw new Error(`Codex 提问缺少答案：${question.question}`);
          }
          const answer = questionAnswers[question.question]!.trim();
          if (!question.isOther && !question.options.some((option) => option.label === answer)) {
            throw new Error(`Codex 提问不接受自由文本：${question.question}`);
          }
          answers[question.id] = { answers: [answer] };
        }
      }
      this.send({ jsonrpc: "2.0", id: userInput.rpcId, result: { answers } });
      this.userInputs.delete(requestId);
      return;
    }
    if (questionAnswers !== undefined) throw new Error("Codex 普通审批不接受 questionAnswers");
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
    this.cancelUserInputs();
    if (!this.threadId || !this.turnId) return;
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  async stop(): Promise<void> {
    this.cancelUserInputs();
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
    if (message.method === "item/tool/requestUserInput" && Object.hasOwn(message, "id")) {
      const rawQuestions = message.params?.questions;
      const questions: CodexQuestion[] = Array.isArray(rawQuestions)
        ? rawQuestions.map((raw: any) => ({
          id: raw?.id,
          question: raw?.question,
          options: Array.isArray(raw?.options) ? raw.options : [],
          isOther: raw?.isOther === true,
        })) : [];
      const valid = questions.length > 0 && questions.length <= 4
        && questions.every((q, i) => typeof q.id === "string" && q.id
          && typeof q.question === "string" && q.question
          && q.options.length > 0 && q.options.every((o) => typeof o?.label === "string" && o.label)
          && new Set(q.options.map((o) => o.label)).size === q.options.length
          && rawQuestions[i]?.isSecret !== true)
        && new Set(questions.map((q) => q.question)).size === questions.length
        && new Set(questions.map((q) => q.id)).size === questions.length;
      const requestId = `codex:question:${String(message.id)}`;
      if (!valid) {
        // 无选项、秘密字段或超出前端限制时，安全结束本次请求，避免展示不可回答的卡片。
        this.send({ jsonrpc: "2.0", id: message.id, result: { answers: {} } });
        this.callbacks.emit("raw_event", { source: "codex", method: message.method,
          warning: "提问包含前端无法表达的字段，已按跳过处理" });
        return;
      }
      this.userInputs.set(requestId, { rpcId: message.id, questions });
      this.callbacks.emit("permission_request", {
        requestId, gate: message.method, toolName: "requestUserInput",
        interactionType: "ask_user_question", questionProtocol: "codex_request_user_input_v1",
        questions: questions.map((q, i) => ({
          question: q.question, header: rawQuestions[i].header,
          options: q.options, multiSelect: false, otherSupported: q.isOther,
        })),
        otherSupported: questions.every((q) => q.isOther),
        protocolLimitations: ["Codex schema 无多选字段；每题只回传一个答案", "isOther=false 时不接受自由文本"],
      });
      return;
    }
    this.handleNotification(message.method, message.params ?? {});
  }

  protected handleProcessExit(): void {
    this.userInputs.clear();
  }

  private cancelUserInputs(): void {
    for (const [requestId, pending] of this.userInputs) {
      if (this.child?.stdin.writable) {
        this.send({ jsonrpc: "2.0", id: pending.rpcId, result: { answers: {} } });
      }
      this.userInputs.delete(requestId);
    }
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
      this.confirmAppliedConfig(this.applyingConfig, this.turnId);
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

  private mentionPath(path: string): string {
    const relativePath = relative(this.cwd, path);
    return relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
      ? relativePath
      : path;
  }

  private configDefault(id: "model" | "effort"): string | null {
    return this.configSchema.options.find((option) => option.id === id)?.default ?? null;
  }

  private capturePendingConfig(): ApplyingConfig | undefined {
    if (this.pendingConfigFields.size === 0) return undefined;
    const fields = [...this.pendingConfigFields];
    for (const field of fields) this.pendingConfigFields.delete(field);
    const applying = {
      fields,
      config: { ...this.config },
      clearModel: this.clearModelNextTurn,
      clearEffort: this.clearEffortNextTurn,
    };
    this.applyingConfig = applying;
    return applying;
  }

  private confirmAppliedConfig(
    applying: ApplyingConfig | undefined,
    turnId: string,
  ): void {
    if (!applying || this.applyingConfig !== applying) return;
    this.applyingConfig = undefined;
    if (applying.clearModel && !this.sendModel) this.clearModelNextTurn = false;
    if (applying.clearEffort && !this.sendEffort) this.clearEffortNextTurn = false;
    this.callbacks.emit("config_updated", {
      config: { ...this.config },
      model: this.config.model ?? null,
      effort: this.config.effort ?? null,
      permissionMode: this.config.permissionMode ?? null,
      riskyMode: isRiskyConfig("codex", this.config),
      effectiveConfig: { ...applying.config },
      appliedFields: applying.fields,
      effectiveFrom: "current_turn",
      ...(turnId ? { turnId } : {}),
    });
  }

  private restorePendingConfig(applying: ApplyingConfig | undefined): void {
    if (!applying || this.applyingConfig !== applying) return;
    this.applyingConfig = undefined;
    for (const field of applying.fields) this.pendingConfigFields.add(field);
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
      // 仅兼容当前旧会话；不再提供为新会话选择旧策略的入口。
      if (id === "permissionMode" && ["never", "untrusted"].includes(value)
        && this.resumeSessionId && value === this.config.permissionMode) continue;
      if (!option.values.some((item) => item.value === value)) {
        throw new Error(`Codex ${id} 不合法：${value}`);
      }
    }
  }
}

interface ApplyingConfig {
  fields: ConfigOptionId[];
  config: SessionConfig;
  clearModel: boolean;
  clearEffort: boolean;
}
