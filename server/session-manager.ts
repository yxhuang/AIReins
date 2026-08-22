import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createDriver, DRIVER_CAPABILITIES } from "./drivers/index.js";
import {
  cleanSessionConfig,
  configFromCreateInput,
  isRiskyConfig,
  mergeSessionConfig,
} from "./session-config.js";
import {
  appendTranscript,
  loadRegistry,
  readTranscript,
  saveRegistry,
  transcriptPathFor,
} from "./persistence.js";
import type {
  CreateSessionInput,
  Driver,
  DriverCallbacks,
  EventType,
  PermissionDecision,
  SessionConfig,
  SessionRecord,
  SessionStatus,
  UnifiedCommand,
  UnifiedEvent,
  UserMessageInput,
} from "./types.js";
import { ulid } from "./ulid.js";

const RING_SIZE = 1_000;
export type DriverFactory = typeof createDriver;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workers = new Map<string, Driver>();
  private readonly rings = new Map<string, UnifiedEvent[]>();
  private readonly commands = new Map<string, UnifiedCommand[]>();
  private readonly listeners = new Set<(event: UnifiedEvent) => void>();
  private readonly restartingSessions = new Set<string>();

  constructor(private readonly driverFactory: DriverFactory = createDriver) {
    const loaded = loadRegistry();
    for (const stored of loaded) {
      const events = readTranscript(stored.transcriptPath);
      const seq = events.at(-1)?.seq ?? stored.seq ?? 0;
      const config = cleanSessionConfig(stored.config ?? {
        model: stored.model,
        effort: stored.effort,
        permissionMode: stored.permissionMode,
      });
      this.sessions.set(stored.id, {
        ...stored,
        status: "dead",
        seq,
        processId: undefined,
        config,
        model: config.model,
        effort: config.effort,
        permissionMode: config.permissionMode,
        riskyMode: isRiskyConfig(stored.agent, config),
      });
      this.rings.set(stored.id, events.slice(-RING_SIZE));
      this.commands.set(stored.id, []);
    }
    if (loaded.length > 0) this.persistRegistry();
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()]
      .map(cloneSession)
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  get(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  getCommands(id: string): UnifiedCommand[] | undefined {
    if (!this.sessions.has(id)) return undefined;
    return (this.commands.get(id) ?? []).map((command) => ({ ...command }));
  }

  getSnapshot(id: string): { session: SessionRecord; seq: number; events: UnifiedEvent[] } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const events = readTranscript(session.transcriptPath);
    return { session: cloneSession(session), seq: session.seq, events };
  }

  getEventsAfter(id: string, afterSeq: number): { events: UnifiedEvent[]; requiresSnapshot: boolean; currentSeq: number } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const ring = this.rings.get(id) ?? [];
    const oldest = ring[0]?.seq ?? session.seq + 1;
    const requiresSnapshot = afterSeq < session.seq && afterSeq < oldest - 1;
    return {
      events: requiresSnapshot ? [] : ring.filter((event) => event.seq > afterSeq),
      requiresSnapshot,
      currentSeq: session.seq,
    };
  }

  onEvent(listener: (event: UnifiedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    this.validateCwd(input.cwd);
    const id = ulid();
    const now = new Date().toISOString();
    const config = configFromCreateInput(input);
    const record: SessionRecord = {
      id,
      agent: input.agent,
      agentId: input.agentId || "main",
      cwd: resolve(input.cwd),
      status: "starting",
      createdAt: now,
      lastActivityAt: now,
      seq: 0,
      transcriptPath: transcriptPathFor(id),
      ...(input.resumeSessionId ? { nativeSessionId: input.resumeSessionId } : {}),
      ...(input.resumeSessionId ? {
        resumedFrom: {
          agent: input.agent,
          nativeSessionId: input.resumeSessionId,
        },
      } : {}),
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      config,
      riskyMode: isRiskyConfig(input.agent, config),
    };
    this.sessions.set(id, record);
    this.rings.set(id, []);
    this.commands.set(id, []);
    this.persistRegistry();
    this.emit(id, "session_created", {
      agent: input.agent,
      cwd: record.cwd,
      resumedNativeSessionId: input.resumeSessionId,
      resumedFrom: record.resumedFrom,
      config: record.config,
      riskyMode: record.riskyMode,
    });

    let worker!: Driver;
    const callbacks = this.driverCallbacks(id, () => worker);
    worker = this.driverFactory(input.agent, {
      sessionId: id,
      cwd: record.cwd,
      config,
      resumeSessionId: input.resumeSessionId,
      callbacks,
    });
    this.workers.set(id, worker);
    try {
      await worker.start();
      record.processId = worker.child?.pid;
      this.persistRegistry();
      if (input.initialMessage) await this.sendUserMessage(id, { text: input.initialMessage });
      return cloneSession(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(id, "session_error", { message, source: "startup" });
      this.setStatus(id, "error");
      await worker.stop();
      this.workers.delete(id);
      throw error;
    }
  }

  async sendUserMessage(id: string, input: UserMessageInput): Promise<void> {
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候再发送消息");
    const worker = this.requireWorker(id);
    const message = this.normalizeUserMessage(id, input);
    await worker.sendUserMessage(message);
    this.emit(id, "user_message", {
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.command ? { command: message.command } : {}),
      ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    });
  }

  async resolvePermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
  ): Promise<void> {
    const worker = this.requireWorker(id);
    await worker.resolvePermission(requestId, decision, updatedInput);
    this.emit(id, "permission_resolved", { requestId, decision, updatedInput });
  }

  async setConfig(id: string, config: SessionConfig): Promise<SessionRecord> {
    const entries = Object.entries(config).filter((entry): entry is [keyof SessionConfig, string | null] => (
      entry[1] === null || (typeof entry[1] === "string" && entry[1].length > 0)
    ));
    if (entries.length === 0) throw new Error("set_config.config 至少包含一个配置项");
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候");
    const worker = this.requireWorker(id);
    const schema = worker.getConfigSchema();
    for (const [key, value] of entries) {
      const option = schema.options.find((item) => item.id === key);
      if (!option) throw new Error(`${worker.kind} 不支持配置项：${key}`);
      if (!option.mutable) throw new Error(`${worker.kind}.${key} 只能在建会话时设置`);
      if (value === null && !option.values.some((item) => item.value === null)) {
        throw new Error(`${worker.kind}.${key} 不支持跟随配置`);
      }
      if (!option.values.some((item) => item.value === value)) {
        throw new Error(`${worker.kind}.${key} 不支持值：${value}`);
      }
    }
    if (worker.kind === "claude" && entries.some(([key]) => key === "model" || key === "effort")) {
      return await this.restartClaudeWorker(id, Object.fromEntries(entries) as SessionConfig);
    }
    const updated = await worker.setConfig(Object.fromEntries(entries) as SessionConfig);
    const record = this.sessions.get(id)!;
    this.applyConfig(record, updated);
    this.persistRegistry();
    this.emit(id, "config_updated", {
      config: { ...record.config },
      model: record.model,
      effort: record.effort,
      permissionMode: record.permissionMode,
      riskyMode: record.riskyMode,
      effectiveFrom: record.agent === "codex" ? "next_turn" : "immediate",
    });
    return cloneSession(record);
  }

  async interrupt(id: string): Promise<void> {
    await this.requireWorker(id).interrupt();
  }

  async remove(id: string): Promise<SessionRecord | undefined> {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const worker = this.workers.get(id);
    if (worker) await worker.stop();
    this.workers.delete(id);
    this.sessions.delete(id);
    this.rings.delete(id);
    this.commands.delete(id);
    this.persistRegistry();
    return cloneSession({ ...record, status: "dead", processId: undefined });
  }

  async shutdown(): Promise<void> {
    const running = [...this.workers.entries()];
    await Promise.allSettled(running.map(([, worker]) => worker.stop()));
    for (const [id] of running) {
      const record = this.sessions.get(id);
      if (record) {
        record.status = "dead";
        record.processId = undefined;
      }
    }
    this.workers.clear();
    this.persistRegistry();
  }

  private emit(id: string, type: EventType, payload: Record<string, unknown> = {}): UnifiedEvent | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const timestamp = new Date().toISOString();
    const event: UnifiedEvent = {
      type,
      sessionId: id,
      agentId: session.agentId,
      seq: ++session.seq,
      timestamp,
      payload,
    };
    session.lastActivityAt = timestamp;
    appendTranscript(session.transcriptPath, event);
    const ring = this.rings.get(id) ?? [];
    ring.push(event);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    this.rings.set(id, ring);
    this.persistRegistry();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  private setStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    session.lastActivityAt = new Date().toISOString();
    const pid = this.workers.get(id)?.child?.pid;
    session.processId = status === "dead" ? undefined : pid;
    this.persistRegistry();
  }

  private applyConfig(session: SessionRecord, update: SessionConfig): void {
    session.config = mergeSessionConfig(session.config, update);
    session.model = session.config.model;
    session.effort = session.config.effort;
    session.permissionMode = session.config.permissionMode;
    session.riskyMode = isRiskyConfig(session.agent, session.config);
  }

  private async restartClaudeWorker(id: string, update: SessionConfig): Promise<SessionRecord> {
    const record = this.sessions.get(id)!;
    if (record.status === "running") {
      throw new Error("当前回合尚未结束，请等待或中断后再切换");
    }
    if (!record.nativeSessionId) {
      throw new Error("Claude 首轮完成前尚无 nativeSessionId，无法通过续接切换模型或推理强度");
    }
    if (record.status !== "idle") {
      throw new Error(`Claude 会话当前状态为 ${record.status}，只能在回合结束后切换`);
    }

    const previousConfig = { ...record.config };
    const targetConfig = mergeSessionConfig(previousConfig, update);
    const nativeSessionId = record.nativeSessionId;
    const oldWorker = this.requireWorker(id);
    this.restartingSessions.add(id);
    this.emit(id, "config_update_started", {
      message: "正在切换模型…",
      mutableVia: "restart",
      nativeSessionId,
      previousConfig,
      targetConfig,
    });
    this.setStatus(id, "starting");
    this.workers.delete(id);

    let replacement: Driver | undefined;
    try {
      await oldWorker.stop();
      let nextWorker!: Driver;
      const callbacks = this.driverCallbacks(id, () => nextWorker);
      nextWorker = this.driverFactory("claude", {
        sessionId: id,
        cwd: record.cwd,
        config: targetConfig,
        resumeSessionId: nativeSessionId,
        callbacks,
      });
      replacement = nextWorker;
      this.workers.set(id, nextWorker);
      await nextWorker.start();
      record.processId = nextWorker.child?.pid;
      this.persistRegistry();
      this.emit(id, "config_updated", {
        config: { ...record.config },
        model: record.model,
        effort: record.effort,
        permissionMode: record.permissionMode,
        riskyMode: record.riskyMode,
        effectiveFrom: "immediate",
        mutableVia: "restart",
        workerRestarted: true,
        nativeSessionId,
      });
      return cloneSession(record);
    } catch (error) {
      if (replacement && this.workers.get(id) === replacement) this.workers.delete(id);
      if (replacement) await replacement.stop().catch(() => undefined);
      this.applyConfig(record, previousConfig);
      record.processId = undefined;
      this.emit(id, "session_error", {
        message: error instanceof Error ? error.message : String(error),
        source: "config_restart",
      });
      this.setStatus(id, "error");
      throw error;
    } finally {
      this.restartingSessions.delete(id);
    }
  }

  private driverCallbacks(id: string, worker: () => Driver): DriverCallbacks {
    const current = () => this.workers.get(id) === worker();
    return {
      emit: (type, payload = {}) => current() ? this.emit(id, type, payload) : undefined,
      metadata: (metadata) => {
        const session = this.sessions.get(id);
        if (!session || !current()) return;
        if (metadata.nativeSessionId) session.nativeSessionId = metadata.nativeSessionId;
        if (metadata.nativeTranscriptPath) session.nativeTranscriptPath = metadata.nativeTranscriptPath;
        if (metadata.config) this.applyConfig(session, metadata.config);
        const pid = worker().child?.pid;
        if (pid) session.processId = pid;
        this.persistRegistry();
      },
      commands: (commands) => {
        if (!this.sessions.has(id) || !current()) return;
        const normalized = commands.map((command) => ({ ...command }));
        this.commands.set(id, normalized);
        this.emit(id, "commands_updated", { commands: normalized });
      },
      status: (status) => {
        if (current()) this.setStatus(id, status);
      },
      exited: (info) => {
        if (!this.sessions.has(id) || !current()) return;
        this.emit(id, "process_exited", info as unknown as Record<string, unknown>);
        this.setStatus(id, "dead");
        this.workers.delete(id);
      },
    };
  }

  private requireWorker(id: string): Driver {
    if (!this.sessions.has(id)) throw new Error(`会话不存在：${id}`);
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`会话 ${id} 没有活动 worker；请用原生 session id 手动重开`);
    return worker;
  }

  private validateCwd(cwd: string): void {
    if (!cwd || !isAbsolute(cwd)) throw new Error("cwd 必须是绝对路径");
    const stats = statSync(cwd);
    if (!stats.isDirectory()) throw new Error("cwd 必须指向目录");
  }

  private normalizeUserMessage(id: string, input: UserMessageInput): UserMessageInput {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在：${id}`);
    const capabilities = DRIVER_CAPABILITIES[session.agent];
    if (input.command && !capabilities.commands) {
      throw new Error(`${session.agent} driver 不支持斜杠命令`);
    }
    if ((input.mentions?.length ?? 0) > 0 && !capabilities.mentions) {
      throw new Error(`${session.agent} driver 不支持 @ 引用`);
    }
    const text = input.text?.trim() ? input.text : undefined;
    let command = input.command;
    if (command) {
      const name = command.name.replace(/^\/+/, "").trim();
      if (!name || /\s/.test(name)) throw new Error("command.name 必须是不含空白的命令名");
      command = {
        name,
        ...(command.arguments?.trim() ? { arguments: command.arguments.trim() } : {}),
      };
    }
    const mentions = (input.mentions ?? []).map((mention) => {
      const path = resolve(session.cwd, mention.path);
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error(`引用路径不是文件：${path}`);
      return {
        type: "file" as const,
        path,
        ...(mention.name ? { name: mention.name } : {}),
      };
    });
    if (!text && !command && mentions.length === 0) {
      throw new Error("user_message 至少需要 text、command 或 mentions 之一");
    }
    if (text && command) throw new Error("user_message.text 与 command 不能同时提供");
    return {
      ...(text !== undefined ? { text } : {}),
      ...(command ? { command } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
  }

  private persistRegistry(): void {
    saveRegistry([...this.sessions.values()]);
  }
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    config: { ...session.config },
    ...(session.resumedFrom ? { resumedFrom: { ...session.resumedFrom } } : {}),
  };
}
