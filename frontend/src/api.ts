import { getLocale, localizeServerData, t } from "./i18n";
import type { ApiEnvelope, CommandInfo, DirectoryListing, HistoryListData, HistoryMessagesPage, MetaInfo, PageHealth, PageManifest, SessionConfig, SessionRecord, ShellKind, Snapshot, SnapshotPreflight, StorageCleanResult, StorageStats, TerminalInfo, WorkbenchPrefs } from "./types";
import type { AgentKind, SessionOrganizationPatch } from "./types";
import { buildHistoryQuery, type HistoryQueryInput } from "./history";
import type { DispatchRun } from "./dispatch-flow";
import type { TaildropTargetsResult, TailscalePeersResult } from "../../server/tailscale-peers";

// REST 信封统一为 {code,msg,data,request_id}；code 非 0 时按可选 i18n 元数据翻译 msg，旧响应保留原文。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // 10 秒超时；与调用方传入的 init 合并，不覆盖调用方已有的字段（如自带 signal）
    response = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(init?.signal ? t("core.005") : t("core.006"));
    }
    throw error;
  }
  let envelope: ApiEnvelope<T> | undefined;
  try {
    envelope = localizeServerData(await response.json()) as ApiEnvelope<T>;
  } catch (error) {
    // 超时信号同样作用于读响应体：大响应没读完就被掐断，不是格式错误
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(init?.signal ? t("core.007") : t("core.008"));
    }
    throw new Error(t("core.009"));
  }
  if (typeof envelope?.code !== "number") throw new Error(t("core.009"));
  if (envelope.code !== 0) {
    const err = new Error(envelope.msg || t("core.010", { p0: envelope.code }));
    err.cause = envelope.request_id;
    throw err;
  }
  return envelope.data;
}

export function fetchMeta(): Promise<MetaInfo> {
  return call<MetaInfo>("/api/meta");
}

export function openAppWindow(target: string): Promise<{ opened: boolean }> {
  return call("/api/open-app-window", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }) });
}

export function fetchTailscalePeers(signal?: AbortSignal): Promise<TailscalePeersResult> {
  return call("/api/tailscale/peers", { signal });
}

export function fetchTaildropTargets(signal?: AbortSignal): Promise<TaildropTargetsResult> {
  return call("/api/tailscale/file-targets", { signal });
}

/** 文件夹会先在服务端打成 zip；请求持续到 Taildrop 发送完成，超时覆盖服务端打包 10 分钟 + 发送 30 分钟。 */
export function sendTaildrop(target: import("./types").WorkFileTarget, ip: string): Promise<{ sent: true; name: string }> {
  return call("/api/tailscale/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, target: ip }),
    signal: AbortSignal.timeout(45 * 60_000) });
}

export function pickWindowsDirectory(path: string): Promise<{ path: string | null }> {
  return call("/api/fs/pick-directory", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(135_000) });
}

export function pickWindowsFile(path: string): Promise<{ path: string | null }> {
  return call("/api/fs/pick-file", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(135_000) });
}

