import type {
  CommandInfo,
  ConfigOptionId,
  FileMention,
  MetaInfo,
  PageManifest,
  PermissionDecision,
  SessionConfig,
  SessionRecord,
  SessionStatus,
  UnifiedEvent,
} from "./types";
import { createSession, deleteSession, fetchCommands, fetchFiles, fetchMeta, fetchPages, fetchSessions, fetchSnapshot, type CreateSessionInput } from "./api";
import { extractMentionTokens, stripMentionCandidates } from "./mentions";
import { partitionPages, type SkippedPage } from "./pages";

// 全局状态与连接恢复：
// - 一条全局 WS（不带 sessionId）收全部会话事件，支撑左栏跨会话待审批徽标；
//   服务端只对带 sessionId&afterSeq 的连接补发，全局连接没有任何补发——
//   因此 WS open 后对每个会话都重取快照对齐（不只当前会话），覆盖
//   「快照完成、WS 未建立」与断连期间的审批事件；
// - 进入会话先 GET snapshot 拿全量 events + seq，WS 上 seq 更大的事件追加；
// - 快照请求按会话去重（in-flight 复用同一 Promise）并带版本戳（过期响应丢弃）；
// - WS 断线指数退避重连；收到 resync_required 或 seq 缺口时对该会话重取快照。

export type WsState = "connecting" | "open" | "closed";

/** 每会话内存事件上限：超出丢弃最旧并计数，快照重取即可恢复全量。 */
const MAX_EVENTS = 2000;

/** 单条消息的 mentions 上限（后端硬限制，超出截断并在预览条提示）。 */
export const MAX_MENTIONS = 20;

interface SessionData {
  events: UnifiedEvent[];
  seq: number;
  /** 因 MAX_EVENTS 上限被丢弃的最旧事件数（>0 时流顶部提示） */
  dropped: number;
  /** requestId → 请求事件 seq，用于闸门块定位与排序 */
  pendingGates: Map<string, number>;
  latestUsage?: Record<string, unknown>;
}

export class Store {
  sessions: SessionRecord[] = [];
  meta: MetaInfo | null = null;
  currentId: string | null = null;
  /** 扩展页面列表（仅 type:"iframe"；未知类型进 skippedPages）与当前打开的页面 id */
  pages: PageManifest[] = [];
  skippedPages: SkippedPage[] = [];
  currentPageId: string | null = null;
  /** hash 路由 #/history：历史会话浏览视图（与 session/page 两路互斥） */
  historyOpen = false;
  data = new Map<string, SessionData>();
  wsState: WsState = "closed";
  lastError: string | null = null;
  /** 删除成功后的一次性提示（原生记录仍在 + 可选 transcript 路径），用户手动关闭 */
  removalNotice: { message: string; path?: string } | null = null;
  /** set_config 发送中的控件（sessionId → 选项 id 集合）；等 config_updated 回来才解除 */
  configPending = new Map<string, Set<ConfigOptionId>>();
  /** set_config 失败错误（sessionId → 消息），显示在输入框上方配置控件旁 */
  configErrors = new Map<string, string>();
  /** codex effectiveFrom:"next_turn" 的一次性提示 */
  configHints = new Map<string, string>();
  /** 每会话斜杠命令表：快照内 commands_updated 打底 + REST 首取覆盖 + WS 实时全量覆盖 */
  commands = new Map<string, CommandInfo[]>();
  /** @ 引用存在性结论缓存：sessionId →（路径 → 是否真实文件）；面板检索命中与精确查询都写入 */
  fileKnown = new Map<string, Map<string, boolean>>();
  /** @token 最终生效路径结论缓存：sessionId →（原 token → 生效路径或 null=未找到）；尾部标点剥离后命中时值是剥离后的路径 */
  mentionPaths = new Map<string, Map<string, string | null>>();
  /** 每会话输入框草稿（内存级）：Composer 输入即写入，发送成功清除，remove 时删除 */
  drafts = new Map<string, string>();
  /** 全局时钟（每秒 tick），驱动相对时间与用时刷新 */
  now = Date.now();
  /** 每次 notify 自增，供 useSyncExternalStore 做快照 */
  version = 0;

  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** 每会话快照版本戳：作废旧响应（值来自 nextSnapshotGen，每次请求唯一且写入 Map） */
  private snapshotGen = new Map<string, number>();
  /** 快照 generation 分配器：单调自增，杜绝「缺省 0」不写 Map 导致校验取回 undefined 的碰撞 */
  private nextSnapshotGen = 0;
  /** 每会话 in-flight 快照请求：并发对齐复用同一 Promise */
  private snapshotInflight = new Map<string, Promise<void>>();
  private configHintTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** @ 引用精确查询 in-flight 去重（key = sessionId + \n + path） */
  private fileKnownInflight = new Map<string, Promise<boolean>>();
  /** @token 生效路径解析 in-flight 去重（key = sessionId + \n + token） */
  private mentionPathInflight = new Map<string, Promise<string | null>>();
  /** 已移除会话：DELETE 后残留 WS 事件/快照直接忽略，不再重取（会 404 污染全局错误条） */
  private removed = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    window.addEventListener("hashchange", this.onHashChange);
    this.onHashChange();
    setInterval(() => {
      this.now = Date.now();
      this.notify();
    }, 1000);
    try {
      this.meta = await fetchMeta();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    await this.refreshSessions();
    await this.refreshPages();
    // 启动时为每个会话取一次快照：既给左栏标题，也算出跨会话待审批徽标。
    await Promise.allSettled(this.sessions.map((s) => this.ensureLoaded(s.id)));
    this.connect();
    this.notify();
  }

