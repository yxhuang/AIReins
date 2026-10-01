import type { ApiEnvelope, CommandInfo, DirectoryListing, HistoryListData, HistoryMessagesPage, MetaInfo, PageHealth, PageManifest, SessionConfig, SessionRecord, ShellKind, Snapshot, SnapshotPreflight, TerminalInfo, WorkbenchPrefs } from "./types";
import type { AgentKind } from "./types";
import { buildHistoryQuery, type HistoryQueryInput } from "./history";
import type { DispatchRun } from "./dispatch-flow";

// REST 信封统一为 {code,msg,data,request_id}；code 非 0 时 msg 是中文错误消息。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // 10 秒超时；与调用方传入的 init 合并，不覆盖调用方已有的字段（如自带 signal）
    response = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(init?.signal ? "请求超时" : "请求超时（10 秒）");
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

export function fetchDispatches(signal?: AbortSignal): Promise<{ dispatches: DispatchRun[] }> {
  return call("/api/dispatches?limit=50", { signal });
}

/** 不传 path 时从服务端 $HOME 浏览；files=true 时同层普通文件一并返回（选文件模式）。 */
export function fetchDirectories(path?: string, files?: boolean): Promise<DirectoryListing> {
  const params = new URLSearchParams();
  if (path !== undefined) params.set("path", path);
  if (files) params.set("files", "1");
  const query = params.toString();
  return call<DirectoryListing>(`/api/fs/dirs${query ? `?${query}` : ""}`);
}

/**
 * 附件上传：请求体是原始字节（不是 multipart，body 直接给 Blob）。
 * 信封 data 带落盘后的 path/name/size/mimeType；错误码 40401/40070/41301。
 */
export function uploadAttachment(
  sessionId: string,
  body: Blob,
  name: string,
): Promise<{ path: string; name: string; size: number; mimeType: string }> {
  const query = new URLSearchParams({ sessionId, name });
  return call<{ path: string; name: string; size: number; mimeType: string }>(
    `/api/uploads?${query}`,
    { method: "POST", body },
  );
}

/** uploads 目录内文件的直接字节地址（content-type 按扩展名），可作 <img src>；目录外一律 404。 */
export function uploadsFileUrl(path: string): string {
  return `/api/uploads/file?path=${encodeURIComponent(path)}`;
}

export function fetchSessions(): Promise<SessionRecord[]> {
  return call<{ sessions: SessionRecord[] }>("/api/sessions").then((data) => data.sessions);
}

export function restartWorkbench(signal?: AbortSignal): Promise<{ restarting: boolean }> {
  return call("/api/restart", { method: "POST", signal });
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
  /**
   * 非 git 目录的建会话前快照：缺省 = "auto"（后端静默快照）。
   * 只在用户于确认框里做出选择后才显式传值；省略即让后端按默认处理。
   */
  snapshot?: "auto" | "skip";
}

/** 建会话前快照预检：cwd 无效时后端返回 400（按失败处理，不阻断建会话）。 */
export function fetchSnapshotPreflight(cwd: string): Promise<SnapshotPreflight> {
  return call<SnapshotPreflight>("/api/snapshot/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
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

/** 工作区级终端列表（含已退出记录，server 重启前保留）。 */
export function fetchTerminals(): Promise<TerminalInfo[]> {
  return call<{ terminals: TerminalInfo[] }>("/api/terminals").then((data) => data.terminals);
}

/** 新建终端：cwd 缺省或不存在时后端用 defaultCwd。 */
export function createTerminal(input: {
  cwd?: string;
  shell?: ShellKind;
  cols: number;
  rows: number;
}): Promise<TerminalInfo> {
  return call<TerminalInfo>("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** 结束终端进程（不是删文件，故不用 DELETE 动词）。 */
export function killTerminal(id: string): Promise<{ ok: true }> {
  return call<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}/kill`, {
    method: "POST",
  });
}

/** 释放会话 worker（停进程、保留会话）；返回带 cwd 的原生续接命令。 */
/** 「/」菜单的只读查看（仅 Claude）：已释放会话会先拉起 worker。 */
export type SessionInfoKind = "mcp" | "hooks" | "permissions" | "context" | "plugins";
export function fetchSessionInfo(id: string, kind: SessionInfoKind): Promise<unknown> {
  return call<unknown>(`/api/sessions/${encodeURIComponent(id)}/info/${kind}`, { signal: AbortSignal.timeout(20_000) });
}

export interface PluginToggleResult {
  plugins: unknown[];
  reloaded: boolean;
  reloadError?: string;
}

export function setSessionPlugin(id: string, pluginId: string, enabled: boolean, scope?: string): Promise<PluginToggleResult> {
  return call<PluginToggleResult>(`/api/sessions/${encodeURIComponent(id)}/plugins`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pluginId, enabled, ...(scope ? { scope } : {}) }),
    // CLI 切换 + 刷新设置 + 重载 + CLI 列表各有独立超时。
    signal: AbortSignal.timeout(80_000),
  });
}

export interface ClaudeStartupSettings { remoteControlAtStartup: boolean }

export function fetchClaudeStartupSettings(): Promise<ClaudeStartupSettings> {
  return call<ClaudeStartupSettings>("/api/claude/settings");
}

export function saveClaudeStartupSettings(enabled: boolean): Promise<ClaudeStartupSettings> {
  return call<ClaudeStartupSettings>("/api/claude/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remoteControlAtStartup: enabled }),
  });
}

export function releaseSession(id: string): Promise<{ session: SessionRecord; resumeCommand: string }> {
  return call<{ session: SessionRecord; resumeCommand: string }>(
    `/api/sessions/${encodeURIComponent(id)}/release`,
    { method: "POST" },
  );
}

export function fetchPrefs(): Promise<WorkbenchPrefs> {
  return call<WorkbenchPrefs>("/api/prefs");
}

export function savePrefs(prefs: WorkbenchPrefs): Promise<WorkbenchPrefs> {
  return call<WorkbenchPrefs>("/api/prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
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