export function openWorkPathInSystem(target: import("./types").WorkFileTarget): Promise<{ opened: true }> {
  return call("/api/fs/open-system", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
}

export function fetchDispatches(signal?: AbortSignal): Promise<{ dispatches: DispatchRun[] }> {
  return call("/api/dispatches?limit=50", { signal });
}

export function fetchParentDispatches(parent: string, signal?: AbortSignal, agent?: string): Promise<{ dispatches: DispatchRun[] }> {
  return call(`/api/dispatches?parent=${encodeURIComponent(parent)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`, { signal });
}

export function fetchDispatchHistory(offset = 0, signal?: AbortSignal): Promise<{ dispatches: DispatchRun[]; total: number; nextOffset: number | null }> {
  return call(`/api/dispatches/history?offset=${offset}`, { signal });
}

export function fetchDispatchDetail(id: string, signal?: AbortSignal): Promise<import("./types").DispatchDetail> {
  return call(`/api/dispatches/${encodeURIComponent(id)}`, { signal });
}

export function fetchDispatchMessages(id: string, cursor: string | null, signal?: AbortSignal): Promise<import("./types").DispatchMessages> {
  return call(`/api/dispatches/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });
}

export function fetchDispatchLog(id: string, offset?: number, signal?: AbortSignal): Promise<{ text: string; nextOffset: number; reset?: boolean }> {
  return call(`/api/dispatches/${encodeURIComponent(id)}/log${offset === undefined ? "" : `?offset=${offset}`}`, { signal });
}

/** 不传 path 时从服务端 $HOME 浏览；files=true 时同层普通文件一并返回（选文件模式）。 */
export function fetchDirectories(path?: string, files?: boolean): Promise<DirectoryListing> {
  const params = new URLSearchParams();
  if (path !== undefined) params.set("path", path);
  if (files) params.set("files", "1");
  const query = params.toString();
  return call<DirectoryListing>(`/api/fs/dirs${query ? `?${query}` : ""}`);
}

function workFileQuery(target: import("./types").WorkFileTarget): string {
  const query = new URLSearchParams({ path: target.path, root: target.root });
  if (target.sessionId) query.set("sessionId", target.sessionId);
  if (target.large) query.set("large", "1");
  return query.toString();
}
export function fetchWorkFile(target: import("./types").WorkFileTarget, signal?: AbortSignal): Promise<import("./types").WorkFile> {
  return call(`/api/fs/file?${workFileQuery(target)}`, { signal });
}
export function saveWorkFile(target: import("./types").WorkFileTarget, version: string, text: string): Promise<import("./types").WorkFile> {
  return call("/api/fs/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, version, text }) });
}
export function workFileContentUrl(target: import("./types").WorkFileTarget, download = false): string {
  return `/api/fs/content?${workFileQuery(target)}&lang=${getLocale()}${download ? "&download=1" : ""}`;
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

export function patchSession(id: string, patch: SessionOrganizationPatch): Promise<SessionRecord> {
  return call<{ session: SessionRecord }>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }).then((data) => data.session);
}

export function fetchProjectOrder(): Promise<string[]> {
  return call<{ paths: string[] }>("/api/project-order").then((data) => data.paths);
}

export function moveProjectOrder(path: string, target: { before: string } | { after: string }): Promise<string[]> {
  return call<{ paths: string[] }>("/api/project-order/move", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, ...target }),
  }).then((data) => data.paths);
}

export function restartWorkbench(signal?: AbortSignal): Promise<{ restarting: boolean }> {
  return call("/api/restart", { method: "POST", signal });
}

export interface PowerOffStatus {
  state: "idle" | "waiting" | "scheduled";
  busy: number;
  remainingMs?: number;
  error?: string;
}

export function powerOff(method: "GET" | "POST" | "DELETE" = "GET"): Promise<PowerOffStatus> {
  return call("/api/power-off", { method });
}

export interface UpdateStatus {
  branch: string;
  upstream: string;
  head: string;
  upstreamHead: string;
  ahead: number;
  behind: number;
  aheadLog: string[];
  behindLog: string[];
  changes: string[];
  defaultMessage: string;
  install?: boolean;
  trayRestart?: boolean;
  action: "pull" | "push" | "install" | "none" | "diverged";
}

export interface UpdateResult {
  action: "pull" | "push" | "install";
  output: string;
  restart: boolean;
  installed?: boolean;
  trayRestart?: boolean;
}

/** 先 git fetch，网络慢时要等一会儿。 */
export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return call("/api/update", { signal: AbortSignal.timeout(90_000) });
}

/** 拉取后可能 npm install + npm run build，推送可能经过提交钩子，给足时间。 */
export function applyUpdate(status: UpdateStatus, message: string): Promise<UpdateResult> {
  return call("/api/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...status, message, lang: getLocale() }),
    signal: AbortSignal.timeout(16 * 60_000),
  });
}

export function fetchStorage(signal?: AbortSignal): Promise<StorageStats> {
  return call("/api/storage", { signal });
}

export function cleanStorage(includeEnded: boolean): Promise<StorageCleanResult> {
  return call("/api/storage/clean", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeEnded }),
    signal: AbortSignal.timeout(60_000),
  });
}

export function fetchSnapshot(id: string, tail = false): Promise<Snapshot> {
  // 长会话快照很大，手机远程下载慢：放宽到 60 秒
  return call<Snapshot>(`/api/sessions/${encodeURIComponent(id)}/snapshot${tail ? "?tail=1" : ""}`, { signal: AbortSignal.timeout(60_000) });
}

export function fetchEarlierEvents(id: string, beforeSeq: number): Promise<import("./types").EventsPage> {
  return call<import("./types").EventsPage>(`/api/sessions/${encodeURIComponent(id)}/events?beforeSeq=${beforeSeq}`, { signal: AbortSignal.timeout(60_000) });
}

export function fetchCommands(id: string): Promise<CommandInfo[]> {
  return call<{ commands: CommandInfo[] }>(
    `/api/sessions/${encodeURIComponent(id)}/commands`,
  ).then((data) => data.commands);
}

export interface CodexSkillInfo {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
}

export function fetchCodexSkills(id: string, signal?: AbortSignal): Promise<{ skills: CodexSkillInfo[]; errors: unknown[] }> {
  return call(`/api/sessions/${encodeURIComponent(id)}/info/skills`, { signal: signal ?? AbortSignal.timeout(20_000) });
}

export function runCodexCommand(id: string, name: string, args?: string): Promise<Record<string, unknown>> {
  return call(`/api/sessions/${encodeURIComponent(id)}/codex/command`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...(args ? { arguments: args } : {}) }),
    signal: AbortSignal.timeout(name === "new" ? 90_000 : 60_000),
  });
}

/** 会话 cwd 内的文件检索（@ 引用补全）：子串匹配、字典序；空 q 也返回列表。 */
export function fetchFiles(id: string, q: string, limit?: number, signal?: AbortSignal): Promise<string[]> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set("limit", String(limit));
  return call<{ files: string[] }>(
    // 调用方取消与默认 10 秒超时并存
    `/api/sessions/${encodeURIComponent(id)}/files?${params}`, { signal: signal && AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
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
   * 建会话前快照：缺省 = "skip"；显式 "auto" 才执行快照。
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

/** 停 worker，移除注册表与 AIReins 副本；各家 CLI 的原生 transcript 不受影响。 */
export function deleteSession(id: string, confirmedNativeId?: string): Promise<{ nativeTranscriptPath?: string; nativeTranscriptPreserved?: boolean }> {
  return call(`/api/sessions/${encodeURIComponent(id)}${confirmedNativeId ? "/permanent" : ""}`, {
    method: "DELETE",
    ...(confirmedNativeId ? { headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmNativeSessionId: confirmedNativeId }), signal: AbortSignal.timeout(45_000) } : {}),
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
export type SessionInfoKind = "mcp" | "hooks" | "permissions" | "context" | "plugins" | "status" | "memory" | "instructions" | "skills" | "sandbox" | "usage" | "output" | "settings" | "export";
export function fetchSessionInfo(id: string, kind: SessionInfoKind, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(kind === "output" ? 40_000 : 20_000);
  return call<unknown>(`/api/sessions/${encodeURIComponent(id)}/info/${kind}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

export type SessionMcpAction = "toggle" | "reconnect" | "authenticate" | "oauth_callback";
export function manageSessionMcp(id: string, action: SessionMcpAction, serverName: string, enabled?: boolean, callbackUrl?: string): Promise<unknown> {
  return call(`/api/sessions/${encodeURIComponent(id)}/mcp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, serverName, ...(enabled === undefined ? {} : { enabled }), ...(callbackUrl === undefined ? {} : { callbackUrl }) }),
    signal: AbortSignal.timeout(80_000),
  });
}

export function fetchClaudeCapabilities(id: string): Promise<{ supportsFastMode: boolean }> {
  return call(`/api/sessions/${encodeURIComponent(id)}/info/capabilities`, { signal: AbortSignal.timeout(20_000) });
}

export function setSessionThinking(id: string, enabled: boolean): Promise<{ session: SessionRecord }> {
  return call(`/api/sessions/${encodeURIComponent(id)}/thinking`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(40_000),
  });
}

export function stopSessionTask(id: string, taskId: string): Promise<{ stopped: boolean }> {
  return call(`/api/sessions/${encodeURIComponent(id)}/tasks/stop`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }), signal: AbortSignal.timeout(20_000),
  });
}

export interface SideQuestionTurn { question: string; response: string }
export interface SideQuestionResult { response: string | null; sideId?: string; synthetic?: boolean; error?: string; refusal_fallback?: { original_model: string; fallback_model: string; content: string } }
export function askSessionSideQuestion(id: string, question: string, history: SideQuestionTurn[], signal: AbortSignal, timeoutMs = 80_000, sideId?: string): Promise<SideQuestionResult> {
  return call(`/api/sessions/${encodeURIComponent(id)}/side-question`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, history, ...(sideId ? { sideId } : {}) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
}

interface PluginToggleResult {
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

export function releaseSession(id: string): Promise<{ session: SessionRecord; resumeCommand: string; vscodeUri: string | null }> {
  return call<{ session: SessionRecord; resumeCommand: string; vscodeUri: string | null }>(
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

export interface LauncherLink { name: string; url: string; icon?: string; group?: string }

export function fetchLinks(): Promise<LauncherLink[]> {
  return call<{ links: LauncherLink[] }>("/api/links", { cache: "no-store" }).then((data) => data.links);
}

/** 限时探测扩展页面目标服务（后端最多等 2 秒）；只回答「服务在不在」。 */
export function fetchPageHealth(id: string): Promise<PageHealth> {
  return call<PageHealth>(`/api/pages/${encodeURIComponent(id)}/health`);
}

/** 三家 CLI 自己保存的历史会话列表（只读）；翻页原样带回 nextCursor 与相同 agent/q/cwd。 */
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

export function fetchCodexResets(): Promise<import("../../server/codex-resets").CodexResetStatus> {
  return call("/api/codex-resets");
}
export function ackCodexReset(id: string): Promise<unknown> {
  return call("/api/codex-resets/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
}
