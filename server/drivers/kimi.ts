import { proxyEnvironment } from "../proxy-env.js";
import { createReadStream, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, join } from "node:path";
import { lstat, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { kimiHistoryRoot } from "../history.js";
import { pathToFileURL } from "node:url";
import type {
  BackgroundTask,
  ConfigOptionId,
  DriverOptions,
  DriverConfigSchema,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  UnifiedCommand,
  UserMessageInput,
  SendUserMessageOptions,
  SendUserMessageReceipt,
  WorkerProcessIdentity,
} from "../types.js";
import { BaseDriver, captureProcessGroup, stopChildProcess, POSIX_PROCESS_GROUPS, errorMessage, mentionFallbackNote, parseJsonLine, tryReadMentionText, userMessageText, withTimeout } from "./base.js";
import { log } from "../logger.js";
import { StdioRpcProbe } from "./rpc-probe.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
  /** 可选同步完成钩子：按 stdout 入站行顺序即时结算，避免与同批后续通知产生微任务竞态。 */
  onSettle?(ok: boolean, value: any): void;
}

interface KimiPermission {
  rpcId: string | number;
  method: "session/request_permission" | "elicitation/create";
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
  processIdentity?: WorkerProcessIdentity;
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

export interface AcpConfigOption {
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

export function acpConfigSchemaFromOptions(configOptions: AcpConfigOption[], agent: "kimi" | "antigravity" = "kimi"): DriverConfigSchema {
  const ids = agent === "antigravity" ? { model: "model", thought_level: "effort", mode: "permissionMode" } as Record<string, ConfigOptionId> : KIMI_UNIFIED_IDS;
  return {
    source: `${agent === "antigravity" ? "Antigravity" : "Kimi"} ACP session/new.configOptions`,
    options: configOptions.flatMap((option) => {
      const id = ids[String(option.id ?? "")];
      if (!id) return [];
      const values = (option.options ?? []).flatMap((value) => value.value === undefined ? [] : [{
        value: String(value.value),
        label: value.name ?? String(value.value),
        ...(value.description ? { description: value.description } : {}),
      }]);
      const preferred = id === "effort" && agent === "antigravity" ? "high"
        : id === "permissionMode" ? "auto" : undefined;
      return [{
        id,
        name: CONFIG_NAMES[id],
        values,
        default: preferred && (agent === "kimi" || values.some((item) => item.value === preferred)) ? preferred : option.currentValue === undefined ? "" : String(option.currentValue),
        mutable: true,
      }];
    }),
  };
}

function kimiConfigFromOptions(configOptions: AcpConfigOption[], agent: "kimi" | "antigravity"): SessionConfig {
  const ids = agent === "antigravity" ? { model: "model", thought_level: "effort", mode: "permissionMode" } as Record<string, ConfigOptionId> : KIMI_UNIFIED_IDS;
  const config: SessionConfig = {};
  for (const option of configOptions) {
    const id = ids[String(option.id ?? "")];
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
  const probe = new StdioRpcProbe("kimi", ["acp"], cwd, proxyEnvironment());
  let sessionId = "";
  try {
    await probe.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: KIMI_CLIENT_CAPABILITIES,
      clientInfo: { name: "workbench-meta", title: "Workbench metadata probe", version: "0.1.0" },
    });
    const result = await probe.request("session/new", { cwd, mcpServers: [] });
    sessionId = String(result?.sessionId ?? "");
    return acpConfigSchemaFromOptions(Array.isArray(result?.configOptions) ? result.configOptions : []);
  } finally {
    if (sessionId) {
      try { await probe.request("session/close", { sessionId }, 1_000); } catch { /* probe shutdown remains authoritative */ }
    }
    try { await probe.close(); }
    finally { if (sessionId) await cleanupKimiProbeSession(sessionId); }
  }
}

/** 按 LF 切分，保留 CR 和文件末尾空行，与 split("\n") 一致。 */
async function* textFileLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    yield pending;
  } finally { stream.destroy(); }
}

/** 两家官方 ACP 共用消息、审批、附件与终端生命周期；配置 ID 和默认档位按 CLI 区分。 */
export class AcpDriver extends BaseDriver {
  readonly kind: "kimi" | "antigravity";
  private get label(): string { return this.kind === "antigravity" ? "Antigravity" : "Kimi"; }

