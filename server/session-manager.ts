import { sessionTitle } from "../shared/session-title.js";
import { configOptionsForModel } from "../shared/model-config.js";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readClaudeEffectiveSettings, type ClaudeEffectiveSettings } from "./claude-settings.js";
import { ClaudePlugins, type ClaudePlugin } from "./claude-plugins.js";
import { createDriver, DRIVER_CAPABILITIES } from "./drivers/index.js";
import { CLAUDE_CONFIG_SCHEMA } from "./drivers/claude.js";
import { CodexDriver } from "./drivers/codex.js";
import { log } from "./logger.js";
import { NativeConversationReader, type NativeConversationChange, type NativeConversationMark } from "./native-conversation.js";
import { deleteNativeSession, validateNativeDelete } from "./native-session-delete.js";
import {
  cleanSessionConfig,
  configFromCreateInput,
  isRiskyConfig,
  mergeSessionConfig,
} from "./session-config.js";
import {
  appendTranscript,
  deleteSessionFiles,
  loadRegistry,
  loadSessionGroups,
  readTranscript,
  readTranscriptState,
  compactClaudeTranscripts,
  saveRegistry,
  saveSessionGroups,
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
  SessionGroup,
  SessionStatus,
  RemoteControlState,
  UnifiedCommand,
  UnifiedEvent,
  UserMessageInput,
} from "./types.js";
import { ulid } from "./ulid.js";
import { menuSettingsFiles, withMenuFileUris, type McpAction, type SideQuestionInput } from "./session-menu.js";
import { parseCodexCommand } from "./codex-commands.js";
import { selectEventPage, snapshotState, type EventPage } from "./event-pages.js";
import { captureWorkerIdentity, oldWorkerGone, readSystemBootTime } from "./worker-process.js";
import { hasTerminalWorkerEvidence, rebootProvesWorkerGone } from "./session-recovery.js";
import { parseGroupName, parseOrganizationPatch, SessionOrganizationError, type SessionOrganizationFrame } from "./session-organization.js";

const RING_SIZE = 1_000;
type DriverFactory = typeof createDriver;
type ClaudeSettingsResolver = (cwd: string) => ClaudeEffectiveSettings;
type SnapshotCreator = (cwd: string) => Promise<string | null>;

/** GET /api/sessions/:id/info/:kind 的 kind → Claude control_request subtype */
const SESSION_INFO_SUBTYPES: Record<string, string> = {
  capabilities: "menu_capabilities",
  mcp: "mcp_status",
  hooks: "get_hooks_listing",
  permissions: "list_permission_rules",
  context: "get_context_usage",
  status: "get_status",
  memory: "get_memory_dialog",
  instructions: "get_memory_dialog",
  skills: "get_skills_dialog",
  sandbox: "get_sandbox_dialog",
  usage: "get_usage",
  export: "export_conversation",
  output: "initialize",
};

export class SessionBusyError extends Error {}

export class SessionManager {
  private readonly thinkingUpdates = new Set<string>();
  private readonly sideQuestions = new Set<string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workers = new Map<string, Driver>();
  private readonly damagedTranscripts = new Set<string>();
  private readonly releases = new Map<string, Promise<unknown>>();
  private readonly rings = new Map<string, UnifiedEvent[]>();
  private readonly commands = new Map<string, UnifiedCommand[]>();
  private readonly listeners = new Set<(event: UnifiedEvent) => void>();
  private readonly organizationListeners = new Set<(frame: SessionOrganizationFrame) => void>();
  private readonly groups = new Map<string, SessionGroup>();
  private readonly restartingSessions = new Set<string>();
  /** 新建会话的后台启动：create 不等 CLI 握手（约 2–5 秒）就返回，发送消息时再等它。 */
  private readonly startups = new Map<string, Promise<void>>();
  /** 移除会话时在后台停的进程；shutdown 要等它们，免得退出时留下孤儿 CLI。 */
  private readonly backgroundStops = new Set<Promise<void>>();
  private readonly checkingSessions = new Set<string>();
  private readonly deletingSessions = new Set<string>();
  /** 同会话的原生检查/恢复共享一个在途任务，避免并发菜单操作重复起 worker。 */
  private readonly nativeRefreshes = new Map<string, Promise<void>>();
  /** 发过消息的会话：Claude 原生存档要到首条消息后才落盘，没发过的切换配置时不能续接 */
  private readonly promptedSessions = new Set<string>();
  private readonly nativeMarks = new Map<string, NativeConversationMark>();
  private readonly pendingMarkReads = new Map<string, Promise<void>>();
  /** 未决审批闸门（requestId 集合）：释放 worker 的前提是没有待处理闸门 */
  private readonly pendingGates = new Map<string, Set<string>>();
  /** shutdown 开始后不再起新 worker（否则停服期间的发送会拉起一个 shutdown 管不到的进程） */
  private stopping = false;
  private registryDirty = false;
  private registryTimer?: ReturnType<typeof setTimeout>;
  private readonly titles = new Map<string, string>();
  private readonly partialUpdates = new Map<string, Map<string, {
    lastSent: number; payload?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout>;
  }>>();

