import type { ApiEnvelope, MetaInfo, SessionRecord, Snapshot } from "./types";
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

export interface CreateSessionInput {
  agent: AgentKind;
  cwd: string;
  initialMessage?: string;
}

export function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  return call<{ session: SessionRecord }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((data) => data.session);
}
