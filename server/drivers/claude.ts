import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  SessionConfig,
  UnifiedCommand,
  UserMessageInput,
} from "../types.js";
import { BaseDriver, parseJsonLine, readMentionText, userMessageText, withTimeout } from "./base.js";

interface ClaudePermission {
  protocolRequestId: string;
  input: unknown;
}

interface PendingConfigRequest {
  mode: string;
  resolve(config: SessionConfig): void;
  reject(error: Error): void;
}

interface PendingCommandRequest {
  resolve(commands: UnifiedCommand[]): void;
  reject(error: Error): void;
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
      mutable: false,
    },
    {
      id: "effort",
      name: "推理强度",
      values: [
        { value: null, label: "跟随 Claude 配置" },
        ...["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
      ],
      default: null,
      mutable: false,
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

export class ClaudeDriver extends BaseDriver {
  readonly kind = "claude" as const;
  private readonly pendingPermissions = new Map<string, ClaudePermission>();
  private readonly pendingConfigRequests = new Map<string, PendingConfigRequest>();
  private readonly pendingCommandRequests = new Map<string, PendingCommandRequest>();
  private readonly toolBlocks = new Map<number, { id: string; name: string; partialInput: string }>();
  private commands: UnifiedCommand[] = [];
  private refreshingCommands?: Promise<void>;

  async start(): Promise<void> {
    this.config = {
      model: this.config.model ?? null,
      effort: this.config.effort ?? null,
      permissionMode: this.config.permissionMode ?? "manual",
    };
    this.validateConfig(this.config);
    const permissionMode = this.config.permissionMode!;
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-mode", permissionMode,
      "--permission-prompt-tool", "stdio",
    ];
    if (this.resumeSessionId) args.push("--resume", this.resumeSessionId);
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.effort) args.push("--effort", this.config.effort);
    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    this.spawnProcess("claude", args, { env });
    try {
      await this.refreshCommands();
    } catch (error) {
      this.callbacks.emit("raw_event", {
        source: "claude",
        warning: `无法枚举 Claude 命令：${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.callbacks.metadata({ config: { ...this.config } });
    this.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return CLAUDE_CONFIG_SCHEMA;
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    if (config.model !== undefined || config.effort !== undefined) {
      throw new Error("Claude 的 model 与 effort 只能在建会话时设置");
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
    const text = userMessageText(message);
    if (text) content.push({ type: "text", text });
    for (const mention of message.mentions ?? []) {
      content.push({
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: readMentionText(mention),
        },
        title: mention.name ?? basename(mention.path),
      });
    }
    this.callbacks.status("running");
    this.send({
      type: "user",
      message: { role: "user", content },
    });
  }

  async resolvePermission(requestId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Claude permission_request 不存在：${requestId}`);
    const allow = decision === "allow" || decision === "always";
    const response: Record<string, unknown> = allow
      ? { behavior: "allow", updatedInput: updatedInput ?? pending.input }
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
      if (typeof message.model === "string") this.config.model = message.model;
      if (typeof message.effort === "string") this.config.effort = message.effort;
      if (typeof message.permissionMode === "string") {
        this.config.permissionMode = message.permissionMode === "default" ? "manual" : message.permissionMode;
      }
      this.callbacks.metadata({
        nativeSessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        config: { ...this.config },
      });
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

    if (message.type === "control_response") {
      const requestId = String(message.response?.request_id ?? "");
      const pending = this.pendingConfigRequests.get(requestId);
      if (pending) {
        this.pendingConfigRequests.delete(requestId);
        if (message.response?.subtype === "success") {
          const responseMode = String(message.response?.response?.mode ?? pending.mode);
          this.config.permissionMode = responseMode === "default" ? "manual" : responseMode;
          const current = { ...this.config };
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
          const commands = this.normalizeCommands(message.response?.response?.commands);
          pendingCommands.resolve(commands);
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
        input: message.request.input,
      });
      this.callbacks.emit("permission_request", {
        requestId,
        gate: "control_request",
        toolName: message.request.tool_name,
        displayName: message.request.display_name,
        description: message.request.description,
        toolCallId: message.request.tool_use_id,
        input: message.request.input,
        permissionSuggestions: message.request.permission_suggestions ?? [],
      });
      return;
    }

    if (message.type === "stream_event") {
      this.handleStreamEvent(message.event ?? {});
      return;
    }

    if (message.type === "user" && Array.isArray(message.message?.content)) {
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
      const result = new Promise<UnifiedCommand[]>((resolve, reject) => {
        this.pendingCommandRequests.set(requestId, { resolve, reject });
        this.send({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        });
      });
      try {
        this.updateCommands(await withTimeout(result, 15_000, "Claude command initialize"));
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
