import { readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, join } from "node:path";
import { lstat, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { kimiHistoryRoot } from "../history.js";
import { pathToFileURL } from "node:url";
import type {
  ConfigOptionId,
  DriverConfigSchema,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  UnifiedCommand,
  UserMessageInput,
  SendUserMessageOptions,
  SendUserMessageReceipt,
} from "../types.js";
import { BaseDriver, errorMessage, mentionFallbackNote, parseJsonLine, tryReadMentionText, userMessageText, withTimeout } from "./base.js";
import { StdioRpcProbe } from "./rpc-probe.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
}

interface KimiPermission {
  rpcId: string | number;
  method: "session/request_permission" | "terminal/create" | "fs/write_text_file" | "elicitation/create";
  params: Record<string, any>;
  questions?: KimiFormQuestion[];
}

interface KimiFormQuestion {
  key: string;
  question: string;
  options: Array<{ label: string; value: string; description?: string }>;
  multiSelect: boolean;
  header?: string;
}

const KIMI_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  elicitation: { form: {} },
};

interface TerminalEventOutputState {
  eventTail: Buffer;
  eventTruncated: boolean;
  exitCode?: number;
  signal?: string;
}

interface TerminalState extends TerminalEventOutputState {
  process: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  done: Promise<void>;
}

const TERMINAL_EVENT_OUTPUT_BYTES = 64 * 1024;
const RELEASED_TERMINAL_LIMIT = 64;

function appendKimiTerminalTail(state: Pick<TerminalState, "eventTail" | "eventTruncated">, chunk: Buffer): void {
  const combined = Buffer.concat([state.eventTail, chunk]);
  let start = Math.max(0, combined.length - TERMINAL_EVENT_OUTPUT_BYTES);
  if (start > 0) {
    while (start < combined.length && (combined[start] & 0xc0) === 0x80) start++;
    state.eventTruncated = true;
  }
  state.eventTail = combined.subarray(start);
}

export function collectKimiTerminalChunk(
  state: Pick<TerminalState, "output" | "truncated" | "eventTail" | "eventTruncated">,
  chunk: Buffer,
  outputLimit: number,
): void {
  appendKimiTerminalTail(state, chunk);
  // ACP terminal/output keeps its existing head-of-output limit.
  const remaining = outputLimit - Buffer.byteLength(state.output);
  if (remaining <= 0) {
    state.truncated = true;
    state.eventTruncated = true;
    return;
  }
  const slice = chunk.subarray(0, remaining);
  state.output += slice.toString("utf8");
  if (slice.length < chunk.length) {
    state.truncated = true;
    state.eventTruncated = true;
  }
}

