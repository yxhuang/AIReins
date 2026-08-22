import type { ApiEnvelope, CommandInfo, MetaInfo, SessionConfig, SessionRecord, Snapshot } from "./types";
import type { AgentKind } from "./types";

// REST 信封统一为 {code,msg,data,request_id}；code 非 0 时 msg 是中文错误消息。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (envelope.code !== 0) throw new Error(envelope.msg || `请求失败（${envelope.code}）`);
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
export function deleteSession(id: string): Promise<void> {
  return call<unknown>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).then(() => undefined);
}

export function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  return call<{ session: SessionRecord }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.session);
}