  private onHashChange = (): void => {
    // 三类路由互斥：#/history、#/page/<id>、#/session/<id>；其余 hash 回空态。
    if (window.location.hash === "#/history") {
      this.historyOpen = true;
      this.currentPageId = null;
      this.currentId = null;
      this.notify();
      return;
    }
    this.historyOpen = false;
    const pageId = window.location.hash.match(/^#\/page\/([^/]+)$/)?.[1];
    if (pageId) {
      this.currentPageId = decodeURIComponent(pageId);
      this.currentId = null;
      this.notify();
      return;
    }
    this.currentPageId = null;
    const match = window.location.hash.match(/^#\/session\/([^/]+)$/);
    this.currentId = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (this.currentId) void this.ensureLoaded(this.currentId);
    this.notify();
  };

  navigate(id: string | null): void {
    window.location.hash = id ? `#/session/${encodeURIComponent(id)}` : "#/";
  }

  navigatePage(id: string): void {
    window.location.hash = `#/page/${encodeURIComponent(id)}`;
  }

  navigateHistory(): void {
    window.location.hash = "#/history";
  }

  /** 扩展页面列表：只在启动时取一次（server 也只在启动时扫描 pages/，增删要重启才生效）。 */
  async refreshPages(): Promise<void> {
    try {
      const { supported, skipped } = partitionPages(await fetchPages());
      this.pages = supported;
      this.skippedPages = skipped;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  session(id: string): SessionRecord | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  pendingCount(id: string): number {
    return this.data.get(id)?.pendingGates.size ?? 0;
  }

  async refreshSessions(): Promise<void> {
    try {
      this.sessions = await fetchSessions();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    // dead 会话的未决闸门已不可操作，清掉避免僵尸暖色徽标。
    for (const session of this.sessions) {
      if (session.status === "dead") this.data.get(session.id)?.pendingGates.clear();
    }
    this.notify();
  }

  /** 会话事件是否已加载；未加载则取快照。 */
  async ensureLoaded(id: string): Promise<void> {
    if (this.removed.has(id)) return; // 已移除的会话不再取快照
    if (this.data.has(id)) return;
    await this.alignSnapshot(id);
    this.notify();
  }

  /**
   * 取快照对齐该会话。同会话 in-flight 复用同一 Promise；
   * 版本戳不匹配的过期响应直接丢弃（等待期间已有更新的对齐周期启动）。
   */
  private alignSnapshot(id: string): Promise<void> {
    const inflight = this.snapshotInflight.get(id);
    if (inflight) return inflight;
    // 每个新快照请求分配唯一 generation 并立即写入 Map——缺省归一为 0 但不写入时，
    // 校验处取回的仍是 undefined，新会话首次快照必被误丢（界面永远空白的根因）。
    const gen = ++this.nextSnapshotGen;
    this.snapshotGen.set(id, gen);
    // 先声明再赋值（! 断言）：finally 里的所有权校验要引用 promise 自身，赋值在闭包执行前完成
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const snapshot = await fetchSnapshot(id);
        if (this.snapshotGen.get(id) === gen) {
          this.applySnapshot(id, snapshot.session, snapshot.seq, snapshot.events);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        // 所有权校验：旧请求的 finally 不得误删新请求的 in-flight 条目
        if (this.snapshotInflight.get(id) === promise) this.snapshotInflight.delete(id);
      }
      // REST 首取实时命令表（覆盖快照里可能过期的 commands_updated 结果）；
      // dead 会话等失败场景保留快照内的结果，不打扰全局错误条。
      try {
        const list = await fetchCommands(id);
        if (this.snapshotGen.get(id) === gen) this.commands.set(id, list);
      } catch {
        /* 保留快照内的命令表 */
      }
      this.notify();
    })();
    this.snapshotInflight.set(id, promise);
    return promise;
  }

  /** 作废 in-flight 快照响应并强制重取（seq 缺口 / resync_required / WS open 对齐）。 */
  private resync(id: string): Promise<void> {
    // 作废旧响应靠 alignSnapshot 新分配的唯一 generation（旧响应必不匹配），无需手动自增
    this.snapshotInflight.delete(id);
    this.data.delete(id);
    return this.alignSnapshot(id);
  }

  private applySnapshot(
    id: string,
    session: SessionRecord,
    seq: number,
    events: UnifiedEvent[],
  ): void {
    const pendingGates = new Map<string, number>();
    let latestUsage: Record<string, unknown> | undefined;
    let commands: CommandInfo[] | undefined;
    // dead 会话的 permission_request 不计入 pending：进程已不在，闸门不可操作。
    const dead = session.status === "dead";
    for (const event of events) {
      if (event.type === "permission_request") {
        if (!dead) pendingGates.set(String(event.payload.requestId ?? ""), event.seq);
      } else if (event.type === "permission_resolved") {
        pendingGates.delete(String(event.payload.requestId ?? ""));
      } else if (event.type === "usage_updated") {
        latestUsage = event.payload;
      } else if (event.type === "commands_updated") {
        commands = commandsFromPayload(event.payload);
      }
    }
    if (commands) this.commands.set(id, commands);
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const dropped = Math.max(0, sorted.length - MAX_EVENTS);
    this.data.set(id, { events: sorted.slice(dropped), seq, dropped, pendingGates, latestUsage });
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index >= 0) this.sessions[index] = session;
    else this.sessions.push(session);
  }

  private connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.wsState = "connecting";
    this.notify();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.wsState = "open";
      this.reconnectDelay = 1000;
      // 全局连接没有补发能力：断连期间（含启动时快照与 WS 建立之间的窗口）
      // 任何会话的事件都可能丢失，open 后对每个会话重取快照对齐。
      void this.refreshSessions().then(() => {
        for (const session of this.sessions) void this.resync(session.id);
      });
      this.notify();
    });
    socket.addEventListener("message", (messageEvent) => {
      try {
        this.handleFrame(JSON.parse(String(messageEvent.data)) as Record<string, unknown>);
      } catch {
        // 无法解析的帧直接忽略。
      }
    });
    socket.addEventListener("close", () => {
      this.wsState = "closed";
      this.socket = null;
      this.notify();
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = String(frame.type ?? "");
    if (type === "ready") return;
    if (type === "ack") return;
    if (type === "resync_required") {
      const id = String(frame.sessionId ?? "");
      if (id) void this.resync(id);
      return;
    }
    if (type === "error") {
      const msg = String(frame.msg ?? "未知错误");
      const sid = typeof frame.sessionId === "string" ? frame.sessionId : "";
      // 有 set_config 在等结果的会话：错误归到配置控件旁，不进全局提示条。
      if (sid && this.configPending.has(sid)) {
        this.configPending.delete(sid);
        this.configErrors.set(sid, msg);
      } else {
        this.lastError = msg;
      }
      this.notify();
      return;
    }
    if (typeof frame.seq !== "number" || typeof frame.sessionId !== "string") return;
    this.handleEvent(frame as unknown as UnifiedEvent);
  }

  private handleEvent(event: UnifiedEvent): void {
    if (this.removed.has(event.sessionId)) return; // DELETE 后残留事件直接忽略
    const data = this.data.get(event.sessionId);
    if (data) {
      // 快照语义：只追加 seq 更大的事件；出现缺口则重取快照。
      if (event.seq > data.seq + 1) {
        void this.resync(event.sessionId);
        return;
      }
      if (event.seq === data.seq + 1) {
        data.events.push(event);
        if (data.events.length > MAX_EVENTS) {
          const excess = data.events.length - MAX_EVENTS;
          data.events.splice(0, excess);
          data.dropped += excess;
        }
        data.seq = event.seq;
        if (event.type === "permission_request") {
          if (this.session(event.sessionId)?.status !== "dead") {
            data.pendingGates.set(String(event.payload.requestId ?? ""), event.seq);
          }
        } else if (event.type === "permission_resolved") {
          data.pendingGates.delete(String(event.payload.requestId ?? ""));
        } else if (event.type === "process_exited") {
          // 进程退出后未决闸门永不可操作，立即清掉避免僵尸暖色徽标。
          data.pendingGates.clear();
        } else if (event.type === "usage_updated") {
          data.latestUsage = event.payload;
        } else if (event.type === "commands_updated") {
          // 实时全量覆盖（装新 skill 后立即可见），不是一次性快照。
          this.commands.set(event.sessionId, commandsFromPayload(event.payload));
        }
      }
      // event.seq <= data.seq：重发，忽略。
    } else {
      // 未加载的会话（如别的客户端刚建的）：取快照，快照会包含这条事件。
      void this.ensureLoaded(event.sessionId);
    }

    // 任何事件都刷新该会话的本地视图（lastActivityAt / 状态推断）。
    const session = this.session(event.sessionId);
    if (session) {
      session.lastActivityAt = event.timestamp;
      const status = statusFromEvent(event);
      if (status) session.status = status;
      if (event.type === "config_updated") this.applyConfigUpdated(event, session);
    } else {
      // 新会话（别的客户端建的）：刷新列表。
      void this.refreshSessions();
    }
    this.scheduleListRefresh();
    this.notify();
  }

  /**
   * config_updated 广播：payload 带完整 config 与 model/effort/permissionMode/riskyMode，
   * 不做乐观更新——显示以此事件为准；同时解除该会话的发送中状态。
   */
  private applyConfigUpdated(event: UnifiedEvent, session: SessionRecord): void {
    const payload = event.payload;
    if (payload.config && typeof payload.config === "object") {
      session.config = payload.config as SessionConfig;
    }
    if ("model" in payload) session.model = payload.model as string | null;
    if ("effort" in payload) session.effort = payload.effort as string | null;
    if ("permissionMode" in payload) session.permissionMode = payload.permissionMode as string | null;
    if (typeof payload.riskyMode === "boolean") session.riskyMode = payload.riskyMode;
    this.configPending.delete(event.sessionId);
    this.configErrors.delete(event.sessionId);
    if (payload.effectiveFrom === "next_turn") {
      this.configHints.set(event.sessionId, "下一轮生效");
      const timer = this.configHintTimers.get(event.sessionId);
      if (timer) clearTimeout(timer);
      this.configHintTimers.set(
        event.sessionId,
        setTimeout(() => {
          this.configHints.delete(event.sessionId);
          this.configHintTimers.delete(event.sessionId);
          this.notify();
        }, 8000),
      );
    }
  }

  /** 事件驱动之外，定期对齐一次权威列表（状态、processId 等）。 */
  private scheduleListRefresh(): void {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = setTimeout(() => {
      this.listRefreshTimer = undefined;
      void this.refreshSessions();
    }, 2000);
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    this.lastError = "连接已断开，正在重连…";
    this.notify();
    return false;
  }

  /** 上行失败（socket 非 OPEN）返回 false 并置 lastError，调用方据此把文本还回输入框。 */
  sendUserMessage(sessionId: string, text: string, mentions?: FileMention[]): boolean {
    return this.send({
      type: "user_message",
      sessionId,
      text,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    });
  }

  /** 结构化斜杠命令上行：command 与 text 互斥（后端对不支持的 driver 明确报错）。 */
  sendCommand(sessionId: string, name: string, args: string): boolean {
    return this.send({ type: "user_message", sessionId, command: { name, arguments: args } });
  }

  /**
   * 输入框统一入口：行首「/命令表内名称 + 可选参数」走结构化 command（不附 mentions），
   * 其余一律按普通文本（能力位为 false 的 driver 绝不拼结构化 command）。
   * mentions 能力位 true 时解析 @token：仅确认存在的路径进 mentions，文本原样发送。
   * 全部路径返回是否真正上行（mentions 分支是异步解析，故整体为 Promise）。
   * 真正上行成功时清掉该会话草稿——仅当草稿内容仍是本次发送的文本
   * （发送间隙用户又输入的新内容不能误清）；失败时草稿本来就在，不用动。
   */
  sendComposerInput(sessionId: string, text: string): Promise<boolean> {
    return this.dispatchComposerInput(sessionId, text).then((ok) => {
      if (ok && this.drafts.get(sessionId)?.trim() === text.trim()) this.clearDraft(sessionId);
      return ok;
    });
  }

  private dispatchComposerInput(sessionId: string, text: string): Promise<boolean> {
    const session = this.session(sessionId);
    const caps = session ? this.meta?.drivers[session.agent] : undefined;
    if (caps?.commands) {
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (match) {
        const hit = (this.commands.get(sessionId) ?? []).find((c) => c.name === match[1]);
        if (hit) {
          return Promise.resolve(this.sendCommand(sessionId, hit.name, (match[2] ?? "").trim()));
        }
      }
    }
    if (!caps?.mentions) {
      return Promise.resolve(this.sendUserMessage(sessionId, text));
    }
    return this.sendWithMentions(sessionId, text);
  }

  /** 读会话草稿（无草稿返回空串）。 */
  getDraft(sessionId: string): string {
    return this.drafts.get(sessionId) ?? "";
  }

  /** 写草稿：空文本等价于清除。不 notify——草稿只有 Composer 自己读写。 */
  setDraft(sessionId: string, text: string): void {
    if (text) this.drafts.set(sessionId, text);
    else this.drafts.delete(sessionId);
  }

  clearDraft(sessionId: string): void {
    this.drafts.delete(sessionId);
  }

  /** 检索结果整体记入缓存：返回过的路径确认存在。 */
  noteFiles(sessionId: string, files: string[]): void {
    let map = this.fileKnown.get(sessionId);
    if (!map) {
      map = new Map();
      this.fileKnown.set(sessionId, map);
    }
    for (const file of files) map.set(file, true);
  }

  /** 同步读存在性结论（undefined = 尚未确认），供预览条渲染。 */
  fileKnownSync(sessionId: string, path: string): boolean | undefined {
    return this.fileKnown.get(sessionId)?.get(path);
  }

  /**
   * 精确存在性查询：q=完整路径，结果里精确命中才算存在（检索是子串模糊匹配，
   * 「出现在结果中」不等于「该路径是真实文件」）。结论缓存、in-flight 去重；
   * 请求失败不缓存结论，下次重试。
   */
  resolveFile(sessionId: string, path: string): Promise<boolean> {
    const cached = this.fileKnownSync(sessionId, path);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = `${sessionId}\n${path}`;
    const inflight = this.fileKnownInflight.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const files = await fetchFiles(sessionId, path, 200);
        this.noteFiles(sessionId, files);
        const exists = files.includes(path);
        this.fileKnown.get(sessionId)?.set(path, exists);
        this.notify(); // 预览条等读缓存的视图刷新
        return exists;
      } catch {
        return false;
      } finally {
        this.fileKnownInflight.delete(key);
      }
    })();
    this.fileKnownInflight.set(key, promise);
    return promise;
  }

  /** 同步读 @token 的生效路径结论（undefined = 尚未解析，null = 未找到），供预览条渲染。 */
  mentionPathSync(sessionId: string, token: string): string | null | undefined {
    return this.mentionPaths.get(sessionId)?.get(token);
  }

  /**
   * 解析 @token 的最终生效路径：整 token 先查（文件名真带标点也支持，不冤枉），
   * 不存在才按 stripMentionCandidates 逐级剥尾部标点再查，一旦命中真实文件即采纳。
   * 结论按 token 缓存（含「未找到」null），in-flight 去重；
   * 任一层查询失败（resolveFile 未落结论）不缓存，下次重试——与 resolveFile 同一纪律。
   */
  resolveMentionPath(sessionId: string, token: string): Promise<string | null> {
    const cached = this.mentionPathSync(sessionId, token);
    if (cached !== undefined) return Promise.resolve(cached);
    if (this.fileKnownSync(sessionId, token) === true) return Promise.resolve(token);
    const key = `${sessionId}\n${token}`;
    const inflight = this.mentionPathInflight.get(key);
    if (inflight) return inflight;
    // 先声明再赋值（! 断言）：finally 里的所有权校验要引用 promise 自身
    let promise!: Promise<string | null>;
    promise = (async () => {
      try {
        if (await this.resolveFile(sessionId, token)) {
          return this.noteMentionPath(sessionId, token, token);
        }
        // 整 token 未落 false 结论 = 查询失败：不缓存，下次重试
        if (this.fileKnownSync(sessionId, token) === undefined) return null;
        for (const candidate of stripMentionCandidates(token)) {
          if (await this.resolveFile(sessionId, candidate)) {
            return this.noteMentionPath(sessionId, token, candidate);
          }
          if (this.fileKnownSync(sessionId, candidate) === undefined) return null; // 同上
        }
        return this.noteMentionPath(sessionId, token, null);
      } finally {
        // 所有权校验：旧请求的 finally 不得误删新请求的 in-flight 条目
        if (this.mentionPathInflight.get(key) === promise) this.mentionPathInflight.delete(key);
      }
    })();
    this.mentionPathInflight.set(key, promise);
    return promise;
  }

  private noteMentionPath(sessionId: string, token: string, path: string | null): string | null {
    if (this.removed.has(sessionId)) return path; // 会话已删，解析结果不再落地
    let map = this.mentionPaths.get(sessionId);
    if (!map) {
      map = new Map();
      this.mentionPaths.set(sessionId, map);
    }
    map.set(token, path);
    this.notify(); // 预览条等读缓存的视图刷新
    return path;
  }

  /** 发送前解析 @token：只把生效路径放进 mentions（去重、≤20），文本原样发送。 */
  private async sendWithMentions(sessionId: string, text: string): Promise<boolean> {
    const tokens = extractMentionTokens(text).slice(0, MAX_MENTIONS);
    const mentions: FileMention[] = [];
    const seen = new Set<string>(); // 不同 token 可能解析到同一路径（@a.ts 与 @a.ts，），按生效路径去重
    for (const token of tokens) {
      const path = await this.resolveMentionPath(sessionId, token);
      if (path && !seen.has(path)) {
        seen.add(path);
        mentions.push({ type: "file", path });
      }
    }
    return this.sendUserMessage(sessionId, text, mentions);
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
  ): void {
    this.send({ type: "permission_resolved", sessionId, requestId, decision, ...(updatedInput !== undefined ? { updatedInput } : {}) });
  }

  interrupt(sessionId: string): void {
    this.send({ type: "interrupt", sessionId });
  }

  /**
   * 活改会话配置（WS set_config）。不做乐观更新：控件进入发送中态，
   * 等 config_updated 广播回来才更新显示；失败走 WS error 帧。
   */
  setConfig(sessionId: string, config: Partial<Record<ConfigOptionId, string>>): void {
    const keys = Object.keys(config) as ConfigOptionId[];
    if (keys.length === 0) return;
    const pending = this.configPending.get(sessionId) ?? new Set<ConfigOptionId>();
    for (const key of keys) pending.add(key);
    this.configPending.set(sessionId, pending);
    this.configErrors.delete(sessionId);
    this.configHints.delete(sessionId);
    if (!this.send({ type: "set_config", sessionId, config })) {
      this.configPending.delete(sessionId);
      this.configErrors.set(sessionId, "连接已断开，正在重连…");
    }
    this.notify();
  }

  clearConfigError(sessionId: string): void {
    if (this.configErrors.delete(sessionId)) this.notify();
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const session = await createSession(input);
    await this.refreshSessions();
    // 等创建完成后强制重取的新快照落地再返回（resync 语义，不复用创建期间
    // 可能已发出的旧快照）：用户建完立刻发送时，事件到达前 data 必须已建好。
    await this.resync(session.id);
    return session;
  }

  /**
   * 从工作台移除会话：DELETE 注册表条目 + 停 worker（原生 transcript 不动）。
   * 成功后清该会话全部本地状态；删的是当前会话时导航到列表剩余的第一个
   * （与左栏同序：lastActivityAt 最新），无剩余则回空态。失败抛错由调用方展示。
   */
  async remove(id: string): Promise<void> {
    const agent = this.session(id)?.agent ?? "";
    const result = await deleteSession(id);
    this.removed.add(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.data.delete(id);
    this.commands.delete(id);
    this.fileKnown.delete(id);
    this.mentionPaths.delete(id);
    this.drafts.delete(id);
    this.configPending.delete(id);
    this.configErrors.delete(id);
    this.configHints.delete(id);
    const hintTimer = this.configHintTimers.get(id);
    if (hintTimer) {
      clearTimeout(hintTimer);
      this.configHintTimers.delete(id);
    }
    // 作废该会话 in-flight 快照，防止过期响应把已删会话写回列表
    this.snapshotGen.set(id, ++this.nextSnapshotGen);
    this.snapshotInflight.delete(id);
    if (this.currentId === id) {
      const next = [...this.sessions].sort(
        (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
      )[0];
      this.navigate(next?.id ?? null);
    }
    // 删除只动注册表：明示原生对话记录仍在，可凭原生 id 续接
    this.removalNotice = {
      message: `已从工作台移除。${agent} 的原生对话记录仍在，可新建会话时填入原生 id 续接。`,
      ...(result.nativeTranscriptPath ? { path: result.nativeTranscriptPath } : {}),
    };
    this.notify();
  }

  dismissRemovalNotice(): void {
    this.removalNotice = null;
    this.notify();
  }

  dismissError(): void {
    this.lastError = null;
    this.notify();
  }
}

/** commands_updated 的 payload 是 {commands: UnifiedCommand[]}；取不出时按空表处理。 */
function commandsFromPayload(payload: Record<string, unknown>): CommandInfo[] {
  const list = payload.commands;
  return Array.isArray(list) ? (list as CommandInfo[]) : [];
}

// 从事件推断会话状态（权威值靠定期 GET /api/sessions 对齐）。
function statusFromEvent(event: UnifiedEvent): SessionStatus | null {
  switch (event.type) {
    case "user_message":
      return "running";
    case "turn_completed":
      return null; // idle/error 由列表刷新对齐，避免覆盖 error
    case "session_error":
      return "error";
    case "process_exited":
      return "dead";
    default:
      return null;
  }
}

export const store = new Store();