function terminalOutputForEvent(
  content: unknown,
  lookup: (terminalId: string) => TerminalEventOutputState | undefined,
): { terminalId: string; output: string; truncated: boolean; exitCode: number | null; signal: string | null } | undefined {
  if (!Array.isArray(content)) return undefined;
  const terminalId = content.find((item) => item?.type === "terminal" && typeof item.terminalId === "string")?.terminalId;
  if (terminalId === undefined) return undefined;
  const state = lookup(terminalId);
  if (!state) return undefined;
  const bytes = state.eventTail;
  let end = bytes.length;
  if (end > 0) {
    let last = end - 1;
    while (last > 0 && (bytes[last] & 0xc0) === 0x80) last--;
    const lead = bytes[last];
    const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
    if (end - last < width) end = last;
  }
  return {
    terminalId,
    output: bytes.subarray(0, end).toString("utf8"),
    truncated: state.eventTruncated || end < bytes.length,
    exitCode: state.exitCode ?? null,
    signal: state.signal ?? null,
  };
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

/** Delete only the returned probe session after proving identity and absence of conversation. */
export async function cleanupKimiProbeSession(sessionId: string, root = kimiHistoryRoot()): Promise<boolean> {
  const warn = (reason: unknown) => console.warn(`[kimi probe] 保留 ${sessionId}：${String(reason)}`);
  if (!/^session_[\w-]+$/u.test(sessionId)) { warn("无效 sessionId"); return false; }
  try {
    const canonicalRoot = await realpath(root);
    const matches: string[] = [];
    for (const workspace of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const directory = join(canonicalRoot, workspace.name, sessionId);
      try {
        if ((await lstat(directory)).isDirectory() && await realpath(directory) === directory) matches.push(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (matches.length !== 1) { warn(`匹配目录数量 ${matches.length}`); return false; }
    const directory = matches[0]!;
    const statePath = join(directory, "state.json");
    const wirePath = join(directory, "agents", "main", "wire.jsonl");
    if (await realpath(statePath) !== statePath || await realpath(wirePath) !== wirePath) {
      warn("状态或 wire 路径含软链"); return false;
    }
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state?.id !== sessionId) { warn("state.id 不匹配"); return false; }
    const allowed = new Set(["metadata", "permission.set_mode", "profile.bind", "runtime.set_binding"]);
    const wire = await readFile(wirePath, "utf8");
    for (const line of wire.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      if (!allowed.has(JSON.parse(line)?.type)) { warn("wire 含对话或非探测记录"); return false; }
    }
    await rm(directory, { recursive: true });
    const dirty = join(canonicalRoot, ".index-dirty");
    try {
      if (await realpath(dirty) !== dirty) throw new Error("index-dirty 含软链");
      for (const marker of await readdir(dirty, { withFileTypes: true })) {
        if (marker.isFile() && marker.name.startsWith(sessionId)) await unlink(join(dirty, marker.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(error);
    }
    return true;
  } catch (error) { warn(error); return false; }
}

export async function probeKimiConfigSchema(cwd: string): Promise<DriverConfigSchema> {
  const probe = new StdioRpcProbe("kimi", ["acp"], cwd);
  let sessionId = "";
  try {
    await probe.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: KIMI_CLIENT_CAPABILITIES,
      clientInfo: { name: "workbench-meta", title: "Workbench metadata probe", version: "0.1.0" },
    });
    const result = await probe.request("session/new", { cwd, mcpServers: [] });
    sessionId = String(result?.sessionId ?? "");
    return kimiConfigSchemaFromOptions(Array.isArray(result?.configOptions) ? result.configOptions : []);
  } finally {
    if (sessionId) {
      try { await probe.request("session/close", { sessionId }, 1_000); } catch { /* probe shutdown remains authoritative */ }
    }
    try { await probe.close(); }
    finally { if (sessionId) await cleanupKimiProbeSession(sessionId); }
  }
}

export class KimiDriver extends BaseDriver {
  readonly kind = "kimi" as const;
  private rpcId = 1_000;
  private readonly rpc = new Map<number, PendingRpc>();
  private readonly permissions = new Map<string, KimiPermission>();
  private readonly terminals = new Map<string, TerminalState>();
  private readonly releasedTerminals = new Map<string, TerminalEventOutputState>();
  private nativeSessionId = "";
  private terminalCounter = 0;
  private configOptions: AcpConfigOption[] = [];
  private promptActive = false;
  private readonly queuedPrompts: Record<string, unknown>[][] = [];

  async start(): Promise<void> {
    this.spawnProcess("kimi", ["acp"]);
    await withTimeout(this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: KIMI_CLIENT_CAPABILITIES,
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

  async sendUserMessage(message: UserMessageInput, options?: SendUserMessageOptions): Promise<void | SendUserMessageReceipt> {
    if (!this.nativeSessionId) throw new Error("Kimi session 尚未就绪");
    const prompt: Record<string, unknown>[] = [];
    let text = userMessageText(message);
    const fallbackNotes: string[] = [];
    const attachments: Record<string, unknown>[] = [];
    for (const mention of message.mentions ?? []) {
      if (mention.type === "image") {
        attachments.push({
          type: "image",
          mimeType: mention.mimeType,
          data: readFileSync(mention.path).toString("base64"),
        });
        continue;
      }
      const mentionText = tryReadMentionText(mention);
      if (mentionText === null) {
        fallbackNotes.push(mentionFallbackNote(mention.path));
        continue;
      }
      attachments.push({
        type: "resource",
        resource: {
          uri: pathToFileURL(mention.path).href,
          mimeType: "text/plain",
          text: mentionText,
          _meta: { name: mention.name ?? basename(mention.path) },
        },
      });
    }
    if (fallbackNotes.length > 0) {
      text = `${text ? `${text}\n` : ""}${fallbackNotes.join("\n")}`;
    }
    if (text) prompt.push({ type: "text", text });
    prompt.push(...attachments);
    if (options?.steer) {
      if (!this.promptActive) throw new Error("Kimi 当前回合已结束，请重发消息");
      this.queuedPrompts.push(prompt);
      return { queued: true };
    }
    this.startPrompt(prompt);
  }

  private startPrompt(prompt: Record<string, unknown>[]): void {
    this.promptActive = true;
    this.callbacks.status("running");
    void this.request("session/prompt", {
      sessionId: this.nativeSessionId,
      prompt,
    }).then((result) => {
      this.promptActive = false;
      this.callbacks.emit("turn_completed", {
        stopReason: result?.stopReason,
        result,
      });
      const next = this.queuedPrompts.shift();
      if (next) this.startPrompt(next);
      else this.callbacks.status("idle");
    }).catch((error) => {
      this.promptActive = false;
      this.cancelQueuedPrompts("当前回合失败");
      this.callbacks.emit("session_error", { message: errorMessage(error), source: "session/prompt" });
      this.callbacks.status("error");
    });
  }

  private cancelQueuedPrompts(reason: string): void {
    const count = this.queuedPrompts.length;
    this.queuedPrompts.length = 0;
    if (count) this.callbacks.emit("session_error", {
      source: "steer_queue", message: `Kimi 的 ${count} 条排队消息已取消：${reason}`,
    });
  }

  async resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`Kimi permission_request 不存在：${requestId}`);
    if (pending.method === "elicitation/create") {
      if (updatedInput !== undefined) throw new Error("Kimi 提问不接受 updatedInput");
      if (decision === "deny") {
        this.replyResult(pending.rpcId, { action: "decline" });
      } else {
        const questions = pending.questions ?? [];
        if (!questionAnswers || Object.keys(questionAnswers).length !== questions.length) {
          throw new Error("Kimi 提问必须回答全部问题");
        }
        const content: Record<string, string | string[]> = Object.create(null);
        for (const question of questions) {
          if (!Object.hasOwn(questionAnswers, question.question)) {
            throw new Error(`Kimi 提问缺少答案：${question.question}`);
          }
          const answer = questionAnswers[question.question]!.trim();
          const exact = question.options.find((option) => option.label === answer);
          const labels = exact ? [answer] : answer.split(",").map((label) => label.trim());
          if (!question.multiSelect && labels.length !== 1) throw new Error(`Kimi 提问只允许单选：${question.question}`);
          if (new Set(labels).size !== labels.length || labels.some((label) => !question.options.some((o) => o.label === label))) {
            throw new Error(`Kimi 提问只接受列出的选项，不支持「其他」：${question.question}`);
          }
          const values = question.options.filter((option) => labels.includes(option.label)).map((option) => option.value);
          content[question.key] = question.multiSelect ? values : values[0]!;
        }
        this.replyResult(pending.rpcId, { action: "accept", content });
      }
    } else if (pending.method === "session/request_permission") {
      if (questionAnswers !== undefined) throw new Error("Kimi 普通审批不接受 questionAnswers");
      this.resolveStandardPermission(pending, decision);
    } else if (pending.method === "terminal/create") {
      if (questionAnswers !== undefined) throw new Error("Kimi 最终闸门不接受 questionAnswers");
      this.resolveTerminalGate(pending, decision, updatedInput);
    } else {
      if (questionAnswers !== undefined) throw new Error("Kimi 最终闸门不接受 questionAnswers");
      this.resolveWriteGate(pending, decision, updatedInput);
    }
    this.permissions.delete(requestId);
  }

  async interrupt(): Promise<void> {
    this.cancelQueuedPrompts("用户停止了执行");
    this.cancelElicitations();
    if (!this.nativeSessionId) return;
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.nativeSessionId } });
  }

  async stop(): Promise<void> {
    this.cancelQueuedPrompts("worker 已停止");
    this.cancelElicitations();
    for (const terminal of this.terminals.values()) {
      if (terminal.process.exitCode === null && terminal.process.signalCode === null) terminal.process.kill("SIGTERM");
    }
    if (this.nativeSessionId && this.child?.stdin.writable) {
      try {
        await withTimeout(this.request("session/close", { sessionId: this.nativeSessionId }), 1_000, "Kimi session/close");
      } catch { /* process shutdown remains authoritative */ }
    }
    await super.stop();
    this.releasedTerminals.clear();
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
    if (method === "elicitation/create") {
      this.queueElicitation(message);
      return;
    }
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

  private queueElicitation(message: Record<string, any>): void {
    const params = message.params ?? {};
    if (params.mode !== undefined && params.mode !== "form") {
      this.replyResult(message.id, { action: "cancel" });
      return;
    }
    const properties = params.requestedSchema?.properties;
    const entries = properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties) : [];
    const texts = typeof params.message === "string" ? params.message.split("\n") : [];
    const questions: KimiFormQuestion[] = entries.map(([key, raw], index) => {
      const schema = raw && typeof raw === "object" ? raw as Record<string, any> : {};
      const choices = schema.type === "array" ? schema.items?.anyOf : schema.oneOf;
      const legacy = schema.type === "string" && Array.isArray(schema.enum)
        ? schema.enum.map((value: string, i: number) => ({ const: value, title: schema.enumNames?.[i] ?? value }))
        : [];
      const rawOptions = Array.isArray(choices) ? choices : legacy;
      return {
        key,
        question: texts[index] ?? "",
        ...(typeof schema.title === "string" ? { header: schema.title } : {}),
        multiSelect: schema.type === "array",
        options: rawOptions.map((option: any) => ({
          label: option?.title, value: option?.const,
          ...(typeof option?.description === "string" ? { description: option.description } : {}),
        })),
      };
    });
    const valid = entries.length > 0 && entries.length <= 4 && texts.length === entries.length
      && questions.every((q) => q.question && q.options.length > 0
        && q.options.every((o) => typeof o.label === "string" && o.label && typeof o.value === "string")
        && (!q.multiSelect || q.options.every((o) => !o.label.includes(",")))
        && new Set(q.options.map((o) => o.label)).size === q.options.length)
      && new Set(questions.map((q) => q.question)).size === questions.length
      && entries.every(([, raw], i) => {
        const schema = raw && typeof raw === "object" ? raw as Record<string, any> : {};
        return schema.type === "string" || (schema.type === "array" && schema.items?.anyOf
          && (schema.minItems === undefined || schema.minItems <= 1)
          && (schema.maxItems === undefined || schema.maxItems >= questions[i].options.length));
      });
    if (!valid) {
      this.replyResult(message.id, { action: "cancel" });
      this.callbacks.emit("raw_event", { source: "kimi", method: message.method,
        warning: "elicitation 表单包含前端无法表达的字段，已按取消处理" });
      return;
    }
    const requestId = `kimi:elicitation:${String(message.id)}`;
    this.permissions.set(requestId, { rpcId: message.id, method: "elicitation/create", params, questions });
    this.callbacks.emit("permission_request", {
      requestId, gate: message.method, toolName: "AskUserQuestion",
      interactionType: "ask_user_question", questionProtocol: "kimi_acp_elicitation_form_v1",
      questions: questions.map((q) => ({ question: q.question, header: q.header,
        options: q.options.map(({ label, description }) => ({ label, description })), multiSelect: q.multiSelect })),
      otherSupported: false,
      protocolLimitations: ["Kimi AskUserQuestion 的 form 桥接不接收「其他」自由文本"],
    });
  }

  protected handleProcessExit(): void {
    this.promptActive = false;
    this.cancelQueuedPrompts("worker 已退出");
    this.permissions.clear();
    this.rpc.clear();
    this.releasedTerminals.clear();
  }

  private cancelElicitations(): void {
    for (const [requestId, pending] of this.permissions) {
      if (pending.method !== "elicitation/create") continue;
      if (this.child?.stdin.writable) this.replyResult(pending.rpcId, { action: "cancel" });
      this.permissions.delete(requestId);
    }
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
      eventTail: Buffer.alloc(0),
      eventTruncated: false,
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    const collect = (chunk: Buffer) => collectKimiTerminalChunk(state, chunk, outputLimit);
    processHandle.stdout.on("data", collect);
    processHandle.stderr.on("data", collect);
    processHandle.on("close", (code, signal) => {
      state.exitCode = code ?? undefined;
      state.signal = signal ?? undefined;
      finish();
    });
    processHandle.on("error", (error) => {
      state.output += error.message;
      appendKimiTerminalTail(state, Buffer.from(error.message));
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
    const terminalId = String(params.terminalId);
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      this.replyError(id, -32602, "unknown terminal");
      return;
    }
    this.releasedTerminals.set(terminalId, {
      eventTail: terminal.eventTail,
      eventTruncated: terminal.eventTruncated,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
    });
    if (this.releasedTerminals.size > RELEASED_TERMINAL_LIMIT) {
      this.releasedTerminals.delete(this.releasedTerminals.keys().next().value!);
    }
    this.terminals.delete(terminalId);
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
        ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
        ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
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
        ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
        ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
      };
      if (["completed", "failed"].includes(update.status)) {
        const terminalOutput = terminalOutputForEvent(update.content,
          (terminalId) => this.terminals.get(terminalId) ?? this.releasedTerminals.get(terminalId));
        this.callbacks.emit("tool_call_completed", {
          ...payload,
          isError: update.status === "failed",
          ...(terminalOutput ? { terminalOutput } : {}),
        });
      } else {
        this.callbacks.emit("tool_call_updated", payload);
      }
      return;
    }
    if (type === "usage_update") {
      this.callbacks.emit("usage_updated", { used: update.used, size: update.size });
      return;
    }
    if (type === "available_commands_update") {
      const commands = this.normalizeCommands(update.availableCommands);
      this.callbacks.commands(commands);
      return;
    }
    const quiet = new Set([
      "session_info_update",
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

  private normalizeCommands(value: unknown): UnifiedCommand[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((command): UnifiedCommand[] => {
      if (!command || typeof command !== "object") return [];
      const item = command as Record<string, any>;
      if (typeof item.name !== "string" || !item.name) return [];
      return [{
        name: item.name.replace(/^\/+/, ""),
        description: typeof item.description === "string" ? item.description : "",
        ...(typeof item.input?.hint === "string" && item.input.hint
          ? { argHint: item.input.hint }
          : {}),
        source: "kimi",
      }];
    });
  }
}
