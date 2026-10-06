import type {
  CommandInfo,
  ConfigOptionId,
  EffectiveSource,
  HistorySession,
  Mention,
  MetaInfo,
  PageManifest,
  PermissionDecision,
  SessionConfig,
  SessionRecord,
  SessionGroup,
  SessionOrganizationPatch,
  SessionStatus,
  UnifiedEvent,
  FilePreviewState,
  WorkFileTarget,
} from "./types";
import { createSession, deleteSession, fetchCommands, fetchEarlierEvents, fetchFiles, fetchMeta, fetchPages, fetchSessions, fetchSnapshot, releaseSession, type CreateSessionInput } from "./api";
import { createSessionGroup, deleteSessionGroup, fetchSessionGroups, patchSession, renameSessionGroup } from "./api";
import { fetchWorkFile, saveWorkFile } from "./api";
import { sessionTitle } from "../../shared/session-title";
import { extractMentionTokens, stripMentionCandidates } from "./mentions";
import { partitionPages, type SkippedPage } from "./pages";
import { normalizeHistoryDirectory } from "./history";

// 全局 WS 收全部会话实时事件；首连和重连按已加载会话的 afterSeq 补发。
// 未加载会话只维护列表摘要；快照期间缓存事件，落地后追加更大的 seq。
// 仅明确强制刷新、resync_required 或重连作废在途快照。

type WsState = "connecting" | "open" | "closed";

/** 全局错误条内容；带 sessionId 的错误在 App.tsx 渲染成可点击跳转（会话标题 + agent 名）。 */
interface LastError {
  message: string;
  sessionId?: string;
}

/** 发送被拒后的完整输入内容；由输入框一次性消费，不自动重发。 */
export interface ComposerSendRestore {
  sessionId: string;
  text: string;
  mentions: Mention[];
  version: number;
}

/** 旧服务端全量快照的兼容窗口上限；分页模式保留已加载完整段。 */
const MAX_EVENTS = 2000;

/** 有活跃会话时保持用时读数秒级；全局空闲后把唤醒频率降到 30 秒。 */
const ACTIVE_TICK_MS = 1000;
const IDLE_TICK_MS = 30_000;

/** 单条消息的 mentions 上限（后端硬限制，超出截断并在预览条提示）。 */
export const MAX_MENTIONS = 20;

/** 草稿在 localStorage 的 key 前缀：workbench-draft-<sessionId>。 */
const DRAFT_STORAGE_PREFIX = "workbench-draft-";
const LAST_SESSION_KEY = "workbench-last-session";

/** 手机的一个 history 条目包含完整视图，面板前进时无需借用当前 store 的残留状态。 */
interface MobileRoute {
  hash: string;
  currentId: string | null;
  currentPageId: string | null;
  historyOpen: boolean;
  historySelection: HistorySession | null;
  dispatchesOpen: boolean;
  termOpen: boolean;
  filesOpen: boolean;
}
interface MobileSource {
  id: string;
  route: MobileRoute;
  source?: MobileSource;
}
interface MobileEntry extends MobileSource {
  version: 1;
}
type DesktopPanelSide = "sidebar" | "right";
interface DesktopPanelEntry {
  version: 1;
  id: string;
  route: MobileRoute;
  order: DesktopPanelSide[];
}
function mobileEntryId(): string {
  // HTTP 局域网入口也可用，不依赖仅安全上下文提供的 crypto.randomUUID。
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface SessionData {
  events: UnifiedEvent[];
  seq: number;
  /** 因 MAX_EVENTS 常规窗口被省略的较早事件数（>0 时流顶部提示） */
  dropped: number;
  /** requestId → 请求事件 seq，用于闸门块定位与排序 */
  pendingGates: Map<string, number>;
  latestUsage?: Record<string, unknown>;
  /** 分页模式保留已加载的完整段，不能再按事件数裁掉回合。 */
  paged?: boolean;
  hasMore?: boolean;
  firstSeq?: number;
  loadingOlder?: boolean;
  olderError?: string;
  prependVersion?: number;
  promptCacheTtlMs?: number | null;
  promptCacheUsageAt?: number | null;
}

const FOCUS_VIEW_STORAGE_KEY = "workbench-focus-view";
function readFocusView(): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(FOCUS_VIEW_STORAGE_KEY) === "1"; } catch { return false; }
}

export class Store {
  sessions: SessionRecord[] = [];
  sessionGroups: SessionGroup[] = [];
  /** 组织更改不推进会话 seq；防止在途旧 REST 响应撤销已收到的广播。 */
  private organizationVersion = 0;
  meta: MetaInfo | null = null;
  currentId: string | null = null;
  /** 扩展页面列表（仅 type:"iframe"；未知类型进 skippedPages）与当前打开的页面 id */
  pages: PageManifest[] = [];
  skippedPages: SkippedPage[] = [];
  currentPageId: string | null = null;
  /** 侧栏面板：historyOpen 与 currentPageId 互斥，保留右侧当前会话。 */
  historyOpen = false;
  /** 目录筛选跨面板切换保留，直到用户清除；文件面板可直接替换。 */
  historyCwdFilter = "";
  historySelection: HistorySession | null = null;
  historyRevision = 0;
  dispatchesOpen = false;
  termOpen = false;
  filesOpen = false;
  /** 只保留当前文件；收起、切会话、手机后退都保留草稿，重新打开可继续。 */
  filePreview: FilePreviewState | null = null;
  fileDirectory: string | null = null;
  /** 当前目录浏览器注册；侧键先沿成功访问的目录返回，再退出侧栏。 */
  fileBrowserBack: (() => boolean) | null = null;
  private fileLoad: AbortController | null = null;
  private fileUnloadBound = false;
  private fileLoadSequence = 0;
  /** 文件面板发给 Composer 的一次性请求；模块加载不依赖 DOM。 */
  fileMentionRequest: { sessionId: string; path: string; version: number } | null = null;
  private fileMentionSequence = 0;
  private beforeDispatches: { hash: string; currentId: string | null; selection: HistorySession | null } | null = null;
  /** 只相信本次运行亲自 push 的相邻关系；刷新后的来源仍可 replace，但不盲目 back。 */
  private mobilePredecessors = new Map<string, string>();
  private mobileBackPending: string | null = null;
  /** 桌面只保留一条面板历史；目录返回优先，否则关闭最近打开的一侧，不重放旧面板。 */
  private desktopPanelOrder: DesktopPanelSide[] = [];
  private desktopPanelEntryId: string | null = null;
  private desktopBackPending = false;
  /** Chromium 在 location.hash 赋值当中同步派发 popstate；自己写 hash 时别把它当成 Back。 */
  private writingHash = false;
  private desktopDispatchHash = "#/dispatches";
  private sessionsLoaded = false;
  data = new Map<string, SessionData>();
  wsState: WsState = "closed";
  /** Focus view：只显示用户输入与助手回复（闸门/提问照常），按浏览器记忆 */
  focusView: boolean = readFocusView();
  lastError: LastError | null = null;
  /** 删除成功后的一次性提示（原生记录仍在 + 可选 transcript 路径），用户手动关闭 */
  removalNotice: { message: string; path?: string } | null = null;
  /** set_config 发送中的控件（sessionId → 选项 id 集合）；等 config_updated 回来才解除 */
  configPending = new Map<string, Set<ConfigOptionId>>();
  /** set_config 失败错误（sessionId → 消息），显示在输入框上方配置控件旁 */
  configErrors = new Map<string, string>();
  /**
   * claude model/effort 重启切换进行中（sessionId → config_update_started 的 message）。
   * 控件禁用 + 就地显示该文案；config_updated / session_error / WS error 到达才解除。
   */
  configSwitching = new Map<string, string>();
  /** codex effectiveFrom:"next_turn" 的一次性提示 */
  configHints = new Map<string, string>();
  /** 每会话斜杠命令表：快照内 commands_updated 打底 + REST 首取覆盖 + WS 实时全量覆盖 */
  commands = new Map<string, CommandInfo[]>();
  /** @ 引用存在性结论缓存：sessionId →（路径 → 是否真实文件）；面板检索命中与精确查询都写入 */
  fileKnown = new Map<string, Map<string, boolean>>();
  /** @token 最终生效路径结论缓存：sessionId →（原 token → 生效路径或 null=未找到）；尾部标点剥离后命中时值是剥离后的路径 */
  mentionPaths = new Map<string, Map<string, string | null>>();
  /** 每会话输入框草稿：内存 + localStorage 持久化（刷新不丢），remove 时两处都清 */
  drafts = new Map<string, string>();
  /** 发送被本地拦下的原因（sessionId → 文案：有待决闸门 / 配置切换中）：显示在输入框上方，× 或下次发送尝试清除 */
  sendNotices = new Map<string, string>();
  /** 服务端拒绝后还回输入框的一次性请求（Composer 消费，语义同 fileMentionRequest）；只在草稿仍为空时发布 */
  sendTextRestore: ComposerSendRestore | null = null;
  private sendRestoreSequence = 0;
  /** clientRequestId → 暂存的发送内容：同 id ack / user_message 回显丢弃，同 id error 还回文本与引用；不自动重发 */
  private sendStash = new Map<string, { sessionId: string; text: string; mentions?: Mention[] }>();
  private nextClientRequestId = 0;
  /** 全局时钟：有 running/starting 会话时每秒 tick，否则每 30 秒 tick。 */
  now = Date.now();
  /** @ 路径结论版本；嵌套 Map 原地更新时供 selector 取得可比较的原始值。 */
  mentionVersion = 0;
  /** 每次 notify 自增，供 useSyncExternalStore 做快照 */
  version = 0;