  constructor(
    private readonly driverFactory: DriverFactory = createDriver,
    private readonly claudeSettingsResolver: ClaudeSettingsResolver = readClaudeEffectiveSettings,
    private readonly snapshotCreator: SnapshotCreator = createSnapshotIfNeeded,
    private readonly nativeReader: NativeConversationReader = new NativeConversationReader(),
    private readonly claudePlugins: ClaudePlugins = new ClaudePlugins(),
    private readonly systemBootTimeResolver: () => number | undefined = readSystemBootTime,
  ) {
    for (const group of loadSessionGroups()) this.groups.set(group.id, group);
    const systemBootTime = this.systemBootTimeResolver();
    const loaded = loadRegistry();
    log("info", "legacy Claude transcript updates compacted", compactClaudeTranscripts(loaded));
    for (const stored of loaded) {
      let recovered: ReturnType<typeof readTranscriptState>;
      try { recovered = readTranscriptState(stored.transcriptPath); } catch (error) {
        log("error", "transcript recovery failed", { sessionId: stored.id, file: stored.transcriptPath, message: String(error) });
        recovered = { events: [], damaged: true, incompleteTail: false };
      }
      const { events } = recovered;
      if (recovered.damaged) this.damagedTranscripts.add(stored.id);
      const seq = events.at(-1)?.seq ?? stored.seq ?? 0;
      const config = cleanSessionConfig(stored.config ?? {
        model: stored.model,
        effort: stored.effort,
        permissionMode: stored.permissionMode,
      });
      const gates = pendingGatesFrom(events);
      // 已释放记录沿用原行为。异常退出只有在 transcript 完整、存档可续接且旧 worker
      // 确已退出时才能走同一路径；真实 CLI exited、未决审批与身份不明的记录保持 dead。
      const crashRevivable = !stored.released && !recovered.damaged && !recovered.incompleteTail
        && Boolean(stored.nativeSessionId) && gates.size === 0 && !hasTerminalWorkerEvidence(events)
        && ((["idle", "running", "starting"].includes(stored.status) && oldWorkerGone(stored))
          // 旧代码已把记录写成 dead 并清掉 PID 时，只有较晚的系统启动能证明全部旧进程消失。
          || (stored.status === "dead" && rebootProvesWorkerGone(stored, events, systemBootTime)))
        && this.nativeReader.hasArchive(stored);
      const revivable = (stored.released === true && Boolean(stored.nativeSessionId)) || crashRevivable;
      if (revivable) {
        if (stored.releasedMark) this.nativeMarks.set(stored.id, stored.releasedMark);
        // 能被释放的 Claude 会话都已有原生存档（见 shutdown），切换配置时要按续接重启
        this.promptedSessions.add(stored.id);
      }
      this.sessions.set(stored.id, {
        ...stored,
        status: recovered.damaged || recovered.incompleteTail ? "error" : revivable ? "idle" : "dead",
        released: revivable ? true : undefined,
        releasedMark: undefined,
        backgroundTasks: undefined,
        seq,
        processId: undefined,
        processIdentity: undefined,
        ...(stored.agent === "claude" ? { remoteControl: { status: "disconnected" as const } } : {}),
        config,
        model: stored.agent === "claude" && stored.model !== undefined ? stored.model : config.model,
        effort: stored.agent === "claude" && stored.effort !== undefined ? stored.effort : config.effort,
        permissionMode: config.permissionMode,
        riskyMode: isRiskyConfig(stored.agent, config),
      });
      this.rings.set(stored.id, events.slice(-RING_SIZE));
      // 还没有首条消息的会话不设标题，否则首条 user_message 到来时 titles.has 已为真、标题卡在「新会话」
      if (events.some((event) => event.type === "user_message")) this.titles.set(stored.id, sessionTitle({}, events));
      const lastCommands = [...events].reverse().find((event) => event.type === "commands_updated");
      this.commands.set(stored.id, (lastCommands?.payload.commands as UnifiedCommand[] | undefined) ?? []);
      this.pendingGates.set(stored.id, gates);
    }
    if (loaded.length > 0) this.persistRegistry();
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...cloneSession(session),
        title: sessionTitle({ ...session, title: this.titles.get(session.id) ?? "新会话" }, undefined),
        pendingGateCount: session.status === "dead" ? 0 : this.pendingGates.get(session.id)?.size ?? 0,
      }))
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  get(id: string): SessionRecord | undefined {
    const session = this.sessions.get(id);
    return session ? { ...cloneSession(session), title: sessionTitle({ ...session, title: this.titles.get(id) ?? "新会话" }, undefined) } : undefined;
  }

  listGroups(): SessionGroup[] { return [...this.groups.values()].map((group) => ({ ...group })); }

  onOrganizationUpdated(listener: (frame: SessionOrganizationFrame) => void): () => void {
    this.organizationListeners.add(listener);
    return () => this.organizationListeners.delete(listener);
  }

  updateOrganization(id: string, value: unknown): SessionRecord {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session) throw new SessionOrganizationError(`会话不存在：${id}`, 404, 40401);
    const patch = parseOrganizationPatch(value);
    if (patch.groupId && !this.groups.has(patch.groupId)) throw new SessionOrganizationError(`分组不存在：${patch.groupId}`);
    if (patch.pinned !== undefined) session.pinned = patch.pinned;
    if (patch.customTitle !== undefined) {
      if (patch.customTitle) session.customTitle = patch.customTitle;
      else delete session.customTitle;
      const worker = this.workers.get(id);
      if (patch.customTitle && worker instanceof CodexDriver) worker.cancelAutomaticTitle();
    }
    if (patch.groupId !== undefined) {
      if (patch.groupId) session.groupId = patch.groupId;
      else delete session.groupId;
    }
    this.persistRegistry();
    this.organizationUpdated();
    return this.get(id)!;
  }

  createGroup(value: unknown): SessionGroup {
    const group = { id: ulid(), name: parseGroupName(value), createdAt: new Date().toISOString() };
    this.groups.set(group.id, group);
    saveSessionGroups(this.listGroups());
    this.organizationUpdated();
    return { ...group };
  }

  renameGroup(id: string, value: unknown): SessionGroup {
    const group = this.groups.get(id);
    if (!group) throw new SessionOrganizationError(`分组不存在：${id}`, 404, 40471);
    group.name = parseGroupName(value);
    saveSessionGroups(this.listGroups());
    this.organizationUpdated();
    return { ...group };
  }

  removeGroup(id: string): void {
    if (!this.groups.has(id)) throw new SessionOrganizationError(`分组不存在：${id}`, 404, 40471);
    for (const session of this.sessions.values()) if (session.groupId === id) delete session.groupId;
    // 先持久化成员回归，再删除分组；中途退出最多留下空组，不会留下未知 groupId。
    this.persistRegistry();
    this.groups.delete(id);
    saveSessionGroups(this.listGroups());
    this.organizationUpdated();
  }

  private organizationUpdated(): void {
    const frame: SessionOrganizationFrame = { type: "session_organization_updated", sessions: this.list(), groups: this.listGroups() };
    for (const listener of this.organizationListeners) listener(frame);
  }

  /** 批量存储清理只移除真正结束、没有审批闸门或续接操作的会话。 */
  isEndedSessionRemovable(id: string): boolean {
    return this.sessions.get(id)?.status === "dead"
      && !this.pendingGates.get(id)?.size
      && !this.checkingSessions.has(id) && !this.restartingSessions.has(id);
  }

  getCommands(id: string): UnifiedCommand[] | undefined {
    if (!this.sessions.has(id)) return undefined;
    return (this.commands.get(id) ?? []).map((command) => ({ ...command }));
  }

  getSnapshot(id: string, tail = false): { session: SessionRecord; seq: number; events: UnifiedEvent[]; hasMore?: boolean; firstSeq?: number } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const events = readTranscript(session.transcriptPath);
    if (!tail) return { session: this.get(id)!, seq: session.seq, events };
    return {
      session: { ...cloneSession(session), title: sessionTitle({ ...session, title: this.titles.get(id) ?? sessionTitle({}, events) }, undefined), snapshotState: snapshotState(events) },
      seq: session.seq,
      ...selectEventPage(events),
    };
  }

  getEventsBefore(id: string, beforeSeq: number): EventPage | undefined {
    const session = this.sessions.get(id);
    return session ? selectEventPage(readTranscript(session.transcriptPath), beforeSeq) : undefined;
  }

  getEventsAfter(id: string, afterSeq: number): { events: UnifiedEvent[]; requiresSnapshot: boolean; currentSeq: number } | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const ring = this.rings.get(id) ?? [];
    const oldest = ring[0]?.seq ?? session.seq + 1;
    const events = ring.filter((event) => event.seq > afterSeq);
    const requiresSnapshot = afterSeq < session.seq && (
      afterSeq < oldest - 1
      || events.some((event, index) => event.seq !== afterSeq + index + 1)
      || (events.at(-1)?.seq ?? afterSeq) !== session.seq
    );
    return {
      events: requiresSnapshot ? [] : events,
      requiresSnapshot,
      currentSeq: session.seq,
    };
  }

  onEvent(listener: (event: UnifiedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    if (input.resumeSessionId && [...this.sessions.values()].some(record => record.agent === input.agent
      && record.nativeSessionId === input.resumeSessionId && this.deletingSessions.has(record.id))) {
      throw new SessionBusyError("原生会话正在彻底删除，无法续接。");
    }
    if (this.stopping) throw new Error("Workbench 正在退出");
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

    // 默认不快照（P1-8）：只有显式传 "auto" 才做；续接等未传该字段的入口一并跳过
    if (input.snapshot === "auto") {
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
    if (record.customTitle && worker instanceof CodexDriver) worker.cancelAutomaticTitle();
    this.workers.set(id, worker);
    const startup = (async () => {
      try {
        await worker.start();
        if (this.workers.get(id) !== worker) return; // 启动期间已被移除或关停，收尾交给它们
        this.trackWorkerProcess(record, worker);
        this.persistRegistry();
        if (!input.resumeSessionId) await this.captureNativeMark(id);
      } catch (error) {
        if (this.workers.get(id) !== worker) throw error;
        // 先摘 worker，stop 触发的 exited 回调就不会把 error 改成 dead
        this.workers.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        this.emit(id, "session_error", { message, source: "startup" });
        this.setStatus(id, "error");
        await worker.stop().catch(() => undefined);
        throw error;
      } finally {
        this.startups.delete(id);
      }
    })();
    this.startups.set(id, startup);
    // 启动失败已作为 session_error 广播；这里只防止未处理的 rejection。
    startup.catch(() => undefined);
    // 续接会话的指纹在返回前取（原生记录已存在，只读文件）：否则 create 返回后、握手完成前别处写入的新消息会被并进指纹而漏检。
    if (input.resumeSessionId) await this.captureNativeMark(id);
    if (input.initialMessage) {
      const text = input.initialMessage;
      void this.sendUserMessage(id, { text }).catch((error) => {
        this.emit(id, "session_error", { message: error instanceof Error ? error.message : String(error), source: "initial_message" });
      });
    }
    return cloneSession(record);
  }

  async sendUserMessage(id: string, input: UserMessageInput): Promise<void> {
    this.assertWritableTranscript(id);
    if (this.sessions.get(id)?.agent === "codex" && input.command) {
      if (input.text || input.mentions?.length) throw new Error("Codex 命令不能附带文本或附件");
      const result = await this.executeCodexCommand(id, input.command);
      this.emit(id, "raw_event", { source: "codex-command", command: input.command, result });
      return;
    }
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候再发送消息");
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    // 刚新建、CLI 还在后台启动：等它就绪再发（启动失败则把错误报给发送方）
    const startup = this.startups.get(id);
    if (startup) await startup;
    if (this.pendingGates.get(id)?.size) throw new Error("会话有待处理的审批闸门，处理后才能发送或插话");
    if (this.checkingSessions.has(id)) throw new Error("正在检查原生会话，请稍候再发送消息");
    this.checkingSessions.add(id);
    try {
      // idle 会话发送前：已释放的先拉起 worker，活着的比对原生指纹（详见 refreshBeforeSend）
      if (record.status === "idle" || record.released) await this.refreshBeforeSend(id);
      const worker = this.requireWorker(id);
      const message = this.normalizeUserMessage(id, input);
      const steer = record.status === "running";
      if (record.status === "starting") throw new Error("会话正在启动，请稍候再发送消息");
      const receipt = await worker.sendUserMessage(message, { steer });
      this.promptedSessions.add(id);
      this.emit(id, "user_message", {
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.command ? { command: message.command } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        ...(steer ? { steer: true } : {}),
        ...(receipt?.queued ? { queued: true } : {}),
      });
    } finally {
      this.checkingSessions.delete(id);
    }
  }

  async setRemoteControl(id: string, enabled: boolean): Promise<RemoteControlState> {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持 Remote Control");
    if (this.restartingSessions.has(id)) throw new Error("Claude worker 正在重启");
    const worker = await this.ensureWorker(id);
    if (!worker.setRemoteControl) throw new Error("Claude driver 不支持 Remote Control");
    return worker.setRemoteControl(enabled);
  }

  /** 「/」菜单只读查看：kind 映射到 Claude control_request；已释放会话按 ensureWorker 拉起。 */
  async queryInfo(id: string, kind: string): Promise<unknown> {
    const session = this.sessions.get(id);
    if (session?.agent === "codex") {
      if (!["status", "model", "mcp", "skills"].includes(kind)) throw new Error(`未知 Codex 查看项：${kind}`);
      const worker = await this.ensureWorker(id);
      if (!worker.queryInfo) throw new Error("Codex driver 不支持该查看");
      return worker.queryInfo(kind);
    }
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持该查看");
    // 插件列表没有 control_request，与 VSCode 扩展一样跑 CLI；不需要 worker，已结束的会话也能看
    if (kind === "plugins") return { plugins: await this.claudePlugins.list(session.cwd) };
    if (kind === "settings") return { settingsFiles: menuSettingsFiles(session.cwd) };
    const subtype = SESSION_INFO_SUBTYPES[kind];
    if (!subtype) throw new Error(`未知查看项：${kind}`);
    if (this.restartingSessions.has(id)) throw new Error("Claude worker 正在重启");
    const worker = await this.ensureWorker(id);
    if (!worker.queryInfo) throw new Error("Claude driver 不支持该查看");
    const result = await worker.queryInfo(subtype);
    const r = result && typeof result === "object" ? result as Record<string, unknown> : {};
    if (["hooks", "permissions", "sandbox", "skills"].includes(kind)) {
      return { ...r, settingsFiles: menuSettingsFiles(session.cwd) };
    }
    if (kind === "memory" || kind === "instructions") {
      return { ...r, files: withMenuFileUris(r.files), folders: withMenuFileUris(r.folders), memories: withMenuFileUris(r.memories), settingsFiles: menuSettingsFiles(session.cwd) };
    }
    if (kind === "output") {
      const settings = await worker.queryInfo("get_settings") as { effective?: { outputStyle?: string } } | undefined;
      return { outputStyle: settings?.effective?.outputStyle ?? r.output_style, availableStyles: r.available_output_styles, settingsFiles: menuSettingsFiles(session.cwd) };
    }
    // 上下文用量原样约 50KB（终端方格 gridRows、逐个 MCP 工具等），前端只用分类与总数
    if (kind === "context" && result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      return { categories: r.categories, totalTokens: r.totalTokens, maxTokens: r.maxTokens,
        percentage: r.percentage, model: r.model, autoCompactThreshold: r.autoCompactThreshold,
        isAutoCompactEnabled: r.isAutoCompactEnabled };
    }
    return result;
  }

  async executeCodexCommand(id: string, input: unknown): Promise<unknown> {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || session.agent !== "codex") throw new Error("仅 Codex 会话支持该命令");
    const command = parseCodexCommand(input);
    if (["status", "model", "mcp", "skills"].includes(command.name)) return this.queryInfo(id, command.name);
    if (command.name === "interrupt") {
      if (session.status !== "running") throw new Error("当前没有可中断的执行");
      const worker = this.requireWorker(id);
      if (!worker.executeCommand) throw new Error("Codex driver 不支持该命令");
      return worker.executeCommand(command.name);
    }
    if (session.status !== "idle" || this.pendingGates.get(id)?.size
      || this.checkingSessions.has(id) || this.restartingSessions.has(id)) {
      throw new Error("请等当前执行与审批结束后再操作");
    }
    this.checkingSessions.add(id);
    try {
      if (command.name === "new") {
        return { session: await this.create({ agent: "codex", cwd: session.cwd, config: { ...session.config }, snapshot: "skip" }) };
      }
      const worker = await this.ensureWorker(id);
      if (!worker.executeCommand) throw new Error("Codex driver 不支持该命令");
      const result = await worker.executeCommand(command.name, command.arguments);
      this.emit(id, "user_message", { command });
      return result;
    } finally {
      this.checkingSessions.delete(id);
    }
  }

  async manageMcp(id: string, action: McpAction): Promise<unknown> {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持 MCP 管理");
    if (this.restartingSessions.has(id)) throw new Error("Claude worker 正在重启");
    if (session.status === "starting" || this.pendingGates.get(id)?.size) {
      throw new Error("请在启动与审批结束后操作 MCP 服务器");
    }
    const worker = await this.ensureWorker(id);
    if (!worker.manageMcp) throw new Error("Claude driver 不支持 MCP 管理");
    return worker.manageMcp(action);
  }

  async setThinking(id: string, enabled: boolean): Promise<SessionRecord> {
    this.assertWritableTranscript(id);
    const record = this.sessions.get(id);
    if (!record || record.agent !== "claude") throw new Error("仅 Claude 会话支持 Thinking");
    if (record.status === "dead") throw new Error("会话已结束");
    if (this.restartingSessions.has(id) || this.checkingSessions.has(id) || this.thinkingUpdates.has(id)) throw new Error("会话正在切换配置，请稍候");
    this.thinkingUpdates.add(id);
    try {
      await this.startups.get(id);
      const update: SessionConfig = { thinkingLevel: enabled ? "default_on" : "off" };
      // 已释放的会话只存覆盖，下一次续接初始化重发。
      if (!record.released || this.workers.has(id)) {
        const worker = await this.ensureWorker(id);
        await worker.setConfig(update);
      }
      if (this.sessions.get(id) !== record) throw new Error("会话已移除");
      this.applyConfig(record, update);
      this.persistRegistry();
      this.emit(id, "config_updated", this.configUpdatedPayload(record, { effectiveFrom: record.released ? "next_turn" : "immediate" }));
      return cloneSession(record);
    } finally { this.thinkingUpdates.delete(id); }
  }

  async stopTask(id: string, taskId: string): Promise<void> {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持后台任务管理");
    if (this.restartingSessions.has(id) || this.checkingSessions.has(id)) throw new Error("会话正在续接或重启");
    if (!session.backgroundTasks?.some(task => task.id === taskId)) throw new Error("任务不在当前会话运行列表中");
    this.requireLiveWorker(id);
    const worker = this.requireWorker(id);
    if (!worker.stopTask) throw new Error("Claude driver 不支持停止任务");
    await worker.stopTask(taskId);
    // 不伪造任务完成；清单由 background_tasks_changed 元数据更新。
  }

  async askSideQuestion(id: string, input: SideQuestionInput, signal: AbortSignal): Promise<unknown> {
    this.assertWritableTranscript(id);
    if (this.sessions.get(id)?.agent !== "claude") throw new Error("仅 Claude 会话支持侧问");
    if (this.sideQuestions.has(id)) throw new Error("当前侧问尚未结束");
    if (this.restartingSessions.has(id) || this.checkingSessions.has(id)) throw new Error("会话正在续接或重启");
    this.sideQuestions.add(id);
    try {
      await this.startups.get(id);
      const worker = await this.ensureWorker(id);
      if (signal.aborted) throw new Error("请求已取消");
      if (!worker.askSideQuestion) throw new Error("Claude driver 不支持侧问");
      return await worker.askSideQuestion(input, signal);
    } finally { this.sideQuestions.delete(id); }
  }

  async setPluginEnabled(id: string, pluginId: string, enabled: boolean, scope?: unknown): Promise<{
    plugins: ClaudePlugin[];
    reloaded: boolean;
    reloadError?: string;
  }> {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || session.agent !== "claude") throw new Error("仅 Claude 会话支持插件切换");
    await this.claudePlugins.setEnabled(session.cwd, pluginId, enabled, scope);
    // 只通知当前 worker；dead/released 会话不为插件操作拉起进程。
    const worker = this.workers.get(id);
    let reloaded = false;
    let reloadError: string | undefined;
    if (worker?.reloadPlugins && !this.restartingSessions.has(id)) {
      try {
        await worker.reloadPlugins();
        reloaded = true;
      } catch (error) {
        // 设置已经成功落盘，重载失败不能伪装成 CLI 切换失败。
        reloadError = error instanceof Error ? error.message : String(error);
      }
    }
    return { plugins: await this.claudePlugins.list(session.cwd), reloaded, ...(reloadError ? { reloadError } : {}) };
  }

  async resolvePermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void> {
    this.assertWritableTranscript(id);
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
    this.assertWritableTranscript(id);
    if (this.thinkingUpdates.has(id) || this.sideQuestions.has(id)) throw new Error("请等 Thinking 切换或侧问结束后再切换配置");
    const entries = Object.entries(config).filter((entry): entry is [keyof SessionConfig, string | null] => (
      entry[1] === null || (typeof entry[1] === "string" && entry[1].length > 0)
    ));
    if (entries.length === 0) throw new Error("set_config.config 至少包含一个配置项");
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候");
    if (this.checkingSessions.has(id)) throw new Error("正在检查原生会话，请稍候再切换配置");
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    const deferredClaude = entries.some(([key]) => key === "model" || key === "effort") && record.agent === "claude" && record.released && !this.workers.has(id) && record.status === "idle";
    const worker = deferredClaude ? undefined : await this.ensureWorker(id);
    if (this.restartingSessions.has(id)) throw new Error("正在切换模型，请稍候");
    const schema = worker?.getConfigSchema() ?? CLAUDE_CONFIG_SCHEMA;
    const options = configOptionsForModel(schema.options,
      config.model === undefined ? record.config.model : config.model);
    for (const [key, value] of entries) {
      const option = options.find((item) => item.id === key);
      if (!option) throw new Error(`${record.agent} 不支持配置项：${key}`);
      if (!option.mutable) throw new Error(`${record.agent}.${key} 只能在建会话时设置`);
      if (value === null && !option.values.some((item) => item.value === null)) {
        throw new Error(`${record.agent}.${key} 不支持跟随配置`);
      }
      if (!option.values.some((item) => item.value === value)) {
        throw new Error(`${record.agent}.${key} 不支持值：${value}`);
      }
    }
    const update = Object.fromEntries(entries) as SessionConfig;
    const switchesClaude = record.agent === "claude" && entries.some(([key]) => key === "model" || key === "effort");
    if (switchesClaude) {
      if (record.status === "running") throw new Error("当前回合尚未结束，请等待或中断后再切换");
      if (record.status !== "idle" || this.pendingGates.get(id)?.size) {
        throw new Error("请等当前执行与审批结束后再切换模型或推理强度");
      }
    }
    if (switchesClaude) this.restartingSessions.add(id); // 与发送、释放、移除互斥，审批期间不进入热切换。
    try {
      let updated = update;
      if (worker) {
        try { updated = await worker.setConfig(update); }
        catch (error) {
          if (!switchesClaude) throw error;
          log("warn", "Claude hot config failed; restarting worker", { sessionId: id, message: String(error) });
          return await this.restartClaudeWorker(id, update);
        }
      }
      this.applyConfig(record, updated);
      this.persistRegistry();
      this.emit(id, "config_updated", this.configUpdatedPayload(record, {
        effectiveFrom: deferredClaude ? "next_turn" : record.agent === "codex" ? "next_turn" : "immediate",
        ...(switchesClaude ? { mutableVia: "control", workerRestarted: false } : {}),
      }));
      return cloneSession(record);
    } finally {
      if (switchesClaude) this.restartingSessions.delete(id);
    }
  }

  async interrupt(id: string): Promise<void> {
    this.assertWritableTranscript(id);
    this.requireLiveWorker(id);
    await this.requireWorker(id).interrupt();
  }

  async remove(id: string, permanently = false): Promise<SessionRecord | undefined> {
    this.assertWritableTranscript(id);
    if (this.checkingSessions.has(id) || this.restartingSessions.has(id) || this.nativeRefreshes.has(id)) {
      throw new SessionBusyError("会话正在续接，请稍候再移除");
    }
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (permanently) {
      validateNativeDelete(record);
      if (this.stopping || this.startups.has(id) || !["idle", "dead", "error"].includes(record.status)) {
        throw new SessionBusyError("请先停止当前执行，等会话空闲或结束后再彻底删除。");
      }
      if (record.backgroundTasks?.length || this.pendingGates.get(id)?.size
        || this.thinkingUpdates.has(id) || this.sideQuestions.has(id)) {
        throw new SessionBusyError("会话有后台任务、待处理审批或菜单操作，请处理完成后再彻底删除。");
      }
      if ([...this.sessions.values()].some(other => other.id !== id && other.agent === record.agent
        && other.nativeSessionId === record.nativeSessionId)) {
        throw new SessionBusyError("另一条 Workbench 会话引用同一原生历史，请先移除其他引用。");
      }
      this.deletingSessions.add(id);
      try {
        const worker = this.workers.get(id);
        this.workers.delete(id); // Late callbacks cannot write deleted native history back.
        try {
          if (worker) await worker.stop();
          if ((worker?.child && worker.child.exitCode === null && worker.child.signalCode === null)
            || (record.processId && !oldWorkerGone(record))) {
            throw new SessionBusyError("会话进程尚未确认退出，未执行彻底删除。");
          }
        } catch (error) {
          if (worker) this.workers.set(id, worker);
          throw error;
        }
        record.processId = undefined;
        record.processIdentity = undefined;
        record.released = true;
        this.persistRegistry();
        await deleteNativeSession(record);
      } finally { this.deletingSessions.delete(id); }
    }
    const worker = this.workers.get(id);
    // 不等进程退出（Claude 不响应 stdin 关闭，要等满 2 秒兜底）；会话先删，之后的回调因找不到会话而被忽略
    if (worker) {
      const stop: Promise<void> = worker.stop()
        .catch((error) => log("warn", "worker stop after remove failed", { sessionId: id, message: String(error) }))
        .finally(() => this.backgroundStops.delete(stop));
      this.backgroundStops.add(stop);
    }
    this.workers.delete(id);
    this.startups.delete(id);
    this.sessions.delete(id);
    this.promptedSessions.delete(id);
    this.nativeMarks.delete(id);
    this.pendingMarkReads.delete(id);
    this.pendingGates.delete(id);
    this.titles.delete(id);
    const updates = this.partialUpdates.get(id);
    if (updates) for (const update of updates.values()) if (update.timer) clearTimeout(update.timer);
    this.partialUpdates.delete(id);
    this.rings.delete(id);
    this.commands.delete(id);
    this.persistRegistry();
    deleteSessionFiles(record, [...this.sessions.values()]);
    return cloneSession({ ...record, status: "dead", processId: undefined });
  }

  /**
   * 释放会话 worker：停掉进程但保留会话记录（status 保持 idle，released=true 持久化），
   * 下次发送或需要 worker 的操作会按原生会话 id 从磁盘续接（与「别处续聊」同一条路径）。
   * 返回带 cwd 的续接命令和协议链接，供浏览器「VSCode / CLI 继续」。
   */
  async release(
    id: string,
    reason: "manual" | "idle",
    context: { idleMinutes?: number } = {},
  ): Promise<{ session: SessionRecord; resumeCommand: string; vscodeUri: string | null }> {
    if (this.stopping) throw new Error("Workbench 正在退出");
    this.assertWritableTranscript(id);
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    if (record.released) throw new Error("会话 worker 已释放；下次发送时会自动从磁盘续接");
    const blocker = this.releaseBlocker(id, record);
    if (blocker) throw new Error(blocker);
    const worker = this.workers.get(id)!;
    // 先从 workers 删除再 stop：stop 触发的 exited 回调因 current() 为假直接返回，不会把会话标成 dead
    // 标记先于 stop；续接入口等待完整释放操作，旧进程退出前不启动新代。
    this.workers.delete(id);
    record.released = true;
    record.processId = undefined;
    record.processIdentity = undefined;
    const releasing = (async () => {
      try { await worker.stop(); } catch (error) {
        if (this.sessions.get(id) === record && !this.workers.has(id)) {
          this.workers.set(id, worker);
          delete record.released;
          this.trackWorkerProcess(record, worker);
        }
        throw error;
      }
      const resumeCommand = buildResumeCommand(record);
      // 移除会话或新代已接管时，旧操作不得再改生命周期字段。
      if (this.sessions.get(id) === record && !this.workers.has(id)) {
        this.setBackgroundTasks(id, []);
        if (record.agent === "claude") {
          record.remoteControl = { status: "disconnected" };
          this.emit(id, "remote_control_updated", { status: "disconnected" });
        }
        this.persistRegistry();
        this.emit(id, "worker_released", {
          reason, resumeCommand,
          ...(reason === "idle" && context.idleMinutes !== undefined ? { idleMinutes: context.idleMinutes } : {}),
        });
      }
      return { session: cloneSession(record), resumeCommand, vscodeUri: buildVSCodeUri(record) };
    })();
    this.releases.set(id, releasing);
    try { return await releasing; } finally {
      if (this.releases.get(id) === releasing) this.releases.delete(id);
    }
  }

  /** 自动释放跳过的原因；null 表示可以释放。手动释放把这些原因转成可读错误。 */
  private releaseBlocker(id: string, record: SessionRecord): string | null {
    if (this.stopping) return "Workbench 正在退出";
    if (this.damagedTranscripts.has(id)) return "transcript 损坏，禁止释放";
    if (this.thinkingUpdates.has(id) || this.sideQuestions.has(id)) return "会话正在切换 Thinking 或进行侧问，请稍候";
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
    if (this.stopping || !Number.isInteger(idleMinutes) || idleMinutes <= 0) return;
    const thresholdMs = idleMinutes * 60_000;
    for (const record of [...this.sessions.values()]) {
      // 前一个 release 的 await 期间可能开始 shutdown，不能再摘走下一个 worker。
      if (this.stopping) return;
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

  /**
   * 退出 wb：有原生 id、没有待处理闸门的会话按「释放」处理（idle+released 持久化，重启后发送即原地续接），
   * 其余标 dead。先清 workers 再 stop，stop 触发的 exited 回调因 current() 为假直接返回。
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const id of this.partialUpdates.keys()) this.flushPartialUpdates(id);
    await Promise.allSettled(this.pendingMarkReads.values());
    await Promise.allSettled(this.releases.values());
    const running = [...this.workers.entries()];
    this.workers.clear();
    // 先停进程再写释放状态：停不下来的标 dead，免得重启后与旧进程同时续接同一原生会话
    const stopped = await Promise.allSettled(running.map(([, worker]) => worker.stop()));
    await Promise.allSettled([...this.backgroundStops]);
    running.forEach(([id], index) => {
      const record = this.sessions.get(id);
      if (!record || this.damagedTranscripts.has(id)) return;
      record.processId = undefined;
      record.processIdentity = undefined;
      // Claude 首条消息前就报 session_id，但原生存档还没落盘，续接必然失败（同 restartClaudeWorker）
      const hasArchive = record.agent !== "claude" || Boolean(record.resumedFrom) || this.promptedSessions.has(id);
      if (stopped[index]!.status === "fulfilled" && record.nativeSessionId && hasArchive
        && (this.pendingGates.get(id)?.size ?? 0) === 0) {
        record.status = "idle";
        record.released = true;
        record.backgroundTasks = undefined;
        this.emit(id, "worker_released", { reason: "shutdown", resumeCommand: buildResumeCommand(record) });
      } else {
        record.status = "dead";
      }
    });
    for (const record of this.sessions.values()) {
      if (record.released && !this.damagedTranscripts.has(record.id)) record.releasedMark = this.nativeMarks.get(record.id);
    }
    this.persistRegistry();
  }

  private emit(id: string, type: EventType, payload: Record<string, unknown> = {}, ephemeral = false): UnifiedEvent | undefined {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (!ephemeral && (["tool_call_completed", "permission_request", "turn_completed", "session_error", "process_exited"].includes(type)
      || (type === "tool_call_updated" && payload.inputComplete))) this.flushPartialUpdates(id);
    const timestamp = new Date().toISOString();
    const event: UnifiedEvent = {
      type,
      sessionId: id,
      agentId: session.agentId,
      seq: ephemeral ? session.seq : ++session.seq,
      ...(ephemeral ? { ephemeral: true as const } : {}),
      timestamp,
      payload,
    };
    if (ephemeral) {
      for (const listener of this.listeners) listener(event);
      return event;
    }
    if (type === "user_message" && !this.titles.has(id)) this.titles.set(id, sessionTitle({}, [event]));
    if (type === "user_message") event.title = sessionTitle({ ...session, title: this.titles.get(id) });
    session.lastActivityAt = timestamp;
    appendTranscript(session.transcriptPath, event);
    const ring = this.rings.get(id) ?? [];
    ring.push(event);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    this.rings.set(id, ring);
    this.trackPendingGate(id, event);
    if (["config_updated", "session_created", "worker_released", "process_exited"].includes(type)) this.persistRegistry();
    else this.markRegistryDirty();
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
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session || (!session.backgroundTasks?.length && !tasks.length)) return;
    session.backgroundTasks = tasks;
    this.emit(id, "background_tasks_updated", { tasks });
  }

  private setStatus(id: string, status: SessionStatus): void {
    this.assertWritableTranscript(id);
    const session = this.sessions.get(id);
    if (!session) return;
    if (status === "starting" || status === "dead") this.setBackgroundTasks(id, []);
    session.status = status;
    session.lastActivityAt = new Date().toISOString();
    this.trackWorkerProcess(session, status === "dead" ? undefined : this.workers.get(id));
    this.persistRegistry();
  }

  private trackWorkerProcess(record: SessionRecord, worker?: Driver): void {
    const pid = worker?.child?.pid;
    if (record.processId !== pid || !pid) record.processIdentity = undefined;
    record.processId = pid;
    if (pid && !record.processIdentity?.bootId) {
      // Distinguish a legacy record without identity from a new worker whose identity could not be read.
      // The latter must remain dead after a crash even if its launcher PID has disappeared.
      record.processIdentity = captureWorkerIdentity(pid) ?? { bootId: "", startTime: "" };
    }
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
    this.assertWritableTranscript(session.id);
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
    this.assertWritableTranscript(session.id);
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
      if (mark) {
        this.nativeMarks.set(id, mark);
        this.markRegistryDirty();
      }
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
  private refreshBeforeSend(id: string): Promise<void> {
    const existing = this.nativeRefreshes.get(id);
    if (existing) return existing;
    const pending = this.refreshNativeBeforeSend(id).finally(() => {
      if (this.nativeRefreshes.get(id) === pending) this.nativeRefreshes.delete(id);
    });
    this.nativeRefreshes.set(id, pending);
    return pending;
  }

  private async refreshNativeBeforeSend(id: string): Promise<void> {
    this.assertWritableTranscript(id);
    await this.releases.get(id);
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
        this.markRegistryDirty();
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
    this.assertNoMenuControl(id, oldWorker);
    this.restartingSessions.add(id);
    this.setStatus(id, "starting");
    this.workers.delete(id);
    try {
      const replacement = await this.replaceWorker(id, oldWorker, record.config, nativeSessionId);
      this.trackWorkerProcess(record, replacement);
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
    this.assertWritableTranscript(id);
    await this.releases.get(id);
    await this.nativeRefreshes.get(id);
    const existing = this.workers.get(id);
    if (existing) return existing;
    const record = this.sessions.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    // 只有 idle 的 released 会话可以原地拉起；server 重启后载入的 dead 会话只能新建续接
    if (!record.released || !["idle", "error"].includes(record.status)) return this.requireWorker(id);
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

  /** 必须在摘掉 workers 注册项之前调用：之后再拒绝，旧 worker 既没停也不在注册表里。 */
  private assertNoMenuControl(id: string, oldWorker: Driver | null): void {
    if (this.thinkingUpdates.has(id) || (oldWorker && this.sideQuestions.has(id))) throw new Error("请等 Thinking 切换或侧问结束后再续接 worker");
  }

  private async replaceWorker(
    id: string,
    oldWorker: Driver | null,
    config: SessionConfig,
    nativeSessionId?: string,
  ): Promise<Driver> {
    if (this.stopping) throw new Error("Workbench 正在退出");
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
    if (record.customTitle && replacement instanceof CodexDriver) replacement.cancelAutomaticTitle();
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
    this.assertNoMenuControl(id, oldWorker);
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
      this.trackWorkerProcess(record, nextWorker);
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
      record.processIdentity = undefined;
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
    const current = () => !this.damagedTranscripts.has(id) && this.workers.get(id) === worker();
    return {
      emit: (type, payload = {}) => {
        if (!current()) return undefined;
        const session = this.sessions.get(id);
        if (session?.agent === "claude") {
          if (type === "tool_call_updated" && typeof payload.partialInput === "string"
            && Object.keys(payload).every((key) => key === "toolCallId" || key === "partialInput")) {
            this.queuePartialUpdate(id, payload);
            return undefined;
          }
        }
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
        const before = JSON.stringify(session);
        const nativeTitle = typeof metadata.nativeTitle === "string"
          ? metadata.nativeTitle.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        const titleChanged = Boolean(nativeTitle && nativeTitle !== session.nativeTitle);
        if (titleChanged) session.nativeTitle = nativeTitle;
        if (metadata.nativeSessionId) session.nativeSessionId = metadata.nativeSessionId;
        if (metadata.nativeTranscriptPath) session.nativeTranscriptPath = metadata.nativeTranscriptPath;
        if (metadata.config) this.applyConfig(session, metadata.config);
        if (metadata.effectiveConfig) this.applyEffectiveConfig(session, metadata.effectiveConfig);
        if (metadata.remoteControl && JSON.stringify(session.remoteControl) !== JSON.stringify(metadata.remoteControl)) {
          session.remoteControl = metadata.remoteControl;
          this.emit(id, "remote_control_updated", { ...metadata.remoteControl });
        }
        if (metadata.backgroundTasks && JSON.stringify(session.backgroundTasks ?? []) !== JSON.stringify(metadata.backgroundTasks)) this.setBackgroundTasks(id, metadata.backgroundTasks);
        this.trackWorkerProcess(session, worker());
        if (JSON.stringify(session) !== before) this.persistRegistry();
        if (titleChanged) this.organizationUpdated();
      },
      commands: (commands) => {
        if (!this.sessions.has(id) || !current()) return;
        const normalized = commands.map((command) => ({ ...command }));
        if (commandContent(this.commands.get(id) ?? []) === commandContent(normalized)) return;
        this.commands.set(id, normalized);
        this.emit(id, "commands_updated", { commands: normalized });
      },
      status: (status) => {
        if (current()) {
          if (status === "error" || status === "dead") this.flushPartialUpdates(id);
          this.setStatus(id, status);
        }
      },
      exited: (info) => {
        if (!this.sessions.has(id) || !current()) return;
        this.flushPartialUpdates(id);
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
    this.assertWritableTranscript(id);
    if (!this.sessions.has(id)) throw new Error(`会话不存在：${id}`);
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`会话 ${id} 没有活动 worker；请用原生 session id 手动重开`);
    return worker;
  }

  private assertWritableTranscript(id: string): void {
    if (this.deletingSessions.has(id)) throw new SessionBusyError("会话正在彻底删除，请稍候。");
    if (this.damagedTranscripts.has(id)) throw new Error(`transcript 损坏，禁止继续写入：${this.sessions.get(id)?.transcriptPath}`);
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

  private queuePartialUpdate(id: string, payload: Record<string, unknown>): void {
    const tools = this.partialUpdates.get(id) ?? new Map();
    this.partialUpdates.set(id, tools);
    const key = String(payload.toolCallId ?? "");
    const update = tools.get(key) ?? { lastSent: -Infinity };
    tools.set(key, update);
    update.payload = payload;
    const send = () => {
      if (update.timer) clearTimeout(update.timer);
      update.timer = undefined;
      if (!update.payload) return;
      const latest = update.payload;
      update.payload = undefined;
      update.lastSent = Date.now();
      this.emit(id, "tool_call_updated", latest, true);
    };
    const delay = 100 - (Date.now() - update.lastSent);
    if (delay <= 0) send();
    else if (!update.timer) {
      update.timer = setTimeout(send, delay);
      update.timer.unref();
    }
  }

  private flushPartialUpdates(id: string): void {
    const tools = this.partialUpdates.get(id);
    if (!tools) return;
    this.partialUpdates.delete(id);
    for (const update of tools.values()) {
      if (update.timer) clearTimeout(update.timer);
      if (update.payload) this.emit(id, "tool_call_updated", update.payload, true);
    }
  }

  private markRegistryDirty(): void {
    this.registryDirty = true;
    if (this.registryTimer) return;
    this.registryTimer = setTimeout(() => {
      this.registryTimer = undefined;
      if (this.registryDirty) this.persistRegistry();
    }, 1000);
    this.registryTimer.unref();
  }

  private persistRegistry(): void {
    if (this.registryTimer) clearTimeout(this.registryTimer);
    this.registryTimer = undefined;
    saveRegistry([...this.sessions.values()].map((session) => ({
      ...session,
      releasedMark: this.nativeMarks.get(session.id) ?? session.releasedMark,
    })));
    this.registryDirty = false;
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
  const { processIdentity: _identity, releasedMark: _mark, ...visible } = session;
  return {
    ...visible,
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

/** 浏览器协议链接；不在服务端启动 VSCode，WSL cwd 保留目录分隔符。 */
export function buildVSCodeUri(record: Pick<SessionRecord, "agent" | "nativeSessionId" | "cwd">, distro = process.env.WSL_DISTRO_NAME): string | null {
  if (record.agent === "claude") {
    return record.nativeSessionId ? `vscode://anthropic.claude-code/open?session=${encodeURIComponent(record.nativeSessionId)}` : null;
  }
  if (!distro?.trim()) return null;
  const cwd = record.cwd.split("/").map(encodeURIComponent).join("/");
  return `vscode://vscode-remote/wsl+${encodeURIComponent(distro.trim())}${cwd}`;
}

/** 带 cwd 的原生续接命令；cwd 做 shell 单引号转义（' → '\''）。 */
function buildResumeCommand(record: SessionRecord): string {
  const cwd = `'${record.cwd.replace(/'/g, `'\\''`)}'`;
  const nativeId = record.nativeSessionId ?? "";
  if (record.agent === "claude") return `cd ${cwd} && claude --resume ${nativeId}`;
  if (record.agent === "codex") return `cd ${cwd} && codex resume ${nativeId}`;
  return `cd ${cwd} && kimi -S ${nativeId}`;
}

/** 对象键顺序不影响命令表内容，数组顺序仍保留菜单顺序。 */
function commandContent(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
