import type {
  MetaInfo,
  PermissionDecision,
  SessionRecord,
  SessionStatus,
  UnifiedEvent,
} from "./types";
import { createSession, fetchMeta, fetchSessions, fetchSnapshot, type CreateSessionInput } from "./api";

// 全局状态与连接恢复：
// - 一条全局 WS（不带 sessionId）收全部会话事件，支撑左栏跨会话待审批徽标；
// - 进入会话先 GET snapshot 拿全量 events + seq，WS 上 seq 更大的事件追加；
// - WS 断线指数退避重连，重连后重新拉列表并对当前会话重取快照；
// - 收到 resync_required 时对该会话重取快照。

export type WsState = "connecting" | "open" | "closed";

interface SessionData {
  events: UnifiedEvent[];
  seq: number;
  /** requestId → 请求事件 seq，用于闸门块定位与排序 */
  pendingGates: Map<string, number>;
  latestUsage?: Record<string, unknown>;
}

class Store {
  sessions: SessionRecord[] = [];
  meta: MetaInfo | null = null;
  currentId: string | null = null;
  data = new Map<string, SessionData>();
  wsState: WsState = "closed";
  lastError: string | null = null;
  /** 全局时钟（每秒 tick），驱动相对时间与用时刷新 */
  now = Date.now();
  /** 每次 notify 自增，供 useSyncExternalStore 做快照 */
  version = 0;

  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private listRefreshTimer: ReturnType<typeof setTimeout> | undefined;

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
    // 启动时为每个会话取一次快照：既给左栏标题，也算出跨会话待审批徽标。
    await Promise.allSettled(this.sessions.map((s) => this.ensureLoaded(s.id)));
    this.connect();
    this.notify();
  }

  private onHashChange = (): void => {
    const match = window.location.hash.match(/^#\/session\/([^/]+)$/);
    this.currentId = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (this.currentId) void this.ensureLoaded(this.currentId);
    this.notify();
  };

  navigate(id: string | null): void {
    window.location.hash = id ? `#/session/${encodeURIComponent(id)}` : "#/";
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
    this.notify();
  }

  /** 会话事件是否已加载；未加载则取快照。 */
  async ensureLoaded(id: string): Promise<void> {
    if (this.data.has(id)) return;
    try {
      const snapshot = await fetchSnapshot(id);
      this.applySnapshot(id, snapshot.session, snapshot.seq, snapshot.events);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  private applySnapshot(
    id: string,
    session: SessionRecord,
    seq: number,
    events: UnifiedEvent[],
  ): void {
    const pendingGates = new Map<string, number>();
    let latestUsage: Record<string, unknown> | undefined;
    for (const event of events) {
      if (event.type === "permission_request") {
        pendingGates.set(String(event.payload.requestId ?? ""), event.seq);
      } else if (event.type === "permission_resolved") {
        pendingGates.delete(String(event.payload.requestId ?? ""));
      } else if (event.type === "usage_updated") {
        latestUsage = event.payload;
      }
    }
    this.data.set(id, { events: [...events].sort((a, b) => a.seq - b.seq), seq, pendingGates, latestUsage });
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
      // 重连后列表与当前会话快照都可能过期，主动重取。
      void this.refreshSessions();
      if (this.currentId) {
        this.data.delete(this.currentId);
        void this.ensureLoaded(this.currentId);
      }
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
      if (id) {
        this.data.delete(id);
        void this.ensureLoaded(id).then(() => this.notify());
      }
      return;
    }
    if (type === "error") {
      this.lastError = String(frame.msg ?? "未知错误");
      this.notify();
      return;
    }
    if (typeof frame.seq !== "number" || typeof frame.sessionId !== "string") return;
    this.handleEvent(frame as unknown as UnifiedEvent);
  }

  private handleEvent(event: UnifiedEvent): void {
    const data = this.data.get(event.sessionId);
    if (data) {
      // 快照语义：只追加 seq 更大的事件；出现缺口则重取快照。
      if (event.seq > data.seq + 1) {
        this.data.delete(event.sessionId);
        void this.ensureLoaded(event.sessionId).then(() => this.notify());
        return;
      }
      if (event.seq === data.seq + 1) {
        data.events.push(event);
        data.seq = event.seq;
        if (event.type === "permission_request") {
          data.pendingGates.set(String(event.payload.requestId ?? ""), event.seq);
        } else if (event.type === "permission_resolved") {
          data.pendingGates.delete(String(event.payload.requestId ?? ""));
        } else if (event.type === "usage_updated") {
          data.latestUsage = event.payload;
        }
      }
      // event.seq <= data.seq：重发，忽略。
    } else {
      // 未加载的会话（如别的客户端刚建的）：取快照，快照会包含这条事件。
      void this.ensureLoaded(event.sessionId).then(() => this.notify());
    }

    // 任何事件都刷新该会话的本地视图（lastActivityAt / 状态推断）。
    const session = this.session(event.sessionId);
    if (session) {
      session.lastActivityAt = event.timestamp;
      const status = statusFromEvent(event);
      if (status) session.status = status;
    } else {
      // 新会话（别的客户端建的）：刷新列表。
      void this.refreshSessions();
    }
    this.scheduleListRefresh();
    this.notify();
  }

  /** 事件驱动之外，定期对齐一次权威列表（状态、processId 等）。 */
  private scheduleListRefresh(): void {
    if (this.listRefreshTimer) return;
    this.listRefreshTimer = setTimeout(() => {
      this.listRefreshTimer = undefined;
      void this.refreshSessions();
    }, 2000);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    } else {
      this.lastError = "连接已断开，正在重连…";
      this.notify();
    }
  }

  sendUserMessage(sessionId: string, text: string): void {
    this.send({ type: "user_message", sessionId, text });
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

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const session = await createSession(input);
    await this.refreshSessions();
    void this.ensureLoaded(session.id);
    return session;
  }

  dismissError(): void {
    this.lastError = null;
    this.notify();
  }
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