  constructor(options: DriverOptions, kind: "kimi" | "antigravity") {
    super(options);
    this.kind = kind;
  }
  private fileRequests: Promise<void> = Promise.resolve();
  private filesClosed = false;
  private terminalCleanup: Promise<void> = Promise.resolve();
  private rpcId = 1_000;
  private readonly rpc = new Map<number, PendingRpc>();
  private readonly permissions = new Map<string, KimiPermission>();
  private readonly terminals = new Map<string, TerminalState>();
  private readonly releasedTerminals = new Map<string, TerminalEventOutputState>();
  private nativeSessionId = "";
  private terminalCounter = 0;
  private configOptions: AcpConfigOption[] = [];
  private activePrompts = 0;
  private hasPrompted = false;
  private promptSeq = 0;
  private readonly queuedPrompts: Array<{ prompt: Record<string, unknown>[]; promptId: string }> = [];
  private readonly inFlightTools = new Map<string, BackgroundTask>();
  private readonly subagentStarterCalls = new Set<string>();
  private readonly subagentKillAllCalls = new Set<string>();
  /** 已补发取消终态的工具 ID，过期前屏蔽包括重复终态在内的迟到帧。 */
  private readonly ignoredToolCallIds = new Map<string, number>();
  private readonly completedToolCallIds = new Map<string, number>();
  /** 待回报的原生子代理：starter toolCallId -> 有界保活截止时间戳，彼此独立计数。 */
  private readonly pendingNativeSubagents = new Map<string, number>();
  private settlingSubagentId: string | null = null;
  private unclaimedExpiredSubagents = 0;
  private settlingExpiredSubagent = false;
  /** 并发 prompt 期间若先结束了某个后台工具，记录唤醒宽限截止时刻，留给最后一条 prompt 结束时接续。 */
  private readonly backgroundToolCallIds = new Set<string>();
  private pendingWakeDeadlineMs = 0;
  private wakeGraceEndsAtMs = 0;
  private wakeSource: "none" | "tool" | "subagent" = "none";
  private interruptedUntilNextPrompt = false;
  private reactivePhase: "idle" | "waiting_wake" | "awake" = "idle";
  private reactiveTimer?: ReturnType<typeof setTimeout>;
  private lastPublishedBackgroundKey = "[]";
  /** Antigravity reactive wakeup 收尾确认、工具唤醒与原生子代理有界保活时长（毫秒）；单测可覆盖。 */
  protected reactiveSettleMs = 2_500;
  protected reactiveWakeGraceMs = 35_000;
  protected reactiveFallbackMs = 35_000;
  protected reactiveSubagentGraceMs = 15 * 60_000;
  protected ignoredToolTtlMs = 10 * 60_000;