  private listeners = new Set<() => void>();
  private streamFrame: number | undefined;
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 页面切到后台的时刻（0 = 在前台）；切回时据此判断连接是否可能已成僵尸 */
  private hiddenAt = 0;
  private listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private clockStarted = false;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private tickDelay: number | undefined;
  /** 首次 open 可复用启动快照；此后每次 open 都是断线重连，必须重新对齐。 */
  private hasOpenedSocket = false;
  /** 每会话快照版本戳：作废旧响应（值来自 nextSnapshotGen，每次请求唯一且写入 Map） */
  private snapshotGen = new Map<string, number>();
  /** 快照 generation 分配器：单调自增，杜绝「缺省 0」不写 Map 导致校验取回 undefined 的碰撞 */
  private nextSnapshotGen = 0;
  /** 每会话 in-flight 快照请求：并发对齐复用同一 Promise */
  private snapshotInflight = new Map<string, Promise<void>>();
  private olderInflight = new Map<string, Promise<void>>();
  private snapshotBuffers = new Map<string, UnifiedEvent[]>();
  private replayBuffers = new Map<string, UnifiedEvent[]>();
  private configHintTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** @ 引用精确查询 in-flight 去重（key = sessionId + \n + path） */
  private fileKnownInflight = new Map<string, Promise<boolean>>();
  /** @token 生效路径解析 in-flight 去重（key = sessionId + \n + token） */
  private mentionPathInflight = new Map<string, Promise<string | null>>();
  /** 已移除会话：DELETE 后残留 WS 事件/快照直接忽略，不再重取（会 404 污染全局错误条） */
  private removed = new Set<string>();

