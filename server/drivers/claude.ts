import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type {
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  UnifiedCommand,
  UserMessageInput,
} from "../types.js";
import { BaseDriver, mentionFallbackNote, parseJsonLine, tryReadMentionText, userMessageText, withTimeout } from "./base.js";
import { readClaudeEffectiveSettings } from "../claude-settings.js";
import type { RemoteControlState } from "../types.js";

interface ClaudePermission {
  protocolRequestId: string;
  toolName: string;
  input: unknown;
}

interface PendingConfigRequest {
  mode: string;
  resolve(config: SessionConfig): void;
  reject(error: Error): void;
}

interface PendingCommandRequest {
  resolve(response: unknown): void;
  reject(error: Error): void;
}

/** Stream-json replays local input and also carries synthetic CLI/user records. */
function isHumanRemoteUser(message: Record<string, any>, text: string): boolean {
  const records = [message, message.message].filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  );
  for (const record of records) {
    if (typeof record.parent_tool_use_id === "string" && record.parent_tool_use_id.trim()) return false;
    if (["isSynthetic", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isSidechain"]
      .some((key) => record[key] === true)) return false;
  }
  return !/^(?:Base directory for this skill:|<(?:command-(?:name|message|args)|local-command-(?:stdout|caveat)|system-reminder|skill(?:s_instructions|-instructions)?|task-notification|ide_(?:selection|opened_file))\b)/i
    .test(text.trimStart());
}

const CLAUDE_MODEL_FALLBACKS: Record<string, string> = {
  fable: "Fable（最新）",
  opus: "Opus（最新）",
  sonnet: "Sonnet（最新）",
  haiku: "Haiku（最新）",
};

/** Only the four selectable aliases are relabeled; protocol IDs remain unchanged. */
export function deriveClaudeModelLabels(models: unknown): Record<string, string> {
  if (!Array.isArray(models)) return {};
  const labels: Record<string, string> = {};
  let newestFable: number[] | undefined;
  const compareVersions = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = (a[i] ?? 0) - (b[i] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const item = model as Record<string, unknown>;
    const value = item.value;
    if (value === "default") continue;
    const alias = value === "opus" || value === "sonnet" || value === "haiku"
      ? value
      : value === "fable" || (typeof value === "string" && value.startsWith("claude-fable-"))
        || (typeof item.displayName === "string" && /^Fable(?: \d+(?:\.\d+)*)?$/.test(item.displayName))
        || (typeof item.resolvedModel === "string" && item.resolvedModel.startsWith("claude-fable-"))
        ? "fable"
        : undefined;
    if (!alias) continue;
    const name = alias[0].toUpperCase() + alias.slice(1);
    const displayMatch = typeof item.displayName === "string"
      ? item.displayName.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)*)$`))
      : null;
    const descriptionMatch = typeof item.description === "string"
      ? item.description.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)*)\\s*(?:·|$)`))
      : null;
    const version = (displayMatch ?? descriptionMatch)?.[1];
    if (!version) continue;
    if (alias === "fable") {
      const parts = version.split(".").map(Number);
      if (newestFable && compareVersions(parts, newestFable) <= 0) continue;
      newestFable = parts;
    }
    labels[alias] = `${name} ${version}`;
  }
  return labels;
}

export function updateClaudeModelLabels(models: unknown): void {
  const labels = deriveClaudeModelLabels(models);
  const option = CLAUDE_CONFIG_SCHEMA.options.find((item) => item.id === "model");
  for (const entry of option?.values ?? []) {
    if (entry.value && Object.hasOwn(CLAUDE_MODEL_FALLBACKS, entry.value)) {
      entry.label = labels[entry.value] ?? CLAUDE_MODEL_FALLBACKS[entry.value];
    }
  }
}