  async start(): Promise<void> {
    this.spawnProcess(this.kind === "antigravity" ? "agy" : "kimi", ["acp"]);
    await withTimeout(this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: KIMI_CLIENT_CAPABILITIES,
      clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
    }), 15_000, `${this.label} initialize`);

    const requestedConfig = { ...this.config };
    const result = this.resumeSessionId
      ? await withTimeout(this.request("session/resume", {
        sessionId: this.resumeSessionId,
        cwd: this.cwd,
        mcpServers: [],
      }), 15_000, `${this.label} session/resume`)
      : await withTimeout(this.request("session/new", { cwd: this.cwd, mcpServers: [] }), 15_000, `${this.label} session/new`);
    this.nativeSessionId = result?.sessionId ?? this.resumeSessionId ?? "";
    if (!this.nativeSessionId) throw new Error(`${this.label} 未返回 sessionId`);
    this.updateConfigOptions(result?.configOptions ?? []);

    if (requestedConfig.model) await this.applyConfigOption("model", requestedConfig.model);
    const effort = this.startEffort(requestedConfig.effort);
    if (effort !== undefined) await this.applyConfigOption("effort", effort);
    const permissionMode = this.startPermissionMode(requestedConfig.permissionMode);
    if (permissionMode !== undefined) await this.applyConfigOption("permissionMode", permissionMode);
    this.callbacks.metadata({
      nativeSessionId: this.nativeSessionId,
      config: { ...this.config },
      configSchema: this.getConfigSchema(),
    });
    this.callbacks.status("idle");
  }

  getConfigSchema(): DriverConfigSchema {
    return acpConfigSchemaFromOptions(this.configOptions, this.kind);
  }

  async setConfig(config: SessionConfig): Promise<SessionConfig> {
    const entries = (["model", "effort", "permissionMode"] as ConfigOptionId[])
      .filter((id) => config[id] !== undefined);
    if (entries.length === 0) throw new Error(`${this.label} set_config 没有可修改的配置项`);
    for (const id of entries) await this.applyConfigOption(id, config[id]!);
    const current = { ...this.config };
    this.callbacks.metadata({ config: current, configSchema: this.getConfigSchema() });
    return current;
  }

  async sendUserMessage(message: UserMessageInput, options?: SendUserMessageOptions): Promise<void | SendUserMessageReceipt> {
    if (!this.nativeSessionId) throw new Error(`${this.label} session 尚未就绪`);
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
    const promptId = `${this.kind}:p${++this.promptSeq}`;
    if (options?.steer) {
      if (!this.activePrompts) throw new Error(`${this.label} 当前回合已结束，请重发消息`);
      if (this.kind === "kimi") {
        this.queuedPrompts.push({ prompt, promptId });
        return { queued: true, promptId };
      }
      // Antigravity 接收运行中追加的 session/prompt，由原生 CLI 决定何时处理。
    }
    this.startPrompt(prompt, promptId);
    return { promptId };
  }

  private startPrompt(prompt: Record<string, unknown>[], promptId: string): void {
    this.hasPrompted = true;
    this.activePrompts++;
    const startedAt = Date.now();
    if (this.kind === "antigravity") {
      this.interruptedUntilNextPrompt = false;
      this.pruneTerminalToolIds(startedAt);
      // 原生子代理在各自条目上已有绝对截止时刻，单独保留工具的剩余宽限。
      if (this.reactivePhase === "waiting_wake" && this.wakeSource === "tool" && this.wakeGraceEndsAtMs > startedAt) {
        this.pendingWakeDeadlineMs = Math.max(this.pendingWakeDeadlineMs, this.wakeGraceEndsAtMs);
      }
      this.clearReactiveTimer();
      this.wakeGraceEndsAtMs = 0;
      this.settlingSubagentId = null;
      this.settlingExpiredSubagent = false;
      this.reactivePhase = "idle";
      this.wakeSource = "none";
      this.syncAntigravityBackgroundTasks();
    }
    this.callbacks.status("running");
    const id = this.rpcId++;
    this.rpc.set(id, {
      resolve: () => {},
      reject: () => {},
      onSettle: (ok, value) => {
        this.activePrompts = Math.max(0, this.activePrompts - 1);
        if (ok) {
          this.callbacks.emit("turn_completed", {
            stopReason: value?.stopReason,
            result: value,
            promptId,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        } else {
          this.cancelQueuedPrompts("当前回合失败");
          this.callbacks.emit("session_error", { message: errorMessage(value), source: "session/prompt", promptId });
        }
        if (this.kind === "antigravity") {
          for (const toolId of this.inFlightTools.keys()) this.backgroundToolCallIds.add(toolId);
          if (this.activePrompts === 0) this.enterAntigravityIdleGuard();
        }
        const next = this.queuedPrompts.shift();
        if (next) this.startPrompt(next.prompt, next.promptId);
        else if (this.activePrompts === 0) {
          const backgroundBusy = this.kind === "antigravity" && (this.inFlightTools.size > 0 || this.reactivePhase !== "idle");
          this.callbacks.status(ok || backgroundBusy ? "idle" : "error");
        } else if (!ok) {
          this.callbacks.status("running");
        }
      },
    });
    try {
      this.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: this.nativeSessionId, prompt } });
    } catch (error) {
      const pending = this.rpc.get(id);
      this.rpc.delete(id);
      pending?.onSettle?.(false, error);
    }
  }

  private cancelQueuedPrompts(reason: string): void {
    const cancelledPromptIds = this.queuedPrompts.map((entry) => entry.promptId);
    this.queuedPrompts.length = 0;
    if (cancelledPromptIds.length) this.callbacks.emit("session_error", {
      source: "steer_queue",
      cancelledPromptIds,
      message: `${this.label} 的 ${cancelledPromptIds.length} 条排队消息已取消：${reason}`,
    });
  }

  async resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`${this.label} permission_request 不存在：${requestId}`);
    if (pending.method === "elicitation/create") {
      if (updatedInput !== undefined) throw new Error(`${this.label} 提问不接受 updatedInput`);
      if (decision === "deny") {
        this.replyResult(pending.rpcId, { action: "decline" });
      } else {
        const questions = pending.questions ?? [];
        if (!questionAnswers || Object.keys(questionAnswers).length !== questions.length) {
          throw new Error(`${this.label} 提问必须回答全部问题`);
        }
        const content: Record<string, string | string[]> = Object.create(null);
        for (const question of questions) {
          if (!Object.hasOwn(questionAnswers, question.question)) {
            throw new Error(`${this.label} 提问缺少答案：${question.question}`);
          }
          const answer = questionAnswers[question.question]!.trim();
          const exact = question.options.find((option) => option.label === answer);
          const labels = exact ? [answer] : answer.split(",").map((label) => label.trim());
          if (!question.multiSelect && labels.length !== 1) throw new Error(`${this.label} 提问只允许单选：${question.question}`);
          if (new Set(labels).size !== labels.length || labels.some((label) => !question.options.some((o) => o.label === label))) {
            throw new Error(`${this.label} 提问只接受列出的选项，不支持「其他」：${question.question}`);
          }
          const values = question.options.filter((option) => labels.includes(option.label)).map((option) => option.value);
          content[question.key] = question.multiSelect ? values : values[0]!;
        }
        this.replyResult(pending.rpcId, { action: "accept", content });
      }
    } else {
      if (questionAnswers !== undefined) throw new Error(`${this.label} 普通审批不接受 questionAnswers`);
      this.resolveStandardPermission(pending, decision);
    }
    this.permissions.delete(requestId);
  }

  async interrupt(): Promise<void> {
    this.cancelQueuedPrompts("用户停止了执行");
    this.cancelElicitations();
    if (this.kind === "antigravity") {
      for (const toolCallId of this.inFlightTools.keys()) {
        this.callbacks.emit("tool_call_completed", { toolCallId, isError: true, status: "cancelled", content: "Cancelled" });
      }
      this.resetAntigravityBackgroundState(true, true);
      for (const [requestId, pending] of this.permissions) {
        this.replyResult(pending.rpcId, { outcome: { outcome: "cancelled" } });
        this.permissions.delete(requestId);
        this.callbacks.emit("permission_resolved", { requestId, decision: "deny" });
      }
    }
    if (!this.nativeSessionId) return;
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.nativeSessionId } });
  }

  async stop(): Promise<void> {
    this.filesClosed = true;
    this.resetAntigravityBackgroundState(false, false);
    const filesStopped = withTimeout(this.fileRequests, 1_000, `${this.label} file operations`).catch(error => {
      log("warn", `${this.label} file operation drain timed out`, { sessionId: this.sessionId, message: errorMessage(error) });
    });
    this.cancelQueuedPrompts("worker 已停止");
    this.cancelElicitations();
    const terminalsStopped = this.cleanupTerminals();
    if (this.nativeSessionId && this.child?.stdin.writable) {
      try {
        await withTimeout(this.request("session/close", { sessionId: this.nativeSessionId }), 1_000, `${this.label} session/close`);
      } catch { /* process shutdown remains authoritative */ }
    }
    try { await super.stop(); }
    // 等待 session/close 期间仍可能新建或 release 终端；worker 停止后再收一次最新的清理链。
    finally { await Promise.all([terminalsStopped, this.cleanupTerminals(), filesStopped]); this.releasedTerminals.clear(); }
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
        if (pending.onSettle) {
          if (message.error) pending.onSettle(false, new Error(message.error.message ?? JSON.stringify(message.error)));
          else pending.onSettle(true, message.result);
        } else if (message.error) {
          pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }
    if (typeof message.method !== "string") {
      this.callbacks.emit("raw_event", { source: this.kind, raw: message });
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
    this.callbacks.emit("raw_event", { source: this.kind, method: message.method, params: message.params ?? {} });
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
      // 与 Claude/Codex 一致：审批由 CLI 按会话模式决定，执行端不重复询问。
      this.handleCreateTerminal(message.id, message.params ?? {});
      return;
    }
    if (method === "fs/write_text_file" || method === "fs/read_text_file") {
      if (this.filesClosed) return;
      this.fileRequests = this.fileRequests.then(() => {
        if (this.filesClosed) return;
        return method === "fs/write_text_file"
          ? this.handleWriteTextFile(message.id, message.params ?? {})
          : this.handleReadTextFile(message.id, message.params ?? {});
      })
        .catch(() => { /* worker 已退出时不再回复。 */ });
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
    this.replyError(message.id, -32601, `AIReins 未实现 ${this.label} 方法：${method}`);
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
      this.callbacks.emit("raw_event", { source: this.kind, method: message.method,
        warning: "elicitation 表单包含前端无法表达的字段，已按取消处理" });
      return;
    }
    const requestId = `${this.kind}:elicitation:${String(message.id)}`;
    this.permissions.set(requestId, { rpcId: message.id, method: "elicitation/create", params, questions });
    this.callbacks.emit("permission_request", {
      requestId, gate: message.method, toolName: "AskUserQuestion",
      interactionType: "ask_user_question", questionProtocol: `${this.kind}_acp_elicitation_form_v1`,
      questions: questions.map((q) => ({ question: q.question, header: q.header,
        options: q.options.map(({ label, description }) => ({ label, description })), multiSelect: q.multiSelect })),
      otherSupported: false,
      protocolLimitations: [`${this.label} AskUserQuestion 的 form 桥接不接收「其他」自由文本`],
    });
  }

  protected handleProcessExit(): void {
    this.filesClosed = true;
    this.resetAntigravityBackgroundState(false, false);
    void this.cleanupTerminals();
    this.activePrompts = 0;
    this.cancelQueuedPrompts("worker 已退出");
    this.permissions.clear();
    this.rpc.clear();
    this.releasedTerminals.clear();
  }

  private cleanupTerminals(): Promise<void> {
    const pending = [this.terminalCleanup];
    for (const terminal of this.terminals.values()) {
      pending.push(stopChildProcess(terminal.process, terminal.processIdentity));
    }
    this.terminals.clear();
    this.terminalCleanup = Promise.all(pending).then(() => undefined);
    return this.terminalCleanup;
  }

  private cancelElicitations(): void {
    for (const [requestId, pending] of this.permissions) {
      if (pending.method !== "elicitation/create") continue;
      if (this.child?.stdin.writable) this.replyResult(pending.rpcId, { action: "cancel" });
      this.permissions.delete(requestId);
      if (this.kind === "antigravity") this.callbacks.emit("permission_resolved", { requestId, decision: "deny" });
    }
  }

  private queuePermission(
    message: Record<string, any>,
    pendingMethod: KimiPermission["method"],
    gate: string,
    payload: Record<string, unknown>,
  ): void {
    const requestId = `${this.kind}:${gate}:${String(message.id)}`;
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

  private handleCreateTerminal(id: string | number, params: Record<string, any>): void {
    const terminalId = `workbench-${this.sessionId}-${++this.terminalCounter}`;
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const envEntries = Array.isArray(params.env) ? params.env : [];
    const env = { ...process.env };
    for (const entry of envEntries) {
      if (entry && typeof entry.name === "string") env[entry.name] = String(entry.value ?? "");
    }
    env.WORKBENCH_PARENT_AGENT = this.kind;
    env.WORKBENCH_PARENT_SESSION_ID = this.nativeSessionId;
    const outputLimit = Math.max(1, Number(params.outputByteLimit) || 4 * 1024 * 1024);
    const processHandle = spawn(String(params.command), args, {
      cwd: typeof params.cwd === "string" ? params.cwd : this.cwd,
      env: proxyEnvironment(env),
      detached: POSIX_PROCESS_GROUPS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const processIdentity = captureProcessGroup(processHandle);
    let finish!: () => void;
    const state: TerminalState = {
      process: processHandle,
      processIdentity,
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
    this.replyResult(id, { terminalId });
  }

  private async handleWriteTextFile(id: string | number, params: Record<string, any>): Promise<void> {
    try {
      await writeFile(String(params.path), String(params.content ?? ""), "utf8");
      if (!this.filesClosed) this.replyResult(id, {});
    } catch (error) {
      if (!this.filesClosed) this.replyError(id, -32000, errorMessage(error));
    }
  }

  private async handleReadTextFile(id: string | number, params: Record<string, any>): Promise<void> {
    try {
      const path = String(params.path);
      const startLine = Math.max(1, Number(params.line) || 1);
      const limit = Number(params.limit);
      let content: string;
      const start = Math.trunc(startLine - 1);
      const end = Number.isFinite(limit) ? Math.trunc(startLine - 1 + limit) : Infinity;
      if ((params.line === undefined && params.limit === undefined) || end < 0) {
        // 负的 slice 终点依赖全文行数；保留旧协议对这类参数的行为。
        content = await readFile(path, "utf8");
        if (startLine > 1 || Number.isFinite(limit)) content = content.split("\n").slice(start, Number.isFinite(limit) ? end : undefined).join("\n");
      } else {
        const lines: string[] = [];
        let index = 0;
        for await (const line of textFileLines(path)) {
          if (index >= end) break;
          if (index >= start) lines.push(line);
          index++;
          if (index >= end) break;
        }
        content = lines.join("\n");
      }
      if (!this.filesClosed) this.replyResult(id, { content });
    } catch (error) {
      if (!this.filesClosed) this.replyError(id, -32000, errorMessage(error));
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
    })).catch(() => { /* worker 已停止时，迟到的终端回复无需再发送。 */ });
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
    // ACP release 语义是结束仍在运行的命令；组长已退出时也回收其独立组，stop 会等待这条清理。
    this.terminalCleanup = Promise.all([this.terminalCleanup, stopChildProcess(terminal.process, terminal.processIdentity)]).then(() => undefined);
    this.replyResult(id, {});
  }

  private handleSessionUpdate(params: Record<string, any>): void {
    const update = params.update ?? {};
    const type = update.sessionUpdate;
    if (type === "session_info_update") {
      if (this.nativeSessionId && typeof params.sessionId === "string" && params.sessionId !== this.nativeSessionId) return;
      if (typeof update.title === "string" && update.title.trim()) {
        this.callbacks.metadata({ nativeTitle: update.title });
      }
      return;
    }
    if (type === "config_option_update") {
      this.updateConfigOptions(update.configOptions ?? []);
      this.callbacks.metadata({ config: { ...this.config }, configSchema: this.getConfigSchema() });
      return;
    }
    if (type === "current_mode_update" && typeof update.currentModeId === "string") {
      this.config.permissionMode = update.currentModeId;
      this.callbacks.metadata({ config: { ...this.config }, configSchema: this.getConfigSchema() });
      return;
    }
    if (type === "agent_message_chunk") {
      if (this.shouldDropAntigravityUpdate()) return;
      this.noteAntigravityReactiveStream();
      this.callbacks.emit("agent_text_delta", { text: update.content?.text ?? "" });
      return;
    }
    if (type === "agent_thought_chunk") {
      if (this.shouldDropAntigravityUpdate()) return;
      this.noteAntigravityReactiveStream();
      this.callbacks.emit("thought_delta", { text: update.content?.text ?? "" });
      return;
    }
    if (type === "tool_call" || type === "tool_call_update") {
      if (this.shouldDropAntigravityUpdate(update.toolCallId)) return;
      const terminal = update.status === "completed" || update.status === "failed"
        || (this.kind === "antigravity" && update.status === "cancelled");
      if (type === "tool_call") {
        this.noteAntigravityToolStarted(update, terminal);
        this.callbacks.emit("tool_call_started", {
          toolCallId: update.toolCallId,
          toolName: update.title,
          input: update.rawInput ?? update.content ?? [],
          status: update.status,
          ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
          ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
        });
        if (!terminal || this.kind !== "antigravity") return;
      }
      const payload = {
        toolCallId: update.toolCallId,
        toolName: update.title,
        input: update.rawInput,
        content: update.content,
        status: update.status,
        ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
        ...(Array.isArray(update.locations) ? { locations: update.locations } : {}),
      };
      if (terminal) {
        if (this.kind === "antigravity" && typeof update.toolCallId === "string") {
          this.completedToolCallIds.set(update.toolCallId, Date.now() + this.ignoredToolTtlMs);
        }
        const terminalOutput = terminalOutputForEvent(update.content,
          (terminalId) => this.terminals.get(terminalId) ?? this.releasedTerminals.get(terminalId));
        this.callbacks.emit("tool_call_completed", {
          ...payload,
          isError: update.status !== "completed",
          ...(terminalOutput ? { terminalOutput } : {}),
        });
        this.noteAntigravityToolCompleted(update);
      } else {
        this.noteAntigravityToolUpdated(update);
        this.callbacks.emit("tool_call_updated", payload);
      }
      return;
    }
    if (type === "usage_update") {
      if (this.shouldDropAntigravityUpdate()) return;
      this.callbacks.emit("usage_updated", { used: update.used ?? update.contextWindow?.used, size: update.size ?? update.contextWindow?.size });
      this.noteAntigravityUsageUpdate();
      return;
    }
    if (type === "available_commands_update") {
      const commands = this.normalizeCommands(update.availableCommands);
      this.callbacks.commands(commands);
      return;
    }
    this.callbacks.emit("raw_event", { source: this.kind, update });
  }

  private pruneTerminalToolIds(now = Date.now()): void {
    for (const ids of [this.ignoredToolCallIds, this.completedToolCallIds]) {
      for (const [id, expiresAt] of ids) {
        if (expiresAt <= now) ids.delete(id);
      }
    }
  }

  private pruneExpiredSubagents(now = Date.now()): void {
    for (const [id, expiresAt] of this.pendingNativeSubagents) {
      if (expiresAt > now) continue;
      this.pendingNativeSubagents.delete(id);
      if (id !== this.settlingSubagentId) this.unclaimedExpiredSubagents++;
    }
    if (this.pendingNativeSubagents.size === 0) this.unclaimedExpiredSubagents = 0;
  }

  private nextSubagentGraceMs(now = Date.now()): number {
    this.pruneExpiredSubagents(now);
    let maxExpires = 0;
    for (const expiresAt of this.pendingNativeSubagents.values()) {
      if (expiresAt > maxExpires) maxExpires = expiresAt;
    }
    return maxExpires > now ? maxExpires - now : 0;
  }

  /** 在发布事件前屏蔽中断后的输出，以及已终结工具的迟到帧。 */
  private shouldDropAntigravityUpdate(toolCallId?: unknown): boolean {
    if (this.kind !== "antigravity") return false;
    if (this.interruptedUntilNextPrompt) return true;
    if (typeof toolCallId !== "string") return false;
    this.pruneTerminalToolIds();
    return this.ignoredToolCallIds.has(toolCallId) || this.completedToolCallIds.has(toolCallId);
  }

  private clearReactiveTimer(): void {
    if (!this.reactiveTimer) return;
    clearTimeout(this.reactiveTimer);
    this.reactiveTimer = undefined;
  }

  private scheduleReactiveClear(delayMs: number, consumeOneSubagent = false): void {
    this.clearReactiveTimer();
    this.reactiveTimer = setTimeout(() => {
      this.reactiveTimer = undefined;
      if (this.activePrompts > 0 || this.inFlightTools.size > 0) return;
      const now = Date.now();
      this.pruneExpiredSubagents(now);
      if (consumeOneSubagent) {
        if (this.settlingExpiredSubagent) this.unclaimedExpiredSubagents = Math.max(0, this.unclaimedExpiredSubagents - 1);
        else if (this.settlingSubagentId !== null) this.pendingNativeSubagents.delete(this.settlingSubagentId);
      }
      this.settlingSubagentId = null;
      this.settlingExpiredSubagent = false;
      const remainingSubagentMs = this.nextSubagentGraceMs(now);
      if (remainingSubagentMs > 0) {
        this.waitForAntigravityWake("subagent", now + remainingSubagentMs);
        return;
      }
      this.reactivePhase = "idle";
      this.wakeSource = "none";
      this.wakeGraceEndsAtMs = 0;
      this.syncAntigravityBackgroundTasks();
    }, delayMs);
    this.reactiveTimer.unref();
  }

  private waitForAntigravityWake(source: "tool" | "subagent", deadlineMs: number): void {
    this.reactivePhase = "waiting_wake";
    this.wakeSource = source;
    this.wakeGraceEndsAtMs = deadlineMs;
    this.settlingSubagentId = null;
    this.settlingExpiredSubagent = false;
    if (this.inFlightTools.size === 0) this.scheduleReactiveClear(Math.max(0, deadlineMs - Date.now()));
    else this.clearReactiveTimer();
    this.syncAntigravityBackgroundTasks();
  }

  /** 最后一个在途 session/prompt 结束时，接续未完成工具、并发期间刚结束工具的剩余唤醒宽限或待回报原生子代理。 */
  private enterAntigravityIdleGuard(): void {
    if (this.interruptedUntilNextPrompt) {
      this.syncAntigravityBackgroundTasks();
      return;
    }
    const now = Date.now();
    const wakeRemaining = this.pendingWakeDeadlineMs > now ? this.pendingWakeDeadlineMs - now : 0;
    this.pendingWakeDeadlineMs = 0;
    if (this.inFlightTools.size === 0) {
      if (wakeRemaining > 0) {
        this.waitForAntigravityWake("tool", now + wakeRemaining);
        return;
      }
      const subagentRemaining = this.nextSubagentGraceMs(now);
      if (subagentRemaining > 0) {
        this.waitForAntigravityWake("subagent", now + subagentRemaining);
        return;
      }
    }
    this.syncAntigravityBackgroundTasks();
  }

  private antigravityToolTask(update: Record<string, any>, previous?: BackgroundTask): BackgroundTask | null {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return null;
    const rawTitle = typeof update.title === "string" && update.title.trim() ? update.title.replace(/\s+/g, " ").trim() : previous?.description ?? "tool";
    return {
      id,
      type: typeof update.kind === "string" && update.kind ? update.kind : previous?.type ?? "tool",
      description: rawTitle.slice(0, 120),
    };
  }

  private trackNativeSubagentLifecycleTool(id: string, update: Record<string, any>): void {
    const title = typeof update.title === "string" ? update.title : "";
    const input = update.rawInput && typeof update.rawInput === "object" ? update.rawInput as Record<string, unknown> : null;
    if (/\binvoke_subagent\b/i.test(title) || (/\bswarm\b/i.test(title) && input?.action === "add")) {
      this.subagentStarterCalls.add(id);
    }
    if (/\bmanage_subagents\b/i.test(title) && input?.Action === "kill_all") {
      this.subagentKillAllCalls.add(id);
    }
  }

  private noteAntigravityToolStarted(update: Record<string, any>, terminal: boolean): void {
    if (this.kind !== "antigravity" || !this.hasPrompted || this.interruptedUntilNextPrompt) return;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    this.trackNativeSubagentLifecycleTool(id, update);
    if (terminal) return;
    const task = this.antigravityToolTask(update);
    if (!task) return;
    this.inFlightTools.set(task.id, task);
    this.noteAntigravityReactiveStream();
  }

  private noteAntigravityToolUpdated(update: Record<string, any>): void {
    if (this.kind !== "antigravity" || !this.hasPrompted || this.interruptedUntilNextPrompt) return;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    this.trackNativeSubagentLifecycleTool(id, update);
    const task = this.antigravityToolTask(update, this.inFlightTools.get(id));
    if (!task) return;
    this.inFlightTools.set(id, task);
    this.noteAntigravityReactiveStream();
  }

  private noteAntigravityToolCompleted(update: Record<string, any>): void {
    if (this.kind !== "antigravity" || !this.hasPrompted || this.interruptedUntilNextPrompt) return;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const succeeded = update.status === "completed";
    const wasSubagentStarter = id ? this.subagentStarterCalls.delete(id) : false;
    const wasKillAll = id ? this.subagentKillAllCalls.delete(id) : false;
    const hadInFlight = id ? this.inFlightTools.delete(id) : false;
    const wasBackgroundTool = id ? this.backgroundToolCallIds.delete(id) : false;
    const now = Date.now();
    if (wasSubagentStarter && succeeded && id) {
      this.pruneExpiredSubagents(now);
      this.pendingNativeSubagents.set(id, now + this.reactiveSubagentGraceMs);
    }
    if (wasKillAll && succeeded) {
      this.pendingNativeSubagents.clear();
      this.unclaimedExpiredSubagents = 0;
    }
    if (this.activePrompts > 0) {
      // 仅对已跨过前序 prompt 结束边界的后台工具保留唤醒宽限，普通同步工具不触发。
      if (hadInFlight && wasBackgroundTool && !wasSubagentStarter) {
        this.pendingWakeDeadlineMs = Math.max(this.pendingWakeDeadlineMs, now + this.reactiveWakeGraceMs);
      }
      return;
    }
    if (hadInFlight && !wasSubagentStarter) {
      // 只有独立后台工具开启新的唤醒窗口，续跑中的同步工具沿用当前唤醒来源。
      if (wasBackgroundTool || this.reactivePhase !== "awake") this.waitForAntigravityWake("tool", now + this.reactiveWakeGraceMs);
      else this.noteAntigravityReactiveStream();
    } else if (this.inFlightTools.size > 0) {
      this.clearReactiveTimer();
      this.syncAntigravityBackgroundTasks();
    } else {
      const subagentRemaining = this.nextSubagentGraceMs(now);
      if (subagentRemaining > 0) {
        this.waitForAntigravityWake("subagent", now + subagentRemaining);
      } else if (this.reactivePhase !== "idle") {
        this.waitForAntigravityWake("tool", now + this.reactiveWakeGraceMs);
      }
    }
  }

  private noteAntigravityReactiveStream(): void {
    if (this.kind !== "antigravity" || !this.hasPrompted || this.activePrompts > 0 || this.interruptedUntilNextPrompt) return;
    if (this.reactivePhase !== "awake") {
      this.pruneExpiredSubagents();
      if (this.wakeSource === "none") this.wakeSource = this.pendingNativeSubagents.size > 0 ? "subagent" : "tool";
      // ACP 唤醒没有子代理 ID，优先吸收可能来自刚到期条目的迟到回报。
      if (this.wakeSource === "subagent" && this.settlingSubagentId === null) {
        if (this.unclaimedExpiredSubagents > 0) this.settlingExpiredSubagent = true;
        else this.settlingSubagentId = this.pendingNativeSubagents.keys().next().value ?? null;
      }
    }
    this.reactivePhase = "awake";
    this.wakeGraceEndsAtMs = 0;
    if (this.inFlightTools.size === 0) this.scheduleReactiveClear(this.reactiveFallbackMs, this.wakeSource === "subagent");
    else this.clearReactiveTimer();
    this.syncAntigravityBackgroundTasks();
  }

  private noteAntigravityUsageUpdate(): void {
    // 仅在真正收到唤醒输出（awake）且无在途工具时才按收尾确认窗口结算；若本次唤醒来自子代理则只消费一条子代理记录。
    if (this.kind !== "antigravity" || !this.hasPrompted || this.activePrompts > 0
      || this.interruptedUntilNextPrompt || this.reactivePhase !== "awake"
      || this.inFlightTools.size > 0) return;
    this.scheduleReactiveClear(this.reactiveSettleMs, this.wakeSource === "subagent");
  }

  private syncAntigravityBackgroundTasks(): void {
    if (this.kind !== "antigravity") return;
    this.pruneExpiredSubagents();
    const tasks: BackgroundTask[] = this.activePrompts > 0
      ? []
      : this.inFlightTools.size > 0
        ? [...this.inFlightTools.values()]
        : this.reactivePhase !== "idle"
          ? [{
            id: this.reactivePhase === "waiting_wake" && this.wakeSource === "subagent" && this.pendingNativeSubagents.size > 0
              ? "antigravity:subagent" : "antigravity:reactive",
            type: "subagent",
            description: this.reactivePhase === "waiting_wake" && this.wakeSource === "subagent" && this.pendingNativeSubagents.size > 0
              ? "subagent_pending" : "reactive_wakeup",
          }]
          : [];
    const key = JSON.stringify(tasks);
    if (key === this.lastPublishedBackgroundKey) return;
    this.lastPublishedBackgroundKey = key;
    this.callbacks.metadata({ backgroundTasks: tasks });
  }

  private resetAntigravityBackgroundState(publish: boolean, markInterrupted: boolean): void {
    this.clearReactiveTimer();
    const now = Date.now();
    if (markInterrupted) {
      this.pruneTerminalToolIds(now);
      for (const id of this.inFlightTools.keys()) this.ignoredToolCallIds.set(id, now + this.ignoredToolTtlMs);
      this.interruptedUntilNextPrompt = true;
    } else this.interruptedUntilNextPrompt = false;
    if (!publish) {
      this.ignoredToolCallIds.clear();
      this.completedToolCallIds.clear();
    }
    this.inFlightTools.clear();
    this.backgroundToolCallIds.clear();
    this.subagentStarterCalls.clear();
    this.subagentKillAllCalls.clear();
    this.pendingNativeSubagents.clear();
    this.settlingSubagentId = null;
    this.settlingExpiredSubagent = false;
    this.unclaimedExpiredSubagents = 0;
    this.pendingWakeDeadlineMs = 0;
    this.wakeGraceEndsAtMs = 0;
    this.wakeSource = "none";
    this.reactivePhase = "idle";
    if (publish) this.syncAntigravityBackgroundTasks();
    else this.lastPublishedBackgroundKey = "[]";
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
    if (!option) throw new Error(`${this.label} session/new 未提供配置项：${id}`);
    if (!option.values.some((item) => item.value === value)) {
      throw new Error(`${this.label} ${id} 不合法：${value}`);
    }
    const result = await withTimeout(this.request("session/set_config_option", {
      sessionId: this.nativeSessionId,
      configId: this.kind === "antigravity" ? ({ model: "model", effort: "thought_level", permissionMode: "mode" } as const)[id] : KIMI_CONFIG_IDS[id],
      value,
    }), 15_000, `${this.label} session/set_config_option(${id})`);
    if (Array.isArray(result?.configOptions)) {
      this.updateConfigOptions(result.configOptions);
    } else {
      this.config[id] = value;
    }
  }

  private updateConfigOptions(configOptions: AcpConfigOption[]): void {
    this.configOptions = configOptions;
    this.config = kimiConfigFromOptions(configOptions, this.kind);
  }

  private replyResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
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
        source: this.kind,
      }];
    });
  }

  private startEffort(requested: SessionConfig["effort"]): string | undefined {
    if (this.kind === "kimi") return requested || undefined;
    if (requested && requested !== "high") return requested;
    // 以应用模型后的候选为准，切到无 high 档位的模型（如 Orchestrator）时自动沿用 CLI 默认档位。
    const option = this.getConfigSchema().options.find((item) => item.id === "effort");
    const wantHigh = requested === "high" || !this.resumeSessionId;
    if (wantHigh && option?.values.some((item) => item.value === "high")) return "high";
    return undefined;
  }

  private startPermissionMode(requested: SessionConfig["permissionMode"]): string | undefined {
    if (this.kind === "kimi") return requested ?? (this.resumeSessionId ? "default" : "auto");
    if (requested && requested !== "auto") return requested;
    // 以应用模型和推理档位后的候选为准，兼容提交时仍使用旧元数据的表单。
    const option = this.getConfigSchema().options.find((item) => item.id === "permissionMode");
    const wantAuto = requested === "auto" || !this.resumeSessionId;
    if (wantAuto && option?.values.some((item) => item.value === "auto")) return "auto";
    if (this.config.permissionMode) return undefined;
    return option?.values.some((item) => item.value === "default") ? "default" : undefined;
  }
}

export class KimiDriver extends AcpDriver {
  constructor(options: DriverOptions) { super(options, "kimi"); }
}
