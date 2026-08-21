import type { DriverOptions, PermissionDecision } from "../types.js";
import { BaseDriver, errorMessage, parseJsonLine, withTimeout } from "./base.js";

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

export class CodexDriver extends BaseDriver {
  readonly kind = "codex" as const;
  private rpcId = 1_000;
  private readonly rpc = new Map<number, PendingRpc>();
  private readonly permissions = new Map<string, CodexPermission>();
  private threadId = "";
  private turnId = "";

  async start(): Promise<void> {
    this.spawnProcess("codex", ["app-server", "--stdio"]);
    const initialized = await withTimeout(this.request("initialize", {
      clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
      capabilities: null,
    }), 15_000, "Codex initialize");
    if (!initialized) throw new Error("Codex initialize 未返回 result");
    this.notify("initialized", {});
    const result = this.resumeSessionId
      ? await withTimeout(this.request("thread/resume", { threadId: this.resumeSessionId, cwd: this.cwd }), 15_000, "Codex thread/resume")
      : await withTimeout(this.request("thread/start", {
        cwd: this.cwd,
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        ephemeral: false,
        serviceName: "workbench",
      }), 15_000, "Codex thread/start");
    this.threadId = result?.thread?.id ?? result?.id ?? this.resumeSessionId ?? "";
    if (!this.threadId) throw new Error("Codex 未返回 thread id");
    this.callbacks.metadata({
      nativeSessionId: this.threadId,
      nativeTranscriptPath: result?.thread?.path,
    });
    this.callbacks.status("idle");
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread 尚未就绪");
    this.callbacks.status("running");
    this.turnId = "";
    void this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
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
}
