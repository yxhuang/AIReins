// 与 server/types.ts 对应的纯前端类型（只保留界面需要的字段形状）。
// 后端是唯一事实源；这里不引入对 server/ 的编译期依赖，保持前端 tsconfig 独立。

export type AgentKind = "claude" | "codex" | "kimi";
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export type PermissionDecision = "allow" | "deny" | "always";

export interface UnifiedEvent {
  type: string;
  sessionId: string;
  agentId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  agent: AgentKind;
  agentId: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  seq: number;
  transcriptPath: string;
  nativeSessionId?: string;
  nativeTranscriptPath?: string;
  processId?: number;
  model?: string;
}

export interface DriverCapabilities {
  streaming: boolean;
  thoughts: boolean;
  toolCalls: boolean;
  permissions: boolean;
  permissionSuggestions: boolean;
  updatedInput: boolean;
  usage: "detailed" | "context" | false;
  interrupt: boolean;
  resume: boolean;
  terminal?: boolean;
  fsWrite?: boolean;
  finalApprovalGates?: string[];
}

export interface MetaInfo {
  serverVersion: string;
  cliVersions: Record<AgentKind, string>;
  capabilities: Record<string, unknown>;
  drivers: Record<AgentKind, DriverCapabilities>;
  security: Record<string, unknown>;
}

export interface Snapshot {
  session: SessionRecord;
  seq: number;
  events: UnifiedEvent[];
}

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}
