import type { ApiEnvelope, CommandInfo, HistoryListData, HistoryMessagesPage, HistoryPreview, MetaInfo, PageHealth, PageManifest, SessionConfig, SessionRecord, Snapshot } from "./types";
import type { AgentKind } from "./types";
import { buildHistoryQuery, type HistoryQueryInput } from "./history";

// REST 信封统一为 {code,msg,data,request_id}；code 非 0 时 msg 是中文错误消息。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // 10 秒超时；与调用方传入的 init 合并，不覆盖调用方已有的字段（如自带 signal）
    response = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("请求超时（10 秒）");
    }
    throw error;
  }
  let envelope: ApiEnvelope<T> | undefined;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error("服务返回了无法解析的响应");
  }
  if (typeof envelope?.code !== "number") throw new Error("服务返回了无法解析的响应");
  if (envelope.code !== 0) {
    const err = new Error(envelope.msg || `请求失败（${envelope.code}）`);
    err.cause = envelope.request_id;
    throw err;
  }
  return envelope.data;
}

export function fetchMeta(): Promise<MetaInfo> {
  return call<MetaInfo>("/api/meta");
}

export function fetchSessions(): Promise<SessionRecord[]> {
  return call<{ sessions: SessionRecord[] }>("/api/sessions").then((data) => data.sessions);
}

export function fetchSnapshot(id: string): Promise<Snapshot> {
  return call<Snapshot>(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
}

export function fetchCommands(id: string): Promise<CommandInfo[]> {
  return call<{ commands: CommandInfo[] }>(
    `/api/sessions/${encodeURIComponent(id)}/commands`,
  ).then((data) => data.commands);
}

/** 会话 cwd 内的文件检索（@ 引用补全）：子串匹配、字典序；空 q 也返回列表。 */
export function fetchFiles(id: string, q: string, limit?: number): Promise<string[]> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set("limit", String(limit));
  return call<{ files: string[] }>(
    `/api/sessions/${encodeURIComponent(id)}/files?${params}`,
  ).then((data) => data.files);
}

export interface CreateSessionInput {
  agent: AgentKind;
  cwd: string;
  config?: SessionConfig;
  /** 原生会话 id 续接：claude --resume / codex thread/resume / kimi session/resume */
  resumeSessionId?: string;
  initialMessage?: string;
}

/** 移除注册表条目并停 worker；各家 CLI 的原生 transcript 不受影响。 */
export function deleteSession(id: string): Promise<{ nativeTranscriptPath?: string }> {
  return call<{ nativeTranscriptPath?: string }>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  return call<{ session: SessionRecord }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.session);
}

/** 启动时已注册的扩展页面列表（原始返回，类型过滤在 pages.ts 的 partitionPages）。 */
export function fetchPages(): Promise<PageManifest[]> {
  return call<{ pages: PageManifest[] }>("/api/pages").then((data) => data.pages);
}

/** 限时探测扩展页面目标服务（后端最多等 2 秒）；只回答「服务在不在」。 */
export function fetchPageHealth(id: string): Promise<PageHealth> {
  return call<PageHealth>(`/api/pages/${encodeURIComponent(id)}/health`);
}

/** 三家 CLI 自己保存的历史会话列表（只读）；翻页原样带回 nextCursor 与相同 agent/q。 */
export function fetchHistory(input: HistoryQueryInput): Promise<HistoryListData> {
  const query = buildHistoryQuery(input);
  return call<HistoryListData>(`/api/history${query ? `?${query}` : ""}`);
}

/** 导入前预览：有界读取会话头部，messages ≤8 条。 */
export function fetchHistoryPreview(
  agent: AgentKind,
  nativeSessionId: string,
): Promise<HistoryPreview> {
  return call<HistoryPreview>(
    `/api/history/${encodeURIComponent(agent)}/${encodeURIComponent(nativeSessionId)}`,
  );
}

/**
 * 续接会话的完整历史分页：不传 cursor 取最新一页；带回 nextCursor 继续向更早翻页。
 * 每页内部按时间正序，调用方直接 prepend 到已有消息前。
 */
export function fetchHistoryMessages(
  agent: AgentKind,
  nativeSessionId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<HistoryMessagesPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const query = params.toString();
  return call<HistoryMessagesPage>(
    `/api/history/${encodeURIComponent(agent)}/${encodeURIComponent(nativeSessionId)}/messages${query ? `?${query}` : ""}`,
  );
}
