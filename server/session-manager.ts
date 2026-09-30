import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readClaudeEffectiveSettings, type ClaudeEffectiveSettings } from "./claude-settings.js";
import { createDriver, DRIVER_CAPABILITIES } from "./drivers/index.js";
import { log } from "./logger.js";
import { NativeConversationReader, type NativeConversationChange, type NativeConversationMark } from "./native-conversation.js";
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
import { createSnapshotIfNeeded } from "./snapshot.js";
import { IMAGE_MENTION_MIME_TYPES, MAX_IMAGE_MENTION_BYTES } from "./uploads.js";
import type {
  BackgroundTask,
  CreateSessionInput,
  Driver,
  DriverCallbacks,
  EffectiveConfigUpdate,
  EventType,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  SessionRecord,
  SessionStatus,
  RemoteControlState,
  UnifiedCommand,
  UnifiedEvent,
  UserMessageInput,
} from "./types.js";
import { ulid } from "./ulid.js";

const RING_SIZE = 1_000;
export type DriverFactory = typeof createDriver;
export type ClaudeSettingsResolver = (cwd: string) => ClaudeEffectiveSettings;
export type SnapshotCreator = (cwd: string) => Promise<string | null>;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workers = new Map<string, Driver>();
  private readonly rings = new Map<string, UnifiedEvent[]>();
  private readonly commands = new Map<string, UnifiedCommand[]>();
  private readonly listeners = new Set<(event: UnifiedEvent) => void>();
  private readonly restartingSessions = new Set<string>();
  private readonly checkingSessions = new Set<string>();
  /** 发过消息的会话：Claude 原生存档要到首条消息后才落盘，没发过的切换配置时不能续接 */
  private readonly promptedSessions = new Set<string>();
  private readonly nativeMarks = new Map<string, NativeConversationMark>();
  private readonly pendingMarkReads = new Map<string, Promise<void>>();
  /** 未决审批闸门（requestId 集合）：释放 worker 的前提是没有待处理闸门 */
  private readonly pendingGates = new Map<string, Set<string>>();

  constructor(
    private readonly driverFactory: DriverFactory = createDriver,
    private readonly claudeSettingsResolver: ClaudeSettingsResolver = readClaudeEffectiveSettings,
    private readonly snapshotCreator: SnapshotCreator = createSnapshotIfNeeded,
    private readonly nativeReader: NativeConversationReader = new NativeConversationReader(),
  ) {
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
        // 重启后所有会话都是 dead，已释放标记随之失效（否则前端会误显示「下次发送自动续接」）
        released: undefined,
        backgroundTasks: undefined,
        seq,
        processId: undefined,
        ...(stored.agent === "claude" ? { remoteControl: { status: "disconnected" as const } } : {}),
        config,
        model: stored.agent === "claude" && stored.model !== undefined ? stored.model : config.model,
        effort: stored.agent === "claude" && stored.effort !== undefined ? stored.effort : config.effort,
        permissionMode: config.permissionMode,
        riskyMode: isRiskyConfig(stored.agent, config),
      });
      this.rings.set(stored.id, events.slice(-RING_SIZE));
      this.commands.set(stored.id, []);
      this.pendingGates.set(stored.id, pendingGatesFrom(events));
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
    const cwd = resolve(input.cwd);
    const claudeSettings = input.agent === "claude"
      ? this.claudeSettingsResolver(cwd)
      : undefined;
    const record: SessionRecord = {
      id,
      agent: input.agent,
      agentId: input.agentId || "main",
      cwd,
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
          ...(input.historyCursor ? { historyCursor: input.historyCursor } : {}),
        },
      } : {}),
      model: config.model,
      effort: config.effort,
      ...(claudeSettings ? claudeEffectiveFields(config, claudeSettings) : {}),
      permissionMode: config.permissionMode,
      config,
      riskyMode: isRiskyConfig(input.agent, config),
      ...(input.agent === "claude" ? { remoteControl: { status: "disconnected" as const } } : {}),
    };
    this.sessions.set(id, record);
    this.rings.set(id, []);
    this.commands.set(id, []);
    this.pendingGates.set(id, new Set());
    this.persistRegistry();
    this.emit(id, "session_created", {
      agent: input.agent,
      cwd: record.cwd,
      resumedNativeSessionId: input.resumeSessionId,
      resumedFrom: record.resumedFrom,
      config: record.config,
      ...this.claudeEffectivePayload(record),
      riskyMode: record.riskyMode,
    });

    if ((input.snapshot ?? "auto") === "auto") {
      try {
        const snapshotPath = await this.snapshotCreator(record.cwd);
        if (snapshotPath) {
          record.snapshotPath = snapshotPath;
          this.persistRegistry();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("warn", "session snapshot failed; continuing startup", {
          sessionId: id,
          cwd: record.cwd,
          errorMessage: message,
        });
        this.emit(id, "session_error", {
          message: `自动快照失败，会话仍将继续创建：${message}`,
          source: "snapshot",
          severity: "warning",
          nonBlocking: true,
        });
      }
    }

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
      await this.captureNativeMark(id);
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
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    if (this.checkingSessions.has(id)) throw new Error("正在检查原生会话，请稍候再发送消息");
    this.checkingSessions.add(id);
    try {
      // idle 会话发送前：已释放的先拉起 worker，活着的比对原生指纹（详见 refreshBeforeSend）
      if (record.status === "idle") await this.refreshBeforeSend(id);
      const worker = this.requireWorker(id);
      const message = this.normalizeUserMessage(id, input);
      await worker.sendUserMessage(message);
      this.promptedSessions.add(id);
      this.emit(id, "user_message", {
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.command ? { command: message.command } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
      });
    } finally {
      this.checkingSessions.delete(id);
    }
  }

  async setRemoteControl(id: string, enabled: boolean): Promise<RemoteControlState> {
    const session = this.sessions.get(id);
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持 Remote Control");
    if (this.restartingSessions.has(id)) throw new Error("Claude worker 正在重启");
    const worker = await this.ensureWorker(id);
    if (!worker.setRemoteControl) throw new Error("Claude driver 不支持 Remote Control");
    return worker.setRemoteControl(enabled);
  }

  async resolvePermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    this.requireLiveWorker(id);
    const worker = this.requireWorker(id);
    await worker.resolvePermission(requestId, decision, updatedInput, questionAnswers);
    this.emit(id, "permission_resolved", {
      requestId,
      decision,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(questionAnswers !== undefined ? { questionAnswers } : {}),
    });
  }

  async setConfig(id: string, config: SessionConfig): Promise<SessionRecord> {
    const entries = Object.entries(config).filter((entry): entry is [keyof SessionConfig, string | null] => (
      entry[1] === null || (typeof entry[1] === "string" && entry[1].length > 0)
    ));
    if (entries.length === 0) throw new Error("set_config.config 至少包含一个配置项");
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候");
    if (this.checkingSessions.has(id)) throw new Error("正在检查原生会话，请稍候再切换配置");
    const worker = await this.ensureWorker(id);
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
    this.emit(id, "config_updated", this.configUpdatedPayload(record, {
      effectiveFrom: record.agent === "codex" ? "next_turn" : "immediate",
    }));
    return cloneSession(record);
  }

  async interrupt(id: string): Promise<void> {
    this.requireLiveWorker(id);
    await this.requireWorker(id).interrupt();
  }

  async remove(id: string): Promise<SessionRecord | undefined> {
    if (this.checkingSessions.has(id) || this.restartingSessions.has(id)) {
      throw new Error("会话正在续接，请稍候再移除");
    }
    const record = this.sessions.get(id);
    if (!record) return undefined;
    const worker = this.workers.get(id);
    if (worker) await worker.stop();
    this.workers.delete(id);
    this.sessions.delete(id);
    this.promptedSessions.delete(id);
    this.nativeMarks.delete(id);
    this.pendingMarkReads.delete(id);
    this.pendingGates.delete(id);
    this.rings.delete(id);
    this.commands.delete(id);
    this.persistRegistry();
    return cloneSession({ ...record, status: "dead", processId: undefined });
  }

  /**
   * 释放会话 worker：停掉进程但保留会话记录（status 保持 idle，released=true 持久化），
   * 下次发送或需要 worker 的操作会按原生会话 id 从磁盘续接（与「别处续聊」同一条路径）。
   * 返回带 cwd 的原生续接命令，供用户去 VSCode/CLI/终端继续。
   */
  async release(
    id: string,
    reason: "manual" | "idle",
    context: { idleMinutes?: number } = {},
  ): Promise<{ session: SessionRecord; resumeCommand: string }> {
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    if (record.released) throw new Error("会话 worker 已释放；下次发送时会自动从磁盘续接");
    const blocker = this.releaseBlocker(id, record);
    if (blocker) throw new Error(blocker);
    const worker = this.workers.get(id)!;
    // 先从 workers 删除再 stop：stop 触发的 exited 回调因 current() 为假直接返回，不会把会话标成 dead
    // 标记先于 await stop()：stop 期间到达的发送走已释放分支（从磁盘续接），而不是报「没有活动 worker」
    this.workers.delete(id);
    record.released = true;
    record.processId = undefined;
    await worker.stop();
    this.setBackgroundTasks(id, []);
    if (record.agent === "claude") {
      record.remoteControl = { status: "disconnected" };
      this.emit(id, "remote_control_updated", { status: "disconnected" });
    }
    this.persistRegistry();
    const resumeCommand = buildResumeCommand(record);
    this.emit(id, "worker_released", {
      reason,
      resumeCommand,
      ...(reason === "idle" && context.idleMinutes !== undefined ? { idleMinutes: context.idleMinutes } : {}),
    });
    return { session: cloneSession(record), resumeCommand };
  }

  /** 自动释放跳过的原因；null 表示可以释放。手动释放把这些原因转成可读错误。 */
  private releaseBlocker(id: string, record: SessionRecord): string | null {
    if (this.restartingSessions.has(id)) return "会话正在切换配置或续接，请稍候";
    if (this.checkingSessions.has(id)) return "会话正在检查原生会话，请稍候";
    if (record.status !== "idle") return `会话当前状态为 ${record.status}，空闲时才能释放`;
    if ((this.pendingGates.get(id)?.size ?? 0) > 0) return "会话有待处理的审批闸门，处理后才能释放";
    // 释放会停掉 worker，连带杀掉它的后台任务（委派的 codex 等）
    if (record.backgroundTasks?.length) return `会话还有 ${record.backgroundTasks.length} 个后台任务在运行，结束后才能释放`;
    if (!record.nativeSessionId) return "会话还没有原生会话 id（首轮完成前），无法释放";
    if (!this.workers.has(id)) return "会话没有活动 worker";
    return null;
  }

  /**
   * 空闲自动释放：每分钟由 server 调用一次。跳过 running/starting、有待处理闸门、
   * 没有原生 id、正在重启/检查中的会话；开着 Remote Control 的 Claude 会话不释放
   * （开 RC 就是要手机能随时找到它，释放会断开）。idleMinutes 为 0 时整体关闭。
   */
  async releaseIdleSessions(idleMinutes: number, now: Date = new Date()): Promise<void> {
    if (!Number.isInteger(idleMinutes) || idleMinutes <= 0) return;
    const thresholdMs = idleMinutes * 60_000;
    for (const record of [...this.sessions.values()]) {
      if (record.released) continue;
      if (this.releaseBlocker(record.id, record)) continue;
      if (now.getTime() - Date.parse(record.lastActivityAt) < thresholdMs) continue;
      if (record.agent === "claude"
        && ["connected", "connecting", "reconnecting"].includes(record.remoteControl?.status ?? "disconnected")) continue;
      try {
        await this.release(record.id, "idle", { idleMinutes });
      } catch (error) {
        log("warn", "idle release failed", {
          sessionId: record.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    this.trackPendingGate(id, event);
    this.persistRegistry();
    for (const listener of this.listeners) listener(event);
    if (type === "turn_completed") {
      const pending = this.captureNativeMark(id);
      this.pendingMarkReads.set(id, pending);
      void pending.finally(() => {
        if (this.pendingMarkReads.get(id) === pending) this.pendingMarkReads.delete(id);
      });
    }
    return event;
  }

  /** 后台任务清单变化时广播；worker 起停时清空（新 worker 不继承旧进程的后台任务）。 */
  private setBackgroundTasks(id: string, tasks: BackgroundTask[]): void {
    const session = this.sessions.get(id);
    if (!session || (!session.backgroundTasks?.length && !tasks.length)) return;
    session.backgroundTasks = tasks;
    this.emit(id, "background_tasks_updated", { tasks });
  }

  private setStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (status === "starting" || status === "dead") this.setBackgroundTasks(id, []);
    session.status = status;
    session.lastActivityAt = new Date().toISOString();
    const pid = this.workers.get(id)?.child?.pid;
    session.processId = status === "dead" ? undefined : pid;
    this.persistRegistry();
  }

  /** 释放前置条件要的未决闸门集合：请求进入、解决移除、进程退出清空。 */
  private trackPendingGate(id: string, event: UnifiedEvent): void {
    if (event.type === "permission_request") {
      const requestId = String(event.payload.requestId ?? "");
      if (!requestId) return;
      const set = this.pendingGates.get(id) ?? new Set<string>();
      set.add(requestId);
      this.pendingGates.set(id, set);
    } else if (event.type === "permission_resolved") {
      this.pendingGates.get(id)?.delete(String(event.payload.requestId ?? ""));
    } else if (event.type === "process_exited") {
      this.pendingGates.get(id)?.clear();
    }
  }

  private applyConfig(session: SessionRecord, update: SessionConfig): void {
    session.config = mergeSessionConfig(session.config, update);
    if (session.agent !== "claude") {
      session.model = session.config.model;
      session.effort = session.config.effort;
    } else {
      const updatesModel = Object.hasOwn(update, "model");
      const updatesEffort = Object.hasOwn(update, "effort");
      const settings = updatesModel || updatesEffort
        ? this.claudeSettingsResolver(session.cwd)
        : undefined;
      if (updatesModel) {
        session.model = session.config.model;
        applyClaudeConfigValue(session, "model", session.config.model, settings!.model);
      }
      if (updatesEffort) {
        session.effort = session.config.effort;
        applyClaudeConfigValue(session, "effort", session.config.effort, settings!.effort);
      }
    }
    session.permissionMode = session.config.permissionMode;
    session.riskyMode = isRiskyConfig(session.agent, session.config);
  }

  private applyEffectiveConfig(session: SessionRecord, update: EffectiveConfigUpdate): void {
    if (update.model) {
      session.effectiveModel = update.model.value;
      session.effectiveModelSource = update.model.source;
      session.model = update.model.value;
    }
    if (update.effort) {
      session.effectiveEffort = update.effort.value;
      session.effectiveEffortSource = update.effort.source;
      session.effort = update.effort.value;
    }
  }

  private async captureNativeMark(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) return;
    try {
      const mark = await this.nativeReader.capture(record);
      if (mark) this.nativeMarks.set(id, mark);
      else this.warnMissingNativeMark(record, "没有可用的对话指纹");
    } catch (error) {
      this.warnMissingNativeMark(record, error instanceof Error ? error.message : String(error));
    }
  }

  private warnMissingNativeMark(record: SessionRecord, reason: string): void {
    log("warn", "native conversation fingerprint unavailable", {
      sessionId: record.id,
      agent: record.agent,
      nativeSessionId: record.nativeSessionId,
      reason,
    });
  }

  /**
   * idle 会话发送前的共用续接逻辑（已释放会话与「别处续聊」走同一条路径）：
   * 比对原生记录指纹；需要续接时（检测到外部新消息，或 worker 已释放必须重建）
   * 起新进程以同一原生 ID 续接，有外部新消息时先广播 external_messages_added。
   * 已释放会话没有旧 worker 可停；指纹缺失/比对失败时活会话照常发送，已释放会话仍必须重建 worker。
   */
  private async refreshBeforeSend(id: string): Promise<void> {
    await this.pendingMarkReads.get(id);
    const record = this.sessions.get(id)!;
    const released = record.released === true;
    const previous = this.nativeMarks.get(id);
    let change: NativeConversationChange | undefined;
    if (!previous) {
      this.warnMissingNativeMark(record, "尚未记录上次同步的对话指纹");
      if (!released) return;
    } else {
      try {
        change = await this.nativeReader.changed(record, previous);
      } catch (error) {
        this.warnMissingNativeMark(record, error instanceof Error ? error.message : String(error));
        if (!released) return;
      }
    }
    if (!released) {
      if (!change) return;
      if (change.messages.length === 0) {
        // Only our previous assistant reply was flushed late. Keep the live worker.
        this.nativeMarks.set(id, change.mark);
        return;
      }
    }
    const nativeSessionId = record.nativeSessionId;
    if (!nativeSessionId) {
      this.warnMissingNativeMark(record, "原生会话 ID 缺失");
      if (released) throw new Error("会话已释放且缺少原生会话 ID，无法续接");
      return;
    }
    const oldWorker = this.workers.get(id) ?? null;
    this.restartingSessions.add(id);
    this.setStatus(id, "starting");
    this.workers.delete(id);
    try {
      const replacement = await this.replaceWorker(id, oldWorker, record.config, nativeSessionId);
      record.processId = replacement.child?.pid;
      if (change) this.nativeMarks.set(id, change.mark);
      else await this.captureNativeMark(id);
      if (released) {
        delete record.released;
        this.setStatus(id, "idle");
      }
      if (change && change.messages.length > 0) {
        this.emit(id, "external_messages_added", {
          nativeSessionId,
          messages: change.messages,
          truncated: change.truncated,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = released
        ? `会话已释放，重新续接失败；本轮未发送：${detail}`
        : `检测到别处续聊，但重新续接失败；本轮未发送：${detail}`;
      this.emit(id, "session_error", { message, source: "external_resume" });
      // 已释放会话失败时保持 released 与 idle（下次发送可再试），不标 dead
      this.setStatus(id, released ? "idle" : "error");
      throw new Error(message);
    } finally {
      this.restartingSessions.delete(id);
    }
  }

  /**
   * 需要 worker 的操作（setConfig / setRemoteControl 等）统一入口：
   * 活 worker 直接返回；已释放会话先按 refreshBeforeSend 的外部续接路径拉起再返回。
   */
  private async ensureWorker(id: string): Promise<Driver> {
    const existing = this.workers.get(id);
    if (existing) return existing;
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    // 只有 idle 的 released 会话可以原地拉起；server 重启后载入的 dead 会话只能新建续接
    if (!record.released || record.status !== "idle") return this.requireWorker(id);
    if (this.restartingSessions.has(id)) throw new Error("会话正在续接，请稍候");
    await this.refreshBeforeSend(id);
    return this.requireWorker(id);
  }

  /** interrupt / resolvePermission 不触发续接：已释放会话直接报可读错误。 */
  private requireLiveWorker(id: string): void {
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    if (record.released) throw new Error("会话 worker 已释放；发送消息时会自动从磁盘续接");
  }

  private async replaceWorker(
    id: string,
    oldWorker: Driver | null,
    config: SessionConfig,
    nativeSessionId?: string,
  ): Promise<Driver> {
    await oldWorker?.stop();
    const record = this.sessions.get(id)!;
    let replacement!: Driver;
    const callbacks = this.driverCallbacks(id, () => replacement);
    replacement = this.driverFactory(record.agent, {
      sessionId: id,
      cwd: record.cwd,
      config,
      resumeSessionId: nativeSessionId,
      callbacks,
    });
    const restoreRemote = record.agent === "claude"
      && ["connected", "reconnecting", "connecting"].includes(record.remoteControl?.status ?? "")
      && !this.claudeSettingsResolver(record.cwd).remoteControlAtStartup;
    this.workers.set(id, replacement);
    if (record.agent === "claude") {
      record.remoteControl = { status: "disconnected" };
      this.emit(id, "remote_control_updated", { ...record.remoteControl });
    }
    try {
      await replacement.start();
      if (restoreRemote) await replacement.setRemoteControl?.(true);
      return replacement;
    } catch (error) {
      if (this.workers.get(id) === replacement) this.workers.delete(id);
      await replacement.stop().catch(() => undefined);
      throw error;
    }
  }

  private async restartClaudeWorker(id: string, update: SessionConfig): Promise<SessionRecord> {
    const record = this.sessions.get(id)!;
    if (record.status === "running") {
      throw new Error("当前回合尚未结束，请等待或中断后再切换");
    }
    // claude 2.1.281 起首条消息前就会报 session_id，但原生存档此时还没落盘，续接必然报
    // No conversation found；所以没发过消息（也不是导入历史）的会话直接按新配置开新 worker。
    const resume = Boolean(record.resumedFrom) || this.promptedSessions.has(id);
    if (resume && !record.nativeSessionId) {
      throw new Error("Claude 首轮完成前尚无 nativeSessionId，无法通过续接切换模型或推理强度");
    }
    if (record.status !== "idle") {
      throw new Error(`Claude 会话当前状态为 ${record.status}，只能在回合结束后切换`);
    }

    const previousState = cloneSession(record);
    const previousConfig = { ...record.config };
    const targetConfig = mergeSessionConfig(previousConfig, update);
    const nativeSessionId = resume ? record.nativeSessionId : undefined;
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

    try {
      if (!resume) record.nativeSessionId = undefined;
      const nextWorker = await this.replaceWorker(id, oldWorker, targetConfig, nativeSessionId);
      record.processId = nextWorker.child?.pid;
      this.persistRegistry();
      this.emit(id, "config_updated", this.configUpdatedPayload(record, {
        effectiveFrom: "immediate",
        mutableVia: "restart",
        workerRestarted: true,
        nativeSessionId: record.nativeSessionId,
      }));
      return cloneSession(record);
    } catch (error) {
      record.config = { ...previousState.config };
      record.model = previousState.model;
      record.effort = previousState.effort;
      record.effectiveModel = previousState.effectiveModel;
      record.effectiveEffort = previousState.effectiveEffort;
      record.effectiveModelSource = previousState.effectiveModelSource;
      record.effectiveEffortSource = previousState.effectiveEffortSource;
      record.permissionMode = previousState.permissionMode;
      record.riskyMode = previousState.riskyMode;
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
      emit: (type, payload = {}) => {
        if (!current()) return undefined;
        const session = this.sessions.get(id);
        return this.emit(
          id,
          type,
          type === "config_updated" && session
            ? this.configUpdatedPayload(session, payload)
            : payload,
        );
      },
      metadata: (metadata) => {
        const session = this.sessions.get(id);
        if (!session || !current()) return;
        if (metadata.nativeSessionId) session.nativeSessionId = metadata.nativeSessionId;
        if (metadata.nativeTranscriptPath) session.nativeTranscriptPath = metadata.nativeTranscriptPath;
        if (metadata.config) this.applyConfig(session, metadata.config);
        if (metadata.effectiveConfig) this.applyEffectiveConfig(session, metadata.effectiveConfig);
        if (metadata.remoteControl) {
          session.remoteControl = metadata.remoteControl;
          this.emit(id, "remote_control_updated", { ...metadata.remoteControl });
        }
        if (metadata.backgroundTasks) this.setBackgroundTasks(id, metadata.backgroundTasks);
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
        const session = this.sessions.get(id);
        if (session?.agent === "claude") {
          session.remoteControl = { status: "disconnected" };
          this.emit(id, "remote_control_updated", { status: "disconnected" });
        }
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
      if (mention.type === "image") {
        if (!IMAGE_MENTION_MIME_TYPES.has(mention.mimeType)) {
          throw new Error(`图片附件 mimeType 不支持：${mention.mimeType}（仅 png/jpeg/gif/webp）`);
        }
        if (stats.size > MAX_IMAGE_MENTION_BYTES) {
          throw new Error(`图片附件超过 10 MB 上限：${path}`);
        }
        return {
          type: "image" as const,
          path,
          mimeType: mention.mimeType,
          ...(mention.name ? { name: mention.name } : {}),
        };
      }
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

  private claudeEffectivePayload(session: SessionRecord): Record<string, unknown> {
    if (session.agent !== "claude") return {};
    return {
      effectiveModel: session.effectiveModel ?? null,
      effectiveEffort: session.effectiveEffort ?? null,
      effectiveModelSource: session.effectiveModelSource ?? null,
      effectiveEffortSource: session.effectiveEffortSource ?? null,
    };
  }

  private configUpdatedPayload(
    session: SessionRecord,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      config: { ...session.config },
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      riskyMode: session.riskyMode,
      ...this.claudeEffectivePayload(session),
      ...payload,
    };
  }
}

function claudeEffectiveFields(
  config: SessionConfig,
  settings: ClaudeEffectiveSettings,
): Pick<
  SessionRecord,
  "effectiveModel" | "effectiveEffort" | "effectiveModelSource" | "effectiveEffortSource"
> {
  const modelIsOverridden = typeof config.model === "string" && config.model.length > 0;
  const effortIsOverridden = typeof config.effort === "string" && config.effort.length > 0;
  return {
    effectiveModel: modelIsOverridden ? config.model! : settings.model,
    effectiveEffort: effortIsOverridden ? config.effort! : settings.effort,
    effectiveModelSource: modelIsOverridden ? "session" : settings.model === null ? null : "settings",
    effectiveEffortSource: effortIsOverridden ? "session" : settings.effort === null ? null : "settings",
  };
}

function applyClaudeConfigValue(
  session: SessionRecord,
  key: "model" | "effort",
  override: string | null | undefined,
  setting: string | null,
): void {
  const overridden = typeof override === "string" && override.length > 0;
  const value = overridden ? override : setting;
  const source = overridden ? "session" : setting === null ? null : "settings";
  if (key === "model") {
    session.effectiveModel = value;
    session.effectiveModelSource = source;
  } else {
    session.effectiveEffort = value;
    session.effectiveEffortSource = source;
  }
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    config: { ...session.config },
    ...(session.resumedFrom ? { resumedFrom: { ...session.resumedFrom } } : {}),
  };
}

/** 从既有 transcript 重建未决闸门集合（启动加载注册表时用）。 */
function pendingGatesFrom(events: UnifiedEvent[]): Set<string> {
  const gates = new Set<string>();
  for (const event of events) {
    if (event.type === "permission_request") {
      const requestId = String(event.payload.requestId ?? "");
      if (requestId) gates.add(requestId);
    } else if (event.type === "permission_resolved") {
      gates.delete(String(event.payload.requestId ?? ""));
    } else if (event.type === "process_exited") {
      gates.clear();
    }
  }
  return gates;
}

/** 带 cwd 的原生续接命令；cwd 做 shell 单引号转义（' → '\''）。 */
function buildResumeCommand(record: SessionRecord): string {
  const cwd = `'${record.cwd.replace(/'/g, `'\\''`)}'`;
  const nativeId = record.nativeSessionId ?? "";
  if (record.agent === "claude") return `cd ${cwd} && claude --resume ${nativeId}`;
  if (record.agent === "codex") return `cd ${cwd} && codex resume ${nativeId}`;
  return `cd ${cwd} && kimi -S ${nativeId}`;
}