/** Startup probe sends only initialize, with no user turn. Failure leaves static labels intact. */
export async function probeClaudeModelLabels(cwd: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn("claude", [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--permission-prompt-tool", "stdio",
    ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const requestId = randomUUID();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve();
    };
    const timer = setTimeout(finish, 8_000);
    child.on("error", finish);
    child.on("close", finish);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = parseJsonLine(line);
      if (message?.type !== "control_response" || message.response?.request_id !== requestId) return;
      if (message.response?.subtype === "success") {
        updateClaudeModelLabels(message.response.response?.models);
      }
      finish();
    });
    child.stdin.on("error", finish);
    child.stdin.write(`${JSON.stringify({
      type: "control_request", request_id: requestId, request: { subtype: "initialize" },
    })}\n`);
  });
}

export const CLAUDE_CONFIG_SCHEMA: DriverConfigSchema = {
  source: "Claude Code CLI flags and stream-json control protocol",
  options: [
    {
      id: "model",
      name: "模型",
      values: [
        { value: null, label: "跟随 Claude 配置" },
        { value: "fable", label: "Fable（最新）" },
        { value: "opus", label: "Opus（最新）" },
        { value: "sonnet", label: "Sonnet（最新）" },
        { value: "haiku", label: "Haiku（最新）" },
      ],
      default: null,
      mutable: true,
      mutableVia: "restart",
    },
    {
      id: "effort",
      name: "推理强度",
      values: [
        { value: null, label: "跟随 Claude 配置" },
        ...["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
      ],
      default: null,
      mutable: true,
      mutableVia: "restart",
    },
    {
      id: "permissionMode",
      name: "审批模式",
      values: [
        { value: "manual", label: "Manual" },
        { value: "acceptEdits", label: "Accept Edits" },
        { value: "auto", label: "Auto" },
        { value: "plan", label: "Plan" },
        { value: "dontAsk", label: "Don't Ask" },
        { value: "bypassPermissions", label: "Bypass Permissions" },
      ],
      default: "manual",
      mutable: true,
    },
  ],
};

export function claudeLaunchArgs(config: SessionConfig, resumeSessionId?: string): string[] {
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-mode", config.permissionMode ?? "manual",
    "--permission-prompt-tool", "stdio",
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  return args;
}

export class ClaudeDriver extends BaseDriver {
  readonly kind = "claude" as const;
  private readonly pendingPermissions = new Map<string, ClaudePermission>();
  private readonly pendingConfigRequests = new Map<string, PendingConfigRequest>();
  private readonly pendingCommandRequests = new Map<string, PendingCommandRequest>();
  private readonly toolBlocks = new Map<number, { id: string; name: string; partialInput: string }>();
  private commands: UnifiedCommand[] = [];
  private refreshingCommands?: Promise<void>;
  private remoteControl: RemoteControlState = { status: "disconnected" };
  private remoteRequest?: { id: string; resolve: (state: RemoteControlState) => void; reject: (error: Error) => void };
  private readonly localUserEchoes: string[] = [];

  async start(): Promise<void> {
    this.config = {
      model: this.config.model ?? null,
      effort: this.config.effort ?? null,
      permissionMode: this.config.permissionMode ?? "manual",
    };
    this.validateConfig(this.config);
    const args = claudeLaunchArgs(this.config, this.resumeSessionId);
    const env = { ...process.env };
    env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
    // Same tool set as the VSCode extension, so a session resumed on either side sees identical tools.
    env.CLAUDE_CODE_ENABLE_TASKS = "0";
    env.MCP_CONNECTION_NONBLOCKING = "true";
    // Inherited when wb is started from a VSCode terminal; wb is not an IDE host.
    delete env.CLAUDE_CODE_SSE_PORT;
    // wb reloads from disk before sending (refreshBeforeSend), so the global fork-guard hook is redundant here.
    env.CC_FORK_GUARD = "0";
    this.spawnProcess("claude", args, { env });
    try {
      await this.refreshCommands();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.emit("raw_event", {
        source: "claude",
        warning: `无法枚举 Claude 命令：${message}`,
      });
      if (this.resumeSessionId) throw new Error(`Claude 续接 worker 初始化失败：${message}`);
    }
    this.callbacks.metadata({ config: { ...this.config } });
    this.callbacks.status("idle");
    if (readClaudeEffectiveSettings(this.cwd).remoteControlAtStartup) {
      void this.setRemoteControl(true).catch(() => undefined);
    }
  }

  async setRemoteControl(enabled: boolean): Promise<RemoteControlState> {
    if (this.remoteRequest) throw new Error("Remote Control 切换正在进行中");
    if (enabled && this.remoteControl.status === "connected") return this.remoteControl;
    if (!enabled && this.remoteControl.status === "disconnected") return this.remoteControl;
    this.updateRemoteControl({ status: enabled ? "connecting" : "disconnecting" });
    const id = randomUUID();
    const pending = new Promise<RemoteControlState>((resolve, reject) => {
      this.remoteRequest = { id, resolve, reject };
    });
    try {
      this.send({ type: "control_request", request_id: id, request: { subtype: "remote_control", enabled } });
      return await withTimeout(pending, 15_000, "Claude remote_control");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.updateRemoteControl({ status: "error", reason });
      throw error;
    } finally {
      this.remoteRequest = undefined;
    }
  }

  private updateRemoteControl(state: RemoteControlState): void {
    this.remoteControl = state;
    this.callbacks.metadata({ remoteControl: state });
  }

  getConfigSchema(): DriverConfigSchema {
    return CLAUDE_CONFIG_SCHEMA;
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    if (config.model !== undefined || config.effort !== undefined) {
      throw new Error("Claude 的 model 与 effort 由会话管理层重启 worker 后生效");
    }
    if (!config.permissionMode) throw new Error("Claude set_config 缺少 permissionMode");
    const option = CLAUDE_CONFIG_SCHEMA.options.find((item) => item.id === "permissionMode");
    if (!option?.values.some((item) => item.value === config.permissionMode)) {
      throw new Error(`Claude permissionMode 不合法：${config.permissionMode}`);
    }
    const requestId = randomUUID();
    const result = new Promise<SessionConfig>((resolve, reject) => {
      this.pendingConfigRequests.set(requestId, {
        mode: config.permissionMode!,
        resolve,
        reject,
      });
      const protocolMode = config.permissionMode === "manual" ? "default" : config.permissionMode;
      this.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_permission_mode", mode: protocolMode },
      });
    });
    try {
      return await withTimeout(result, 15_000, "Claude set_permission_mode");
    } finally {
      this.pendingConfigRequests.delete(requestId);
    }
  }

  async sendUserMessage(message: UserMessageInput): Promise<void> {
    const content: Record<string, unknown>[] = [];
    let text = userMessageText(message);
    const fallbackNotes: string[] = [];
    const attachments: Record<string, unknown>[] = [];
    for (const mention of message.mentions ?? []) {
      if (mention.type === "image") {
        attachments.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mention.mimeType,
            data: readFileSync(mention.path).toString("base64"),
          },
        });
        continue;
      }
      const mentionText = tryReadMentionText(mention);
      if (mentionText === null) {
        fallbackNotes.push(mentionFallbackNote(mention.path));
        continue;
      }
      attachments.push({
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: mentionText,
        },
        title: mention.name ?? basename(mention.path),
      });
    }
    if (fallbackNotes.length > 0) {
      text = `${text ? `${text}\n` : ""}${fallbackNotes.join("\n")}`;
    }
    if (text) content.push({ type: "text", text });
    content.push(...attachments);
    this.callbacks.status("running");
    if (text) {
      this.localUserEchoes.push(text);
      if (this.localUserEchoes.length > 20) this.localUserEchoes.shift();
    }
    this.send({
      type: "user",
      message: { role: "user", content },
    });
  }

  async resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Claude permission_request 不存在：${requestId}`);
    const allow = decision === "allow" || decision === "always";
    let resolvedInput = updatedInput ?? pending.input;
    if (questionAnswers !== undefined) {
      if (!allow) throw new Error("Claude questionAnswers 只能与 allow 或 always 一起发送");
      if (pending.toolName !== "AskUserQuestion") {
        throw new Error(`Claude ${pending.toolName} 不接受 questionAnswers`);
      }
      if (!pending.input || typeof pending.input !== "object" || Array.isArray(pending.input)) {
        throw new Error("Claude AskUserQuestion 入参不是 JSON 对象");
      }
      const input = pending.input as Record<string, unknown>;
      if (!Array.isArray(input.questions)) throw new Error("Claude AskUserQuestion 入参缺少 questions");
      const questionTexts = new Set(input.questions.flatMap((question): string[] => {
        if (!question || typeof question !== "object") return [];
        const text = (question as Record<string, unknown>).question;
        return typeof text === "string" ? [text] : [];
      }));
      for (const question of Object.keys(questionAnswers)) {
        if (!questionTexts.has(question)) {
          throw new Error(`questionAnswers 的 key 必须逐字匹配问题文本：${question}`);
        }
      }
      resolvedInput = { ...input, answers: questionAnswers };
    }
    const response: Record<string, unknown> = allow
      ? { behavior: "allow", updatedInput: resolvedInput }
      : { behavior: "deny", message: "用户拒绝了此操作" };
    this.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: pending.protocolRequestId,
        response,
      },
    });
    this.pendingPermissions.delete(requestId);
  }

  async interrupt(): Promise<void> {
    this.send({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
  }

  protected handleStdoutLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      this.callbacks.emit("raw_event", { source: "stdout", raw: line });
      return;
    }
    if (typeof message.session_id === "string") {
      this.callbacks.metadata({ nativeSessionId: message.session_id });
    }

    if (message.type === "system" && message.subtype === "init") {
      const effectiveConfig = {
        ...(typeof message.model === "string"
          ? { model: { value: message.model, source: "init" as const } }
          : {}),
        ...(typeof message.effort === "string"
          ? { effort: { value: message.effort, source: "init" as const } }
          : {}),
      };
      if (typeof message.permissionMode === "string") {
        this.config.permissionMode = message.permissionMode === "default" ? "manual" : message.permissionMode;
      }
      this.callbacks.metadata({
        nativeSessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        config: { permissionMode: this.config.permissionMode },
        effectiveConfig,
      });
      if (Object.keys(effectiveConfig).length > 0) {
        this.callbacks.emit("config_updated", {
          effectiveFrom: "current_turn",
          reportedBy: "system/init",
        });
      }
      if (this.commands.length === 0 && Array.isArray(message.slash_commands)) {
        this.updateCommands(message.slash_commands.map((name: unknown) => ({ name })));
      }
      return;
    }

    if (message.type === "system" && message.subtype === "commands_changed") {
      void this.refreshCommands().catch((error) => this.callbacks.emit("raw_event", {
        source: "claude",
        warning: `Claude 命令表刷新失败：${error instanceof Error ? error.message : String(error)}`,
      }));
      return;
    }

    if (message.type === "system" && message.subtype === "bridge_state") {
      const state = String(message.state ?? "unknown");
      if (state === "failed" && ["connecting", "connected", "reconnecting"].includes(this.remoteControl.status)) {
        const reason = String(message.error ?? "Remote Control bridge 连接失败");
        this.remoteRequest?.reject(new Error(reason));
        this.remoteRequest = undefined;
        this.updateRemoteControl({ status: "error", reason });
      } else if (state === "connected") {
        if (this.remoteControl.sessionUrl) this.updateRemoteControl({ status: "connected", sessionUrl: this.remoteControl.sessionUrl });
      } else if (this.remoteControl.status === "connected" || this.remoteControl.status === "reconnecting") {
        this.updateRemoteControl({ status: "reconnecting", reason: `bridge_state: ${state}`, sessionUrl: this.remoteControl.sessionUrl });
      } else if (state !== "ready" && this.remoteControl.status === "connecting") {
        this.updateRemoteControl({ status: "connecting", reason: `bridge_state: ${state}` });
      }
      return;
    }

    if (message.type === "control_response") {
      const requestId = String(message.response?.request_id ?? "");
      if (this.remoteRequest?.id === requestId) {
        const pending = this.remoteRequest;
        this.remoteRequest = undefined;
        if (message.response?.subtype !== "success") {
          pending.reject(new Error(String(message.response?.error ?? "Claude remote_control 失败")));
        } else {
          const url = message.response?.response?.session_url;
          const state: RemoteControlState = url
            ? { status: "connected", sessionUrl: String(url) }
            : { status: "disconnected" };
          if (this.remoteControl.status === "connecting" && !url) {
            pending.reject(new Error("Remote Control 已开启但未返回 session_url"));
          } else {
            this.updateRemoteControl(state);
            pending.resolve(state);
          }
        }
        return;
      }
      const pending = this.pendingConfigRequests.get(requestId);
      if (pending) {
        this.pendingConfigRequests.delete(requestId);
        if (message.response?.subtype === "success") {
          const responseMode = String(message.response?.response?.mode ?? pending.mode);
          this.config.permissionMode = responseMode === "default" ? "manual" : responseMode;
          const current = { permissionMode: this.config.permissionMode };
          this.callbacks.metadata({ config: current });
          pending.resolve(current);
        } else {
          pending.reject(new Error(message.response?.error ?? "Claude set_permission_mode 失败"));
        }
        return;
      }
      const pendingCommands = this.pendingCommandRequests.get(requestId);
      if (pendingCommands) {
        this.pendingCommandRequests.delete(requestId);
        if (message.response?.subtype === "success") {
          pendingCommands.resolve(message.response?.response);
        } else {
          pendingCommands.reject(new Error(message.response?.error ?? "Claude initialize control_request 失败"));
        }
        return;
      }
    }

    if (message.type === "control_request" && message.request?.subtype === "can_use_tool") {
      const requestId = String(message.request_id);
      this.pendingPermissions.set(requestId, {
        protocolRequestId: requestId,
        toolName: String(message.request.tool_name ?? ""),
        input: message.request.input,
      });
      const isUserQuestion = message.request.tool_name === "AskUserQuestion"
        && message.request.input
        && typeof message.request.input === "object"
        && Array.isArray(message.request.input.questions);
      this.callbacks.emit("permission_request", {
        requestId,
        gate: "control_request",
        toolName: message.request.tool_name,
        displayName: message.request.display_name,
        description: message.request.description,
        toolCallId: message.request.tool_use_id,
        input: message.request.input,
        permissionSuggestions: message.request.permission_suggestions ?? [],
        ...(isUserQuestion ? {
          interactionType: "ask_user_question",
          questionProtocol: "claude_updated_input_answers_v1",
          questions: message.request.input.questions,
        } : {}),
      });
      return;
    }

    if (message.type === "control_request") {
      this.send({ type: "control_response", response: {
        subtype: "error", request_id: message.request_id,
        error: `不支持的 Claude control_request: ${String(message.request?.subtype ?? "unknown")}`,
      } });
      return;
    }

    if (message.type === "stream_event") {
      this.handleStreamEvent(message.event ?? {});
      return;
    }

    if (message.type === "user" && Array.isArray(message.message?.content)) {
      const userText = message.message.content.filter((item: Record<string, unknown>) => item?.type === "text" && typeof item.text === "string")
        .map((item: Record<string, unknown>) => item.text as string).join("\n");
      if (userText && isHumanRemoteUser(message, userText)) {
        const index = this.localUserEchoes.indexOf(userText);
        if (index >= 0) this.localUserEchoes.splice(index, 1);
        else if (["connected", "reconnecting", "connecting"].includes(this.remoteControl.status)) {
          this.callbacks.emit("user_message", { text: userText, source: "remote_control" });
          this.callbacks.status("running");
        }
      }
      for (const content of message.message.content) {
        if (content?.type === "tool_result") {
          this.callbacks.emit("tool_call_completed", {
            toolCallId: content.tool_use_id,
            result: content.content,
            isError: Boolean(content.is_error),
          });
        }
      }
      return;
    }

    if (message.type === "result") {
      if (message.usage || message.modelUsage) {
        this.callbacks.emit("usage_updated", {
          usage: message.usage ?? {},
          modelUsage: message.modelUsage ?? {},
          costUsd: message.total_cost_usd,
        });
      }
      this.callbacks.emit("turn_completed", {
        subtype: message.subtype,
        result: message.result,
        isError: Boolean(message.is_error),
        stopReason: message.stop_reason,
      });
      this.callbacks.status(message.is_error ? "error" : "idle");
      return;
    }

    const known = new Set(["system", "assistant", "rate_limit_event", "control_response"]);
    if (!known.has(String(message.type))) {
      this.callbacks.emit("raw_event", { source: "claude", raw: message });
    }
  }

  private handleStreamEvent(event: Record<string, any>): void {
    const index = Number(event.index ?? -1);
    if (event.type === "content_block_start") {
      const block = event.content_block ?? {};
      if (block.type === "tool_use") {
        this.toolBlocks.set(index, { id: block.id, name: block.name, partialInput: "" });
        this.callbacks.emit("tool_call_started", {
          toolCallId: block.id,
          toolName: block.name,
          input: block.input ?? {},
        });
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {};
      if (delta.type === "text_delta") {
        this.callbacks.emit("agent_text_delta", { text: delta.text ?? "" });
      } else if (delta.type === "thinking_delta") {
        this.callbacks.emit("thought_delta", { text: delta.thinking ?? "" });
      } else if (delta.type === "input_json_delta") {
        const tool = this.toolBlocks.get(index);
        if (tool) {
          tool.partialInput += delta.partial_json ?? "";
          this.callbacks.emit("tool_call_updated", {
            toolCallId: tool.id,
            partialInput: tool.partialInput,
          });
        }
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const tool = this.toolBlocks.get(index);
      if (tool) {
        let input: unknown = tool.partialInput;
        try { input = JSON.parse(tool.partialInput); } catch { /* partial input remains readable text */ }
        this.callbacks.emit("tool_call_updated", { toolCallId: tool.id, input, inputComplete: true });
        this.toolBlocks.delete(index);
      }
    }
  }

  private validateConfig(config: SessionConfig): void {
    for (const [id, value] of Object.entries(config)) {
      if (value === undefined) continue;
      const option = CLAUDE_CONFIG_SCHEMA.options.find((item) => item.id === id);
      if (!option?.values.some((item) => item.value === value)) {
        throw new Error(`Claude ${id} 不合法：${value}`);
      }
    }
  }

  private async refreshCommands(): Promise<void> {
    if (this.refreshingCommands) return await this.refreshingCommands;
    this.refreshingCommands = (async () => {
      const requestId = randomUUID();
      const result = new Promise<unknown>((resolve, reject) => {
        this.pendingCommandRequests.set(requestId, { resolve, reject });
        this.send({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        });
      });
      try {
        const response = await withTimeout(result, 15_000, "Claude command initialize") as Record<string, unknown> | undefined;
        updateClaudeModelLabels(response?.models);
        this.updateCommands(response?.commands);
      } finally {
        this.pendingCommandRequests.delete(requestId);
      }
    })();
    try {
      await this.refreshingCommands;
    } finally {
      this.refreshingCommands = undefined;
    }
  }

  private normalizeCommands(value: unknown): UnifiedCommand[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((command): UnifiedCommand[] => {
      if (!command || typeof command !== "object") return [];
      const item = command as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name) return [];
      return [{
        name: item.name.replace(/^\/+/, ""),
        description: typeof item.description === "string" ? item.description : "",
        ...(typeof item.argumentHint === "string" && item.argumentHint
          ? { argHint: item.argumentHint }
          : {}),
        source: "claude",
      }];
    });
  }

  private updateCommands(value: unknown): void {
    const commands = this.normalizeCommands(value);
    this.commands = commands;
    this.callbacks.commands(commands);
  }
}
