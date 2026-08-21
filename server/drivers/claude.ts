import { randomUUID } from "node:crypto";
import type { DriverOptions, PermissionDecision } from "../types.js";
import { BaseDriver, parseJsonLine } from "./base.js";

interface ClaudePermission {
  protocolRequestId: string;
  input: unknown;
}

export class ClaudeDriver extends BaseDriver {
  readonly kind = "claude" as const;
  private readonly pendingPermissions = new Map<string, ClaudePermission>();
  private readonly toolBlocks = new Map<number, { id: string; name: string; partialInput: string }>();

  async start(): Promise<void> {
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-mode", "manual",
      "--permission-prompt-tool", "stdio",
    ];
    if (this.resumeSessionId) args.push("--resume", this.resumeSessionId);
    if (this.model) args.push("--model", this.model);
    const env = { ...process.env };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    this.spawnProcess("claude", args, { env });
    this.callbacks.status("idle");
  }

  async sendUserMessage(text: string): Promise<void> {
    this.callbacks.status("running");
    this.send({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
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
}