  setFocusView(on: boolean): void {
    this.focusView = on;
    try { localStorage.setItem(FOCUS_VIEW_STORAGE_KEY, on ? "1" : "0"); } catch { /* 仅本页生效 */ }
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    if (this.streamFrame !== undefined) {
      cancelAnimationFrame(this.streamFrame);
      this.streamFrame = undefined;
    }
    this.refreshTickSchedule();
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private notifyStreamDelta(): void {
    if (typeof requestAnimationFrame !== "function") {
      this.notify();
      return;
    }
    if (this.streamFrame !== undefined) return;
    this.streamFrame = requestAnimationFrame(() => {
      this.streamFrame = undefined;
      this.notify();
    });
  }

  private startClock(): void {
    if (this.clockStarted) return;
    this.clockStarted = true;
    this.refreshTickSchedule();
  }

  /** 状态跨 running/starting 边界时立即切换频率；同档位不重置现有 timer。 */
  private refreshTickSchedule(): void {
    if (!this.clockStarted) return;
    const active = this.sessions.some(
      (session) => session.status === "running" || session.status === "starting",
    );
    const delay = active ? ACTIVE_TICK_MS : IDLE_TICK_MS;
    if (this.tickTimer !== undefined && this.tickDelay === delay) return;
    if (this.tickTimer !== undefined) clearTimeout(this.tickTimer);
    this.tickDelay = delay;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.now = Date.now();
      this.notify();
    }, delay);
  }

  async init(): Promise<void> {
    window.addEventListener("hashchange", this.onHashChange);
    // 同 hash 的 state 条目也会触发 popstate（例如面板从不同会话打开）。
    window.addEventListener("popstate", this.onPopState);
    // 手机锁屏 / 切后台回来、网络恢复：立即重连，不等退避计时器（最长 15 秒）。
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("online", this.onOnline);
    // 无 hash 进入（托盘 / 快捷方式 / PWA 冷启动）时回到上次打开的会话
    let restored: string | null = null;
    // 桌面派单/历史/页面面板的 hash 不带会话 ID，刷新时同样把上次的会话放回主区
    const panelRestore = /^#\/(?:dispatches|history$|page\/)/.test(window.location.hash)
      && !this.isMobileNavigation() && !this.readMobileEntry();
    if (!window.location.hash || panelRestore) {
      try { restored = localStorage.getItem(LAST_SESSION_KEY); } catch { /* 存储不可用就停在主页 */ }
      if (restored && !panelRestore) window.history.replaceState(null, "", `#/session/${encodeURIComponent(restored)}`);
    }
    this.onHashChange();
    try {
      this.meta = await fetchMeta();
    } catch (error) {
      this.lastError = { message: error instanceof Error ? error.message : String(error) };
    }
    // 路由先于 meta 到达；能力确认后不能留下一个无法挂载的终端全屏。
    if (this.isMobileNavigation() || this.readMobileEntry() || this.readDesktopPanelEntry()) this.onHashChange();
    await Promise.all([this.refreshSessions(), this.refreshSessionGroups()]);
    if (panelRestore) {
      if (restored && !this.currentId && this.sessions.some((x) => x.id === restored)) {
        this.currentId = restored;
        // 关闭派单面板时回到这个会话，而不是冷启动时记下的主页
        if (this.beforeDispatches) this.beforeDispatches = { ...this.beforeDispatches, hash: `#/session/${encodeURIComponent(restored)}`, currentId: restored };
      }
    } else if (restored && this.currentId === restored && !this.sessions.some((x) => x.id === restored)) this.navigate(null);
    if (!this.isMobileNavigation() && !this.readMobileEntry()) this.syncDesktopPanels();
    this.startClock();
    await this.refreshPages();
    if (this.currentId) await this.ensureLoaded(this.currentId);
    this.connect();
    this.notify();
  }

  private onHashChange = (): void => {
    const desktop = this.readDesktopPanelEntry();
    if (desktop) {
      const terminalDisabled = desktop.route.termOpen && this.meta?.capabilities.terminal === false;
      const route = terminalDisabled ? { ...desktop.route, termOpen: false } : desktop.route;
      if (this.isMobileNavigation()) {
        this.desktopPanelOrder = [];
        this.replaceMobileEntry(route);
      } else {
        this.desktopPanelOrder = [...desktop.order];
        this.desktopDispatchHash = desktop.route.hash;
      }
      this.applyMobileRoute(route);
      if (terminalDisabled && !this.isMobileNavigation()) this.syncDesktopPanels();
      return;
    }
    const saved = this.readMobileEntry();
    // 以实际离开来源条目为准；延迟 hashchange 不应解除下一次 back 的锁。
    if (this.mobileBackPending && saved?.id !== this.mobileBackPending) this.mobileBackPending = null;
    // 手机创建的条目跨到桌面后也按完整快照恢复；原生桌面条目仍走旧分支。
    if (this.isMobileNavigation() || saved) {
      let entry = saved ?? this.replaceMobileEntry(this.mobileRouteFromHash(window.location.hash || "#/"));
      if (entry.route.termOpen && this.meta?.capabilities.terminal === false) {
        let source = entry.source;
        while (source?.route.termOpen) source = source.source;
        entry = this.replaceMobileEntry(source?.route ?? this.mobileRouteFromHash(
          entry.route.currentId ? `#/session/${encodeURIComponent(entry.route.currentId)}` : "#/",
        ), source?.source);
      }
      this.applyMobileRoute(entry.route);
      return;
    }
    if (/^#\/dispatches(?:\/[^?]+)?(?:\?runs=.*)?$/.test(window.location.hash)) {
      if (!this.dispatchesOpen) {
        this.beforeDispatches = {
          hash: this.historyOpen ? "#/history" : this.currentPageId
            ? `#/page/${encodeURIComponent(this.currentPageId)}`
            : this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/",
          currentId: this.currentId,
          selection: this.historySelection,
        };
      }
      this.dispatchesOpen = true;
      this.termOpen = false;
      this.filesOpen = false;
      this.notify();
      return;
    }
    this.dispatchesOpen = false;
    this.beforeDispatches = null;
    // 旧 history/page 链接打开侧栏面板；当前会话留在主区。
    if (window.location.hash === "#/history") {
      if (!this.historyOpen) this.historySelection = null;
      this.historyOpen = true;
      this.currentPageId = null;
      this.notify();
      return;
    }
    this.historyOpen = false;
    this.historySelection = null;
    const pageId = window.location.hash.match(/^#\/page\/([^/]+)$/)?.[1];
    if (pageId) {
      this.currentPageId = decodeURIComponent(pageId);
      this.notify();
      return;
    }
    this.currentPageId = null;
    const match = window.location.hash.match(/^#\/session\/([^/]+)$/);
    this.currentId = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (this.fileMentionRequest?.sessionId !== this.currentId) this.fileMentionRequest = null;
    if (this.currentId) void this.ensureLoaded(this.currentId);
    try {
      if (this.currentId) localStorage.setItem(LAST_SESSION_KEY, this.currentId);
      else localStorage.removeItem(LAST_SESSION_KEY);
    } catch { /* 忽略 */ }
    this.notify();
  };

  private isMobileNavigation(): boolean {
    return typeof window !== "undefined" && window.matchMedia?.("(max-width: 720px)").matches === true;
  }

  private onPopState = (): void => {
    if (this.writingHash) return;
    if (!this.isMobileNavigation() && !this.readMobileEntry()) {
      if (this.desktopBackPending) {
        this.desktopBackPending = false;
        this.syncDesktopPanels();
      } else if (!this.readDesktopPanelEntry() && this.filesOpen && !this.filePreview && this.fileBrowserBack?.()) {
        // 浏览器已退到面板前的条目；恢复面板这一条，再由目录浏览器处理返回。
        this.syncDesktopPanels();
        return;
      } else if (this.closeLatestDesktopPanel()) return;
      this.onHashChange();
      return;
    }
    if (this.mobileBackPending && this.readMobileEntry()?.id !== this.mobileBackPending) this.mobileBackPending = null;
    if (this.isMobileNavigation() || this.readMobileEntry()) this.onHashChange();
  };

  private readDesktopPanelEntry(): DesktopPanelEntry | null {
    const entry = window.history?.state?.workbenchDesktopPanels;
    return entry?.version === 1 && typeof entry.id === "string" && entry.route?.hash === window.location.hash
      && Array.isArray(entry.order) && entry.order.every((side: unknown) => side === "sidebar" || side === "right")
      ? entry : null;
  }

  private desktopPanelActive(side: DesktopPanelSide): boolean {
    return side === "sidebar" ? this.historyOpen || this.currentPageId !== null
      : this.filesOpen || this.termOpen || this.dispatchesOpen;
  }

  private desktopPanelHash(): string {
    return this.dispatchesOpen ? this.desktopDispatchHash : this.historyOpen ? "#/history"
      : this.currentPageId ? `#/page/${encodeURIComponent(this.currentPageId)}`
      : this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/";
  }

  private syncDesktopPanels(opened?: DesktopPanelSide): void {
    this.desktopPanelOrder = this.desktopPanelOrder.filter(side => this.desktopPanelActive(side));
    for (const side of ["sidebar", "right"] as const) {
      if (this.desktopPanelActive(side) && !this.desktopPanelOrder.includes(side)) this.desktopPanelOrder.push(side);
    }
    if (opened) this.desktopPanelOrder = [...this.desktopPanelOrder.filter(side => side !== opened), opened];
    const hash = this.desktopPanelHash();
    if (!window.history?.pushState) { window.location.hash = hash; return; }
    const previous = this.readDesktopPanelEntry();
    if (!this.desktopPanelOrder.length) {
      if (previous && this.desktopPanelEntryId === previous.id && !this.desktopBackPending) {
        this.desktopBackPending = true;
        window.history.back();
      } else if (previous && !this.desktopBackPending) {
        const { workbenchDesktopPanels: _desktop, workbenchNavigation: _mobile, ...state } = window.history.state ?? {};
        window.history.replaceState(state, "", hash);
      }
      return;
    }
    const route = { ...this.captureMobileRoute(), hash };
    const entry: DesktopPanelEntry = { version: 1, id: previous?.id ?? mobileEntryId(), route, order: [...this.desktopPanelOrder] };
    const { workbenchNavigation: _mobile, workbenchDesktopPanels: _desktop, ...state } = window.history.state ?? {};
    if (previous) window.history.replaceState({ ...state, workbenchDesktopPanels: entry }, "", hash);
    else {
      const base = this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/";
      window.history.replaceState(state, "", base);
      window.history.pushState({ ...state, workbenchDesktopPanels: entry }, "", hash);
      this.desktopPanelEntryId = entry.id;
    }
  }

  private closeLatestDesktopPanel(): boolean {
    this.desktopPanelOrder = this.desktopPanelOrder.filter(side => this.desktopPanelActive(side));
    const side = this.desktopPanelOrder.pop();
    if (!side) return false;
    if (side === "sidebar") {
      this.historyOpen = false;
      this.historySelection = null;
      this.currentPageId = null;
    } else {
      this.filesOpen = false;
      this.termOpen = false;
      this.dispatchesOpen = false;
      this.beforeDispatches = null;
    }
    const { workbenchNavigation: _mobile, workbenchDesktopPanels: _desktop, ...state } = window.history.state ?? {};
    const base = this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/";
    window.history.replaceState(state, "", base);
    this.syncDesktopPanels();
    this.notify();
    return true;
  }

  private mobileRouteFromHash(hash: string): MobileRoute {
    const session = hash.match(/^#\/session\/([^/]+)$/)?.[1];
    const page = hash.match(/^#\/page\/([^/]+)$/)?.[1];
    const dispatchesOpen = /^#\/dispatches(?:\/[^?]+)?(?:\?runs=.*)?$/.test(hash);
    const termOpen = hash === "#/terminal";
    const filesOpen = hash === "#/files";
    const historyOpen = hash === "#/history";
    const panel = dispatchesOpen || termOpen || filesOpen;
    return {
      hash,
      currentId: session ? decodeURIComponent(session) : panel || page || historyOpen ? this.currentId : null,
      currentPageId: page ? decodeURIComponent(page) : panel ? this.currentPageId : null,
      historyOpen: historyOpen || (panel && this.historyOpen),
      historySelection: historyOpen || (panel && this.historyOpen) ? this.historySelection : null,
      dispatchesOpen, termOpen, filesOpen,
    };
  }

  private captureMobileRoute(): MobileRoute {
    return {
      hash: window.location.hash || "#/", currentId: this.currentId,
      currentPageId: this.currentPageId, historyOpen: this.historyOpen,
      historySelection: this.historySelection, dispatchesOpen: this.dispatchesOpen,
      termOpen: this.termOpen, filesOpen: this.filesOpen,
    };
  }

  private readMobileEntry(): MobileEntry | null {
    const entry = window.history?.state?.workbenchNavigation;
    const validRoute = (route: MobileRoute | undefined): route is MobileRoute => Boolean(route
      && typeof route.hash === "string"
      && (route.currentId === null || typeof route.currentId === "string")
      && (route.currentPageId === null || typeof route.currentPageId === "string")
      && (route.historySelection === null || typeof route.historySelection === "object")
      && [route.historyOpen, route.dispatchesOpen, route.termOpen, route.filesOpen].every((flag) => typeof flag === "boolean"));
    if (entry?.version !== 1 || entry.route?.hash !== (window.location.hash || "#/")) return null;
    const seen = new Set<MobileSource>();
    for (let source: MobileSource | undefined = entry; source; source = source.source) {
      if (seen.has(source) || typeof source.id !== "string" || !validRoute(source.route)) return null;
      seen.add(source);
    }
    return entry;
  }

  private writeMobileEntry(entry: MobileEntry): void {
    const { workbenchDesktopPanels: _desktop, ...state } = window.history.state ?? {};
    window.history.replaceState({ ...state, workbenchNavigation: entry }, "", entry.route.hash);
  }

  private replaceMobileEntry(route: MobileRoute, source?: MobileSource): MobileEntry {
    const entry: MobileEntry = { version: 1, id: mobileEntryId(), route, source };
    this.writeMobileEntry(entry);
    return entry;
  }

  private syncMobileRoute(): void {
    const entry = this.readMobileEntry();
    if (entry) this.writeMobileEntry({ ...entry, route: this.captureMobileRoute() });
  }

  private syncDesktopMobilePanel(): void {
    const entry = this.readMobileEntry();
    if (!entry || !(entry.route.termOpen || entry.route.filesOpen)) return;
    // 桌面开关不 push/back；只修正继承自手机的 URL/state，避免缩回或刷新时复活。
    const route = this.captureMobileRoute();
    route.hash = this.termOpen ? "#/terminal" : this.filesOpen ? "#/files"
      : this.historyOpen ? "#/history" : this.currentPageId ? `#/page/${encodeURIComponent(this.currentPageId)}`
      : this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/";
    this.writeMobileEntry({ ...entry, route });
  }

  private applyMobileRoute(route: MobileRoute): void {
    if (route.currentId && (this.removed.has(route.currentId) || (this.sessionsLoaded && !this.session(route.currentId)))) {
      route = { ...route, currentId: null, hash: route.hash.startsWith("#/session/") ? "#/" : route.hash };
      const entry = this.readMobileEntry();
      if (entry) this.writeMobileEntry({ ...entry, route });
    }
    this.currentId = route.currentId;
    this.currentPageId = route.currentPageId;
    this.historyOpen = route.historyOpen;
    this.historySelection = route.historySelection;
    this.dispatchesOpen = route.dispatchesOpen;
    this.termOpen = route.termOpen;
    this.filesOpen = route.filesOpen;
    this.beforeDispatches = null;
    if (this.fileMentionRequest?.sessionId !== this.currentId) this.fileMentionRequest = null;
    if (this.currentId) void this.ensureLoaded(this.currentId);
    try {
      if (this.currentId) localStorage.setItem(LAST_SESSION_KEY, this.currentId);
      else localStorage.removeItem(LAST_SESSION_KEY);
    } catch { /* 忽略 */ }
    this.notify();
  }

  private pushMobileRoute(hash: string, destination?: MobileRoute): void {
    // 列表与预览共用 hash；显式目的视图允许为首次预览压入同 hash 的 state 条目。
    if (this.mobileBackPending || (window.location.hash === hash && !destination)) return;
    const route = this.captureMobileRoute();
    const previous = this.readMobileEntry() ?? this.replaceMobileEntry(route);
    // 历史预览等非 URL 状态可能刚刚改变，也一并保存在来源条目。
    window.history.replaceState({ ...window.history.state, workbenchNavigation: { ...previous, route } }, "", route.hash);
    const entry: MobileEntry = {
      version: 1, id: mobileEntryId(), route: destination ?? this.mobileRouteFromHash(hash),
      source: { id: previous.id, route, source: previous.source },
    };
    this.mobilePredecessors.set(entry.id, previous.id);
    window.history.pushState({ workbenchNavigation: entry }, "", hash);
    this.onHashChange();
  }

  private returnMobileRoute(fallbackHash: string): void {
    if (this.mobileBackPending) return;
    const entry = this.readMobileEntry();
    if (entry?.source && this.mobilePredecessors.get(entry.id) === entry.source.id) {
      this.mobileBackPending = entry.id;
      window.history.back();
      return;
    }
    // 冷启动/刷新/外部链接不能证明上一条是来源，不退出应用，也不再压一个条目。
    const route = entry?.source?.route ?? this.mobileRouteFromHash(fallbackHash);
    this.replaceMobileEntry(route, entry?.source?.source);
    this.applyMobileRoute(route);
  }

  backFromSession(): void {
    if (this.isMobileNavigation()) this.returnMobileRoute("#/");
    else this.navigate(null);
  }

  navigate(id: string | null): void {
    const hash = id ? `#/session/${encodeURIComponent(id)}` : "#/";
    if (this.isMobileNavigation()) { this.pushMobileRoute(hash); return; }
    this.writeHash(hash);
    this.onHashChange();
  }

  private writeHash(hash: string): void {
    this.writingHash = true;
    try { window.location.hash = hash; } finally { this.writingHash = false; }
  }

  navigatePage(id: string): void {
    const hash = `#/page/${encodeURIComponent(id)}`;
    if (this.isMobileNavigation()) { this.pushMobileRoute(hash); return; }
    this.currentPageId = id;
    this.historyOpen = false;
    this.historySelection = null;
    this.syncDesktopPanels("sidebar");
    this.notify();
  }

  setHistoryCwdFilter(cwd: string): void {
    const next = normalizeHistoryDirectory(cwd, this.meta?.homeDir);
    if (next === this.historyCwdFilter) return;
    this.historyCwdFilter = next;
    this.notify();
  }

  navigateHistory(cwd?: string): void {
    if (cwd !== undefined) this.setHistoryCwdFilter(cwd);
    if (this.isMobileNavigation()) { this.pushMobileRoute("#/history"); return; }
    this.historyOpen = true;
    this.currentPageId = null;
    this.historySelection = null;
    this.syncDesktopPanels("sidebar");
    this.notify();
  }

  toggleDispatches(): void {
    if (this.dispatchesOpen) this.closeDispatches();
    else {
      if (this.isMobileNavigation()) { this.pushMobileRoute("#/dispatches"); return; }
      this.navigateDispatches();
    }
  }

  navigateDispatches(runIds: string[] = []): void {
    const hash = runIds.length === 1 ? `#/dispatches/${encodeURIComponent(runIds[0]!)}`
      : runIds.length ? `#/dispatches?runs=${runIds.map(encodeURIComponent).join(",")}` : "#/dispatches";
    if (this.isMobileNavigation()) {
      if (!runIds.length && this.dispatchesOpen && window.location.hash !== hash) this.returnMobileRoute(hash);
      else this.pushMobileRoute(hash);
      return;
    }
    this.dispatchesOpen = true;
    this.filesOpen = false;
    this.termOpen = false;
    this.desktopDispatchHash = hash;
    this.syncDesktopPanels("right");
    this.notify();
  }

  /** 派单详情的「返回」回流程图（高亮该派单）；手机从会话直达详情时原地换成流程图，流程图再返回即回会话。 */
  backFromDispatchDetail(runId: string): void {
    if (!this.isMobileNavigation()) { this.navigateDispatches(); return; }
    if (this.mobileBackPending) return;
    const entry = this.readMobileEntry();
    const source = entry?.source;
    const verified = Boolean(entry && source && this.mobilePredecessors.get(entry.id) === source.id);
    // 来源本身是流程图：可证实相邻就 back，刷新后无法证实则原地还原为该流程图（returnMobileRoute 兜底）。
    if (source?.route.dispatchesOpen && !/^#\/dispatches\//.test(source.route.hash)) {
      this.returnMobileRoute("#/dispatches");
      return;
    }
    const route = this.mobileRouteFromHash(`#/dispatches?runs=${encodeURIComponent(runId)}`);
    const replaced = this.replaceMobileEntry(route, source);
    if (verified) this.mobilePredecessors.set(replaced.id, source!.id);
    this.applyMobileRoute(route);
  }

  closeDispatches(): void {
    if (this.isMobileNavigation()) { this.returnMobileRoute(this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/"); return; }
    if (this.desktopPanelOrder.includes("right")) {
      this.dispatchesOpen = false;
      this.beforeDispatches = null;
      this.syncDesktopPanels();
      this.notify();
      return;
    }
    const previous = this.beforeDispatches;
    this.currentId = previous?.currentId ?? null;
    this.writeHash(previous?.hash ?? "#/");
    this.onHashChange();
    if (this.historyOpen) this.historySelection = previous?.selection ?? null;
    this.notify();
  }

  setTerminalOpen(open: boolean): void {
    if (this.isMobileNavigation()) {
      if (open) this.pushMobileRoute("#/terminal");
      else if (this.termOpen) this.returnMobileRoute(this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/");
      return;
    }
    if (open) { this.filesOpen = false; this.dispatchesOpen = false; this.beforeDispatches = null; }
    this.termOpen = open;
    this.syncDesktopMobilePanel();
    this.syncDesktopPanels(open ? "right" : undefined);
    this.notify();
  }

  setFilesOpen(open: boolean): void {
    if (this.isMobileNavigation()) {
      if (open) this.pushMobileRoute("#/files");
      else if (this.filesOpen) this.returnMobileRoute(this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/");
      return;
    }
    if (open) { this.termOpen = false; this.dispatchesOpen = false; this.beforeDispatches = null; }
    this.filesOpen = open;
    this.syncDesktopMobilePanel();
    this.syncDesktopPanels(open ? "right" : undefined);
    this.notify();
  }

  requestFileMention(sessionId: string, path: string): void {
    this.fileMentionRequest = { sessionId, path, version: ++this.fileMentionSequence };
    this.notify();
  }

  private canReplaceFile(): boolean {
    if (this.filePreview?.saving) return false;
    const preview = this.filePreview;
    return !preview?.file?.editable || preview.draft === preview.file.text ||
      window.confirm("文件有未保存修改。放弃修改并离开此文件？");
  }

  async openFilePreview(target: WorkFileTarget): Promise<void> {
    if (!this.canReplaceFile()) return;
    if (!this.fileUnloadBound && typeof window !== "undefined") {
      window.addEventListener("beforeunload", event => {
        const preview = this.filePreview;
        if (preview?.file?.editable && (preview.saving || preview.draft !== preview.file.text)) {
          event.preventDefault(); event.returnValue = "";
        }
      });
      this.fileUnloadBound = true;
    }
    this.fileLoad?.abort();
    const abort = new AbortController(); this.fileLoad = abort;
    const preview: FilePreviewState = { target, file: null, draft: "", loading: true, saving: false, error: null, loadId: ++this.fileLoadSequence };
    this.filePreview = preview;
    this.fileDirectory = target.root;
    this.setFilesOpen(true);
    this.notify();
    try {
      const file = await fetchWorkFile(target, AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
      if (this.filePreview !== preview) return;
      this.filePreview = { ...preview, file, draft: file.text ?? "", loading: false };
    } catch (error) {
      if (this.filePreview !== preview || abort.signal.aborted) return;
      this.filePreview = { ...preview, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.notify();
  }

  clearFilePreview(): boolean {
    if (!this.canReplaceFile()) return false;
    this.fileLoad?.abort(); this.filePreview = null; this.notify(); return true;
  }

  updateFileDraft(draft: string): void {
    if (!this.filePreview?.file?.editable || this.filePreview.saving) return;
    this.filePreview = { ...this.filePreview, draft }; this.notify();
  }

  async saveFilePreview(): Promise<void> {
    const previous = this.filePreview;
    if (!previous?.file?.editable || !previous.file.version || previous.saving) return;
    const saving = { ...previous, saving: true, error: null };
    this.filePreview = saving; this.notify();
    try {
      const file = await saveWorkFile(previous.target, previous.file.version, previous.draft);
      if (this.filePreview !== saving) return;
      this.filePreview = { ...previous, file, draft: file.text ?? previous.draft, saving: false, error: null };
    } catch (error) {
      if (this.filePreview !== saving) return;
      this.filePreview = { ...previous, saving: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.notify();
  }

  consumeFileMention(version: number): boolean {
    if (this.fileMentionRequest?.version !== version) return false;
    this.fileMentionRequest = null;
    this.notify();
    return true;
  }

  closeSidebarPanel(returnToList = false): void {
    if (this.isMobileNavigation()) { this.returnMobileRoute(this.currentId ? `#/session/${encodeURIComponent(this.currentId)}` : "#/"); return; }
    this.historyOpen = false;
    this.currentPageId = null;
    this.historySelection = null;
    if (returnToList) this.currentId = null;
    this.syncDesktopPanels();
    this.notify();
  }

  selectHistory(item: HistorySession): void {
    if (!this.historyOpen) return;
    if (this.isMobileNavigation()) {
      if (this.mobileBackPending) return;
      if (!this.historySelection) {
        this.pushMobileRoute("#/history", { ...this.captureMobileRoute(), hash: "#/history", historySelection: item });
        return;
      }
      // 在预览中换选只更新当前条目，保留列表来源，避免堆叠预览。
    }
    this.historySelection = item;
    this.syncMobileRoute();
    if (!this.isMobileNavigation()) this.syncDesktopPanels();
    this.notify();
  }

  backToHistoryList(): void {
    if (this.isMobileNavigation()) {
      if (this.mobileBackPending) return;
      const entry = this.readMobileEntry();
      if (entry?.source?.route.historyOpen && !entry.source.route.historySelection) {
        this.returnMobileRoute("#/history");
      } else {
        // 兼容旧版 replace 预览与无来源的冷启动 state：只清预览，不退到外部页面。
        const route = { ...this.captureMobileRoute(), historySelection: null };
        this.replaceMobileEntry(route, entry?.source);
        this.applyMobileRoute(route);
      }
      return;
    }
    this.historySelection = null;
    this.syncMobileRoute();
    if (!this.isMobileNavigation()) this.syncDesktopPanels();
    this.notify();
  }

  /** 扩展页面列表：只在启动时取一次（server 也只在启动时扫描 pages/，增删要重启才生效）。 */
  async refreshPages(): Promise<void> {
    try {
      const { supported, skipped } = partitionPages(await fetchPages());
      this.pages = supported;
      this.skippedPages = skipped;
    } catch (error) {
      this.lastError = { message: error instanceof Error ? error.message : String(error) };
    }
    this.notify();
  }

  session(id: string): SessionRecord | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  pendingCount(id: string): number {
    if (this.session(id)?.status === "dead") return 0;
    return this.data.get(id)?.pendingGates.size ?? this.session(id)?.pendingGateCount ?? 0;
  }

  async refreshSessions(): Promise<void> {
    const organizationVersion = this.organizationVersion;
    try {
      const sessions = await fetchSessions();
      // REST 请求途中收到的较新 WS 摘要不能被旧列表覆盖。
      // 已 DELETE 的会话同理：旧的列表响应不得把它复活成打不开的残行。
      this.sessions = sessions.filter((session) => !this.removed.has(session.id)).map((session) => {
        const live = this.session(session.id);
        return this.mergeSessionSummary(session, live, organizationVersion !== this.organizationVersion);
      });
      this.sessionsLoaded = true;
      if (this.isMobileNavigation() && this.currentId && !this.session(this.currentId)) this.onHashChange();
    } catch (error) {
      this.lastError = { message: error instanceof Error ? error.message : String(error) };
    }
    // dead 会话的未决闸门已不可操作，清掉避免僵尸暖色徽标。
    for (const session of this.sessions) {
      const data = this.data.get(session.id);
      if (session.status === "dead" && data && data.pendingGates.size > 0) {
        data.pendingGates.clear();
        const retained = data.paged ? { events: data.events, omitted: 0 } : retainEventWindow(data.events, data.pendingGates);
        data.events = retained.events;
        data.dropped += retained.omitted;
        // Map 本身可变；替换外层对象，selector 才能可靠观察到该会话数据变化。
        this.data.set(session.id, { ...data });
      }
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
    const organizationVersion = this.organizationVersion;
    this.olderInflight.delete(id);
    const buffered = this.snapshotBuffers.get(id) ?? [];
    this.snapshotBuffers.set(id, buffered);
    // 先声明再赋值（! 断言）：finally 里的所有权校验要引用 promise 自身，赋值在闭包执行前完成
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const snapshot = await fetchSnapshot(id, true);
        if (this.snapshotGen.get(id) === gen) {
          const live = this.session(id);
          const session = organizationVersion !== this.organizationVersion && live
            ? { ...snapshot.session, pinned: live.pinned, customTitle: live.customTitle, groupId: live.groupId }
            : snapshot.session;
          this.applySnapshot(id, session, snapshot.seq, snapshot.events, snapshot.hasMore, snapshot.firstSeq);
          this.snapshotBuffers.delete(id);
          // 先解除在途状态，缓存中的缺口才可发起下一次必要的快照。
          if (this.snapshotInflight.get(id) === promise) this.snapshotInflight.delete(id);
          for (const event of buffered.sort((a, b) => a.seq - b.seq || Number(!!a.ephemeral) - Number(!!b.ephemeral))) this.handleEvent(event);
        }
      } catch (error) {
        if (this.snapshotGen.get(id) === gen) {
          const message = error instanceof Error ? error.message : String(error);
          this.lastError = { message, sessionId: id };
          const current = this.data.get(id);
          // 对齐已作废旧页；对齐本身失败时，不能把旧窗口锁在 loadingOlder。
          if (current?.loadingOlder) this.data.set(id, { ...current, loadingOlder: false, olderError: message });
        }
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

  /**
   * 作废 in-flight 快照响应并强制重取（显式刷新 / resync_required / WS 重连）。
   * 旧 data 保留到新快照完整落地，避免当前会话闪回「载入会话…」并破坏滚动/展开状态。
   */
  resync(id: string): Promise<void> {
    // 作废旧响应靠 alignSnapshot 新分配的唯一 generation（旧响应必不匹配），无需手动自增
    this.snapshotInflight.delete(id);
    return this.alignSnapshot(id);
  }

  /** 历史 prepend 不推进 replay 游标，也不回放旧事件覆盖当前派生状态。 */
  loadOlder(id: string, beforePrepend?: () => void): Promise<void> {
    const inflight = this.olderInflight.get(id);
    if (inflight) return inflight;
    const data = this.data.get(id);
    if (!data?.hasMore || !data.firstSeq || data.loadingOlder || this.snapshotInflight.has(id) || this.removed.has(id)) return Promise.resolve();
    const beforeSeq = data.firstSeq;
    const gen = this.snapshotGen.get(id);
    this.data.set(id, { ...data, loadingOlder: true, olderError: undefined });
    this.notify();
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const page = await fetchEarlierEvents(id, beforeSeq);
        const current = this.data.get(id);
        if (!current || this.snapshotGen.get(id) !== gen || current.firstSeq !== beforeSeq || this.removed.has(id)) return;
        // 服务端响应必须严格推进历史游标；异常保留旧窗口并提供重试。
        if (page.events.some((event) => event.seq >= beforeSeq)
          || (page.hasMore && (page.firstSeq <= 0 || page.firstSeq >= beforeSeq))
          || page.firstSeq !== (page.events[0]?.seq ?? 0)) throw new Error("更早消息的分页游标无效");
        const seen = new Set(current.events.filter((event) => !event.ephemeral).map((event) => event.seq));
        const earlier = page.events.filter((event) => {
          if (seen.has(event.seq)) return false;
          seen.add(event.seq);
          return true;
        });
        if (earlier.length > 0) beforePrepend?.();
        this.data.set(id, {
          ...current,
          events: [...earlier, ...current.events].sort((a, b) => a.seq - b.seq || Number(!!a.ephemeral) - Number(!!b.ephemeral)),
          firstSeq: page.firstSeq || current.firstSeq,
          hasMore: page.hasMore,
          loadingOlder: false,
          olderError: undefined,
          prependVersion: (current.prependVersion ?? 0) + Number(earlier.length > 0),
        });
      } catch (error) {
        const current = this.data.get(id);
        if (current && this.snapshotGen.get(id) === gen && current.firstSeq === beforeSeq) {
          this.data.set(id, { ...current, loadingOlder: false, olderError: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (this.olderInflight.get(id) === promise) this.olderInflight.delete(id);
        this.notify();
      }
    })();
    this.olderInflight.set(id, promise);
    return promise;
  }

  promptCacheExpiry(id: string): number | null {
    const data = this.data.get(id);
    return data?.promptCacheTtlMs != null && data.promptCacheUsageAt != null
      ? data.promptCacheUsageAt + data.promptCacheTtlMs : null;
  }

  /** 定位条发现未决闸门不在当前 DOM 时：明确提示并用权威快照恢复。 */
  recoverMissingPendingGate(id: string): Promise<void> {
    this.lastError = {
      message: "待处理闸门不在当前事件窗口，正在重新载入会话快照，请稍后再试。",
      sessionId: id,
    };
    this.notify();
    return this.resync(id);
  }

  private applySnapshot(
    id: string,
    session: SessionRecord,
    seq: number,
    events: UnifiedEvent[],
    hasMore?: boolean,
    firstSeq?: number,
  ): void {
    const pendingGates = new Map<string, number>();
    let latestUsage = session.snapshotState?.latestUsage;
    let commands = session.snapshotState?.commands;
    const cache = { promptCacheTtlMs: session.snapshotState?.promptCacheTtlMs ?? null, promptCacheUsageAt: session.snapshotState?.promptCacheUsageAt ?? null };
    // dead 会话的 permission_request 不计入 pending：进程已不在，闸门不可操作。
    const dead = session.status === "dead";
    for (const event of events) {
      if (event.type === "permission_request") {
        if (!dead) pendingGates.set(String(event.payload.requestId ?? ""), event.seq);
      } else if (event.type === "permission_resolved") {
        pendingGates.delete(String(event.payload.requestId ?? ""));
      } else if (event.type === "process_exited") {
        pendingGates.clear();
      } else if (event.type === "usage_updated") {
        latestUsage = event.payload;
        updatePromptCache(cache, event);
      } else if (event.type === "commands_updated") {
        commands = commandsFromPayload(event.payload);
      }
    }
    // 快照内可能正好夹着一次未完成的重启切换（config_update_started 之后
    // 还没有 config_updated/session_error）：重建过渡态，切换中文案不丢。
    let switching = session.snapshotState?.configSwitching;
    for (const event of events) {
      if (event.type === "config_update_started") {
        switching = switchMessageFromPayload(event.payload);
      } else if (event.type === "config_updated" || event.type === "session_error") {
        switching = undefined;
      }
    }
    if (switching) this.configSwitching.set(id, switching);
    else this.configSwitching.delete(id);
    if (commands) this.commands.set(id, commands);
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const paged = hasMore !== undefined;
    const { events: retained, omitted: dropped } = paged ? { events: sorted, omitted: 0 } : retainEventWindow(sorted, pendingGates);
    this.data.set(id, { events: retained, seq, dropped, pendingGates, latestUsage, paged, hasMore, firstSeq: firstSeq ?? sorted[0]?.seq ?? 0, ...cache });
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index >= 0) {
      const next = [...this.sessions];
      next[index] = { ...session, title: session.title ?? sessionTitle({}, events), pendingGateCount: pendingGates.size };
      this.sessions = next;
    } else {
      this.sessions = [...this.sessions, { ...session, title: session.title ?? sessionTitle({}, events), pendingGateCount: pendingGates.size }];
    }
  }

  /** 网络恢复：旧连接多半已经死了（可能还显示 OPEN，或卡在 CONNECTING），直接换新的。 */
  private onOnline = (): void => this.reconnectNow(true);

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      return;
    }
    // 离开超过 30 秒：iOS 常留下 readyState 仍是 OPEN 的死连接，直接换新的。
    const longAway = this.hiddenAt > 0 && Date.now() - this.hiddenAt > 30_000;
    this.hiddenAt = 0;
    this.reconnectNow(longAway);
  };

  /** 立即重连：跳过退避等待；force=true 时，连看似健康的连接也换掉。 */
  reconnectNow(force = false): void {
    if (!force && this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectDelay = 1000;
    const stale = this.socket;
    this.socket = null;
    stale?.close();
    this.connect();
  }

  private connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.wsState = "connecting";
    this.notify();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;
    for (const id of this.data.keys()) this.replayBuffers.set(id, []);

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return; // 已被 reconnectNow 换掉的旧连接
      this.wsState = "open";
      this.reconnectDelay = 1000;
      const reconnected = this.hasOpenedSocket;
      this.hasOpenedSocket = true;
      void this.alignAfterSocketOpen(reconnected, socket);
      this.notify();
    });
    socket.addEventListener("message", (messageEvent) => {
      if (this.socket !== socket) return; // 已被 reconnectNow 换掉的旧连接
      try {
        this.handleFrame(JSON.parse(String(messageEvent.data)) as Record<string, unknown>);
      } catch {
        // 无法解析的帧直接忽略。
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return; // 已被 reconnectNow 换掉的旧连接
      this.wsState = "closed";
      this.socket = null;
      this.notify();
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  private async alignAfterSocketOpen(reconnected: boolean, socket = this.socket): Promise<void> {
    await Promise.all([this.refreshSessions(), this.refreshSessionGroups()]);
    if (this.socket !== socket) return;
    // 列表恢复未加载会话的审批数；已加载会话通过同一条全局连接按各自游标补发。
    for (const [id, data] of this.data) {
      if (this.removed.has(id) || !this.session(id)) { this.replayBuffers.delete(id); continue; }
      if (reconnected && this.snapshotInflight.has(id)) {
        this.replayBuffers.delete(id);
        void this.resync(id);
      } else if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "replay", sessionId: id, afterSeq: data.seq }));
      }
    }
    if (reconnected) {
      for (const id of this.snapshotInflight.keys()) {
        if (!this.data.has(id)) void this.resync(id);
      }
    }
    if (this.currentId && !this.data.has(this.currentId)) await this.ensureLoaded(this.currentId);
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = String(frame.type ?? "");
    if (type === "session_organization_updated") {
      if (!Array.isArray(frame.sessions) || !Array.isArray(frame.groups)) return;
      this.organizationVersion++;
      this.sessions = (frame.sessions as SessionRecord[]).filter((session) => !this.removed.has(session.id))
        .map((session) => this.mergeSessionSummary(session, this.session(session.id)));
      this.sessionGroups = frame.groups as SessionGroup[];
      this.notify();
      return;
    }
    if (type === "ready") return;
    if (type === "replay_complete") {
      const id = String(frame.sessionId ?? "");
      const buffered = this.replayBuffers.get(id) ?? [];
      this.replayBuffers.delete(id);
      for (const event of buffered.sort((a, b) => a.seq - b.seq || Number(!!a.ephemeral) - Number(!!b.ephemeral))) this.handleEvent(event);
      return;
    }
    if (type === "ack") {
      // 服务端受理回执：丢弃对应发送暂存（回显随后到，或已先到）
      const requestId = typeof frame.clientRequestId === "string" ? frame.clientRequestId : "";
      const stashed = this.sendStash.get(requestId);
      if (stashed && (frame.sessionId === undefined || frame.sessionId === stashed.sessionId)
        && (frame.action === undefined || frame.action === "user_message")) this.sendStash.delete(requestId);
      return;
    }
    if (type === "resync_required") {
      const id = String(frame.sessionId ?? "");
      if (id) { this.replayBuffers.delete(id); void this.resync(id); }
      return;
    }
    if (type === "error") {
      const msg = String(frame.msg ?? "未知错误");
      const sid = typeof frame.sessionId === "string" ? frame.sessionId : "";
      // 带 clientRequestId 的发送拒绝：按 id 归因（不进 configPending 的配置错误路径），
      // 暂存丢弃、错误照告；仅当草稿仍为空（发送间隙没有新输入）才把文本写回草稿并请 Composer 还回文本与引用。
      const requestId = typeof frame.clientRequestId === "string" ? frame.clientRequestId : "";
      const stashed = requestId ? this.sendStash.get(requestId) : undefined;
      if (stashed) {
        this.sendStash.delete(requestId);
        if (this.getDraft(stashed.sessionId).trim() === "") {
          this.setDraft(stashed.sessionId, stashed.text);
          this.sendTextRestore = { sessionId: stashed.sessionId, text: stashed.text, mentions: stashed.mentions ?? [], version: ++this.sendRestoreSequence };
        }
        this.lastError = { message: msg, sessionId: stashed.sessionId };
        this.notify();
        return;
      }
      // 补发失败：放掉补发缓存（否则该会话事件永远卡在缓存里），退回快照对齐
      if (sid && frame.action === "replay" && this.replayBuffers.delete(sid)) void this.resync(sid);
      // set_config 在等结果的会话：配置相关错误归到配置控件旁，不进全局提示条；
      // user_message 等其他动作的报错按 action 归因进全局条，不再误落配置控件。
      if (sid && this.configPending.has(sid) && frame.action !== "user_message") {
        this.configPending.delete(sid);
        this.configErrors.set(sid, msg);
      } else {
        this.lastError = sid ? { message: msg, sessionId: sid } : { message: msg };
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
    const replayBuffer = this.replayBuffers.get(event.sessionId);
    if (replayBuffer) { replayBuffer.push(event); return; }
    if (this.snapshotInflight.has(event.sessionId)) {
      const buffer = this.snapshotBuffers.get(event.sessionId) ?? [];
      buffer.push(event);
      this.snapshotBuffers.set(event.sessionId, buffer);
      return;
    }
    if (event.ephemeral) {
      if (data && event.type === "tool_call_updated") {
        const events = data.events.filter((item) => !(item.ephemeral && item.payload.toolCallId === event.payload.toolCallId));
        // 断线前的迟到临时帧不得覆盖已完成工具的最终参数。
        if (!events.some((item) => item.payload.toolCallId === event.payload.toolCallId
          && (item.type === "tool_call_completed" || item.payload.inputComplete))) {
          events.push(event);
          this.data.set(event.sessionId, { ...data, events });
          this.notifyStreamDelta();
        }
      }
      return;
    }
    if (data) {
      // 快照语义：只追加 seq 更大的事件；出现缺口则重取快照。
      if (event.seq > data.seq + 1) {
        this.snapshotBuffers.set(event.sessionId, [event]);
        void this.alignSnapshot(event.sessionId);
        return;
      }
      if (event.seq === data.seq + 1) {
        if (event.type === "tool_call_completed" || event.payload.inputComplete) {
          data.events = data.events.filter((item) => !(item.ephemeral && item.payload.toolCallId === event.payload.toolCallId));
        }
        data.events.push(event);
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
          updatePromptCache(data, event);
        } else if (event.type === "commands_updated") {
          // 实时全量覆盖（装新 skill 后立即可见），不是一次性快照。
          this.commands.set(event.sessionId, commandsFromPayload(event.payload));
        } else if (event.type === "config_update_started") {
          // claude model/effort 重启切换开始：控件禁用 + 就地显示后端给的过渡文案，
          // config_updated / session_error 到达才解除（见下方两处）。
          this.configSwitching.set(event.sessionId, switchMessageFromPayload(event.payload));
        } else if (event.type === "session_error") {
          // 切换中途失败（续接 worker 初始化失败等）：解除过渡态，错误就地显示在控件旁，
          // 不渲染成全局故障。
          if (this.configSwitching.delete(event.sessionId)) {
            this.configPending.delete(event.sessionId);
            this.configErrors.set(
              event.sessionId,
              String(event.payload.message ?? "切换失败"),
            );
          }
        }
        // 分页不裁剪完整回合；旧服务端兼容窗口仍保护未决 permission_request。
        const retained = data.paged ? { events: data.events, omitted: 0 } : retainEventWindow(data.events, data.pendingGates);
        data.events = retained.events;
        data.dropped += retained.omitted;
        // SessionData 内含可变数组/Map；每次有效增量替换外层引用，供 selector 正确比较。
        this.data.set(event.sessionId, { ...data });
      }
      else return; // event.seq <= data.seq：补发重复帧，忽略。
    } else {
      // 未加载会话只维护列表摘要，打开时再取快照。
    }

    // 去重和补发缓存处理之后才确认回显；不以相同文本猜测是哪一次发送。
    // 当前服务端的受理确认走 ack；若回显也带请求 id，只清掉同会话同 id 暂存。
    if (event.type === "user_message") {
      const requestId = event.payload.clientRequestId ?? (event as UnifiedEvent & { clientRequestId?: unknown }).clientRequestId;
      if (typeof requestId === "string" && this.sendStash.get(requestId)?.sessionId === event.sessionId) {
        this.sendStash.delete(requestId);
      }
    }

    // 任何事件都刷新该会话的本地视图（lastActivityAt / 状态推断）。
    const sessionIndex = this.sessions.findIndex((item) => item.id === event.sessionId);
    if (sessionIndex >= 0) {
      const session: SessionRecord = {
        ...this.sessions[sessionIndex]!,
        lastActivityAt: event.timestamp,
      };
      const freshSummary = event.seq > session.seq;
      if (freshSummary) {
        if (event.type === "user_message") {
          session.title = event.title ?? sessionTitle({}, data?.events ?? [event]);
        }
        if (!data) {
          if (event.type === "permission_request" && session.status !== "dead") session.pendingGateCount = (session.pendingGateCount ?? 0) + 1;
          if (event.type === "permission_resolved") session.pendingGateCount = Math.max(0, (session.pendingGateCount ?? 0) - 1);
          if (event.type === "process_exited") session.pendingGateCount = 0;
        }
        session.seq = event.seq;
      } else if (!data) return;
      if (data) session.pendingGateCount = data.pendingGates.size;
      const status = freshSummary ? statusFromEvent(event) : undefined;
      if (status) session.status = status;
      if (event.type === "config_updated") this.applyConfigUpdated(event, session);
      if (event.type === "remote_control_updated") {
        session.remoteControl = event.payload as unknown as SessionRecord["remoteControl"];
      }
      if (event.type === "background_tasks_updated") {
        session.backgroundTasks = event.payload.tasks as SessionRecord["backgroundTasks"];
      }
      if (event.type === "worker_released") {
        // 空闲自动释放没有客户端动作，靠这条事件把列表项对齐成已释放
        session.released = true;
        session.processId = undefined;
      }
      const sessions = [...this.sessions];
      sessions[sessionIndex] = session;
      this.sessions = sessions;
    } else {
      // 新会话（别的客户端建的）：刷新列表。
      void this.refreshSessions();
    }
    this.scheduleListRefresh();
    if (["agent_text_delta", "thought_delta", "tool_call_updated", "raw_event"].includes(event.type)) this.notifyStreamDelta();
    else this.notify();
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
    // claude 的实际生效值与来源随广播一并吸收（codex/kimi 不带这些字段，不动）
    if ("effectiveModel" in payload) session.effectiveModel = payload.effectiveModel as string | null;
    if ("effectiveEffort" in payload) session.effectiveEffort = payload.effectiveEffort as string | null;
    if ("effectiveModelSource" in payload) {
      session.effectiveModelSource = payload.effectiveModelSource as EffectiveSource;
    }
    if ("effectiveEffortSource" in payload) {
      session.effectiveEffortSource = payload.effectiveEffortSource as EffectiveSource;
    }
    this.configPending.delete(event.sessionId);
    this.configSwitching.delete(event.sessionId);
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
    // 帧里带 sessionId 时一并记入错误，toast 可跳转到对应会话
    const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;
    this.lastError = {
      message: "连接已断开，正在重连…",
      ...(sessionId ? { sessionId } : {}),
    };
    this.notify();
    return false;
  }

  /** 文本和结构化命令共用请求 id 与完整输入暂存；断线失败不暂存。 */
  private sendTrackedMessage(sessionId: string, text: string, content: Record<string, unknown>, mentions?: Mention[]): boolean {
    const clientRequestId = `wb-${Date.now()}-${++this.nextClientRequestId}`;
    const sent = this.send({ type: "user_message", sessionId, ...content, clientRequestId });
    if (sent) this.sendStash.set(clientRequestId, {
      sessionId, text,
      ...(mentions?.length ? { mentions: mentions.map((mention) => ({ ...mention })) } : {}),
    });
    return sent;
  }

  /** 上行失败（socket 非 OPEN）返回 false 并置 lastError，调用方据此把文本还回输入框。 */
  sendUserMessage(sessionId: string, text: string, mentions?: Mention[]): boolean {
    return this.sendTrackedMessage(sessionId, text, {
      text, ...(mentions?.length ? { mentions } : {}),
    }, mentions);
  }

  /** 结构化斜杠命令上行：command 与 text 互斥，暂存保留输入框中的原命令。 */
  sendCommand(sessionId: string, name: string, args: string, originalText = `/${name}${args ? ` ${args}` : ""}`): boolean {
    this.clearSendNotice(sessionId);
    if (this.sendBlockReason(sessionId)) return false;
    return this.sendTrackedMessage(sessionId, originalText, { command: { name, arguments: args } });
  }

  /** 本地拦下服务端必拒的发送（有待决闸门 / 配置切换中）：返回拦下原因并就地提示；启动等待不拦。 */
  private sendBlockReason(sessionId: string): string | null {
    const pending = this.pendingCount(sessionId);
    const reason = pending > 0
      ? `有 ${pending} 个待处理的审批闸门，处理后才能发送或插话`
      : this.configSwitching.has(sessionId)
        ? "正在切换配置，请稍候再发送"
        : null;
    if (reason) {
      this.sendNotices.set(sessionId, reason);
      this.notify();
    }
    return reason;
  }

  clearSendNotice(sessionId: string): void {
    if (this.sendNotices.delete(sessionId)) this.notify();
  }

  /** 消费一次性完整还回请求；过期/已消费返回 null，纯图片的空文本仍是有效结果。 */
  consumeSendTextRestore(version: number): Pick<ComposerSendRestore, "text" | "mentions"> | null {
    if (this.sendTextRestore?.version !== version) return null;
    const { text, mentions } = this.sendTextRestore;
    this.sendTextRestore = null;
    this.notify();
    return { text, mentions };
  }

  /**
   * 输入框统一入口：行首「/命令表内名称 + 可选参数」走结构化 command（不附 mentions），
   * 其余一律按普通文本（能力位为 false 的 driver 绝不拼结构化 command）。
   * extraMentions 非空（「+」附件）时不走 command 分支，直接按文本+mentions 发。
   * mentions 能力位 true 时解析 @token：仅确认存在的路径进 mentions，文本原样发送。
   * 全部路径返回是否真正上行（mentions 分支是异步解析，故整体为 Promise）。
   * 真正上行成功时清掉该会话草稿——仅当草稿内容仍是本次发送的文本
   * （发送间隙用户又输入的新内容不能误清）；失败时草稿本来就在，不用动。
   */
  sendComposerInput(sessionId: string, text: string, extraMentions?: Mention[]): Promise<boolean> {
    return this.dispatchComposerInput(sessionId, text, extraMentions).then((ok) => {
      if (ok && this.drafts.get(sessionId)?.trim() === text.trim()) this.clearDraft(sessionId);
      return ok;
    });
  }

  private dispatchComposerInput(sessionId: string, text: string, extraMentions?: Mention[]): Promise<boolean> {
    // 新的发送尝试清掉上一次的拦截提示；服务端必拒的（有待决闸门 / 配置切换中）本地直接拦下
    this.clearSendNotice(sessionId);
    if (this.sendBlockReason(sessionId)) return Promise.resolve(false);
    const session = this.session(sessionId);
    const caps = session ? this.meta?.drivers[session.agent] : undefined;
    const extras = extraMentions ?? [];
    // 附件与结构化 command 互斥：带附件时即使命中命令形态也按文本+mentions 发
    if (extras.length === 0 && caps?.commands) {
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (match) {
        const hit = (this.commands.get(sessionId) ?? []).find((c) => c.name === match[1]);
        if (hit) {
          return Promise.resolve(this.sendCommand(sessionId, hit.name, (match[2] ?? "").trim(), text));
        }
      }
    }
    if (!caps?.mentions) {
      return Promise.resolve(
        this.sendUserMessage(sessionId, text, extras.length > 0 ? extras.slice(0, MAX_MENTIONS) : undefined),
      );
    }
    return this.sendWithMentions(sessionId, text, extras);
  }

  /** 读会话草稿（无草稿返回空串）。内存未命中时回落 localStorage（刷新后恢复）。 */
  getDraft(sessionId: string): string {
    return this.drafts.get(sessionId) ?? readSavedDraft(sessionId);
  }

  /** 写草稿：空文本等价于清除。同步落 localStorage；不 notify——草稿只有 Composer 自己读写。 */
  setDraft(sessionId: string, text: string): void {
    if (text) this.drafts.set(sessionId, text);
    else this.drafts.delete(sessionId);
    writeSavedDraft(sessionId, text || null);
  }

  clearDraft(sessionId: string): void {
    this.drafts.delete(sessionId);
    writeSavedDraft(sessionId, null);
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
        this.mentionVersion++;
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
    this.mentionVersion++;
    this.notify(); // 预览条等读缓存的视图刷新
    return path;
  }

  /** 发送前解析 @token：只把生效路径放进 mentions（去重、≤20），文本原样发送；「+」附件追加在后（同按 path 去重，合计截到 MAX_MENTIONS）。 */
  private async sendWithMentions(sessionId: string, text: string, extraMentions: Mention[] = []): Promise<boolean> {
    const tokens = extractMentionTokens(text).slice(0, MAX_MENTIONS);
    const mentions: Mention[] = [];
    const seen = new Set<string>(); // 不同 token 可能解析到同一路径（@a.ts 与 @a.ts，），按生效路径去重
    for (const token of tokens) {
      const path = await this.resolveMentionPath(sessionId, token);
      if (path && !seen.has(path)) {
        seen.add(path);
        mentions.push({ type: "file", path });
      }
    }
    for (const extra of extraMentions) {
      if (mentions.length >= MAX_MENTIONS) break;
      if (!extra.path || seen.has(extra.path)) continue;
      seen.add(extra.path);
      mentions.push(extra);
    }
    return this.sendUserMessage(sessionId, text, mentions);
  }

  /**
   * 闸门决策上行：socket 非 OPEN 时返回 false 并置 lastError（UI 据此不进「提交中」态），
   * 发送成功返回 true。闸门语义本身不变，这里只暴露发送结果。
   */
  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    /** AskUserQuestion 的回答：key 逐字 = 问题原文；与 updatedInput 互斥（后端同时拒绝两者同发） */
    questionAnswers?: Record<string, string>,
  ): boolean {
    return this.send({
      type: "permission_resolved",
      sessionId,
      requestId,
      decision,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(questionAnswers !== undefined ? { questionAnswers } : {}),
    });
  }

  interrupt(sessionId: string): void {
    this.send({ type: "interrupt", sessionId });
  }

  setRemoteControl(sessionId: string, enabled: boolean): void {
    if (!this.send({ type: "set_remote_control", sessionId, enabled })) {
      this.lastError = { message: "连接已断开，无法切换 Remote Control", sessionId };
      this.notify();
    }
  }

  /**
   * 活改会话配置（WS set_config）。不做乐观更新：控件进入发送中态，
   * 等 config_updated 广播回来才更新显示；失败走 WS error 帧。
   */
  setConfig(sessionId: string, config: Partial<Record<ConfigOptionId, string | null>>): void {
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

  private mergeSessionSummary(incoming: SessionRecord, live?: SessionRecord, preserveOrganization = false): SessionRecord {
    const summary = live && live.seq > incoming.seq ? live : incoming;
    const organization = preserveOrganization && live ? live : incoming;
    return { ...summary, title: organization.title, nativeTitle: organization.nativeTitle,
      pinned: organization.pinned, customTitle: organization.customTitle, groupId: organization.groupId };
  }

  async refreshSessionGroups(): Promise<void> {
    const version = this.organizationVersion;
    try {
      const groups = await fetchSessionGroups();
      if (version === this.organizationVersion) this.sessionGroups = groups;
    } catch (error) {
      this.lastError = { message: error instanceof Error ? error.message : String(error) };
    }
    this.notify();
  }

  async patchSession(id: string, patch: SessionOrganizationPatch): Promise<void> {
    const version = this.organizationVersion;
    const session = await patchSession(id, patch);
    if (this.removed.has(id)) return;
    const live = this.session(id);
    const updated = this.mergeSessionSummary(session, live, version !== this.organizationVersion);
    this.organizationVersion++;
    this.sessions = live ? this.sessions.map((item) => item.id === id ? updated : item) : [...this.sessions, updated];
    this.notify();
  }

  async createSessionGroup(name: string): Promise<SessionGroup> {
    const group = await createSessionGroup(name);
    if (!this.sessionGroups.some((item) => item.id === group.id)) this.sessionGroups = [...this.sessionGroups, group];
    this.organizationVersion++;
    this.notify();
    return group;
  }

  async renameSessionGroup(id: string, name: string): Promise<void> {
    const version = this.organizationVersion;
    const group = await renameSessionGroup(id, name);
    if (version === this.organizationVersion) this.sessionGroups = this.sessionGroups.map((item) => item.id === id ? group : item);
    this.organizationVersion++;
    this.notify();
  }

  async deleteSessionGroup(id: string): Promise<void> {
    const version = this.organizationVersion;
    const groups = await deleteSessionGroup(id);
    if (version === this.organizationVersion) this.sessionGroups = groups;
    this.sessions = this.sessions.map((session) => session.groupId === id ? { ...session, groupId: undefined } : session);
    this.organizationVersion++;
    this.notify();
  }

  /**
   * 从工作台移除会话：DELETE 注册表条目 + 停 worker（原生 transcript 不动）。
   * 成功后清该会话全部本地状态；删的是当前会话时导航到左栏顺序的下一个会话
   * （与左栏同序：有未决闸门的优先，其余按最后活动时间倒序），无剩余则回空态。
   * 失败抛错由调用方展示。
   */
  async remove(id: string, permanently = false): Promise<void> {
    const session = this.session(id);
    const agent = session?.agent ?? "";
    if (permanently && !session?.nativeSessionId) throw new Error("没有原生会话 ID，无法彻底删除。");
    const result = await deleteSession(id, permanently ? session?.nativeSessionId : undefined);
    if (permanently && result.nativeTranscriptPreserved !== false) throw new Error("服务端未确认原生历史已删除，请刷新后核查会话状态。");
    if (permanently) {
      this.historyRevision++;
      if (this.historySelection?.agent === agent && this.historySelection.nativeSessionId === session?.nativeSessionId) {
        this.historySelection = null;
      }
    }
    this.removed.add(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.data.delete(id);
    this.commands.delete(id);
    this.fileKnown.delete(id);
    this.mentionPaths.delete(id);
    this.drafts.delete(id);
    writeSavedDraft(id, null);
    this.configPending.delete(id);
    this.configErrors.delete(id);
    this.configSwitching.delete(id);
    this.configHints.delete(id);
    this.sendNotices.delete(id);
    if (this.sendTextRestore?.sessionId === id) this.sendTextRestore = null;
    for (const [requestId, stashed] of this.sendStash) {
      if (stashed.sessionId === id) this.sendStash.delete(requestId);
    }
    const hintTimer = this.configHintTimers.get(id);
    if (hintTimer) {
      clearTimeout(hintTimer);
      this.configHintTimers.delete(id);
    }
    // 作废该会话 in-flight 快照，防止过期响应把已删会话写回列表
    this.snapshotGen.set(id, ++this.nextSnapshotGen);
    this.snapshotInflight.delete(id);
    this.snapshotBuffers.delete(id);
    this.olderInflight.delete(id);
    this.replayBuffers.delete(id);
    if (this.currentId === id) {
      // 与左栏同序：有未决闸门的优先（最后活动倒序），其次普通会话，最后才是折叠区的 dead
      const remaining = [...this.sessions].sort(
        (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
      );
      const next =
        remaining.filter((s) => this.pendingCount(s.id) > 0)[0] ??
        remaining.filter((s) => s.status !== "dead")[0] ??
        remaining[0];
      this.navigate(next?.id ?? null);
    }
    // 删除只动注册表：明示原生对话记录仍在，可凭原生 id 续接
    this.removalNotice = permanently ? { message: "已彻底删除此会话的 Workbench 记录及原生本地历史。" } : {
      message: `已从工作台移除。${agent} 的原生对话记录仍在，可新建会话时填入原生 id 续接。`,
      ...(result.nativeTranscriptPath ? { path: result.nativeTranscriptPath } : {}),
    };
    this.notify();
  }

  /**
   * 手动释放会话 worker（「VSCode 继续」）：后端停进程、广播 worker_released，
   * 返回续接命令和 VSCode 协议链接；成功响应里的 session 直接覆盖本地列表项。
   */
  async release(id: string): Promise<{ resumeCommand: string; vscodeUri: string | null }> {
    const result = await releaseSession(id);
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index >= 0) {
      const next = [...this.sessions];
      next[index] = result.session;
      this.sessions = next;
    }
    this.notify();
    return { resumeCommand: result.resumeCommand, vscodeUri: result.vscodeUri ?? null };
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

/**
 * 最近 MAX_EVENTS 条是常规窗口；窗口之外仍未决的 permission_request 作为极少量保护项保留。
 * 这不会过滤 pendingGates（审批数绝不缩小），只让对应闸门仍有可渲染事件。
 */
function retainEventWindow(
  events: UnifiedEvent[],
  pendingGates: Map<string, number>,
): { events: UnifiedEvent[]; omitted: number } {
  if (events.length <= MAX_EVENTS) return { events, omitted: 0 };
  const recentStart = events.length - MAX_EVENTS;
  const pendingSeqs = new Set(pendingGates.values());
  const rescued = events
    .slice(0, recentStart)
    .filter((event) => event.type === "permission_request" && pendingSeqs.has(event.seq));
  const retained = [...rescued, ...events.slice(recentStart)];
  return { events: retained, omitted: events.length - retained.length };
}

/** 缓存只读回合续期，TTL 沿用最近一次真实写缓存的回合。 */
function updatePromptCache(
  state: { promptCacheTtlMs?: number | null; promptCacheUsageAt?: number | null },
  event: UnifiedEvent,
): void {
  const at = Date.parse(event.timestamp);
  state.promptCacheUsageAt = Number.isNaN(at) ? null : at;
  const usage = event.payload.usage as Record<string, unknown> | undefined;
  const created = usage?.cache_creation as Record<string, unknown> | undefined;
  if (Number(created?.ephemeral_1h_input_tokens) > 0) state.promptCacheTtlMs = 60 * 60_000;
  else if (Number(created?.ephemeral_5m_input_tokens) > 0) state.promptCacheTtlMs = 5 * 60_000;
}

/** commands_updated 的 payload 是 {commands: UnifiedCommand[]}；取不出时按空表处理。 */
function commandsFromPayload(payload: Record<string, unknown>): CommandInfo[] {
  const list = payload.commands;
  return Array.isArray(list) ? (list as CommandInfo[]) : [];
}

// 草稿持久化：纯 node 测试环境没有 localStorage，隐私模式下访问器本身会抛异常——
// 两处都必须 typeof 判定 + try/catch，拿不到时无声降级为纯内存行为（与 Sidebar/SettingsMenu 同一纪律）。
function readSavedDraft(sessionId: string): string {
  try {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(DRAFT_STORAGE_PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

/** text 为 null 时清除对应 key。 */
function writeSavedDraft(sessionId: string, text: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (text === null) localStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionId);
    else localStorage.setItem(DRAFT_STORAGE_PREFIX + sessionId, text);
  } catch {
    /* localStorage 不可用时仅内存生效 */
  }
}

/** config_update_started 的过渡文案：后端给什么显示什么；缺省兜底。 */
function switchMessageFromPayload(payload: Record<string, unknown>): string {
  const message = payload.message;
  return typeof message === "string" && message ? message : "正在切换配置…";
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
