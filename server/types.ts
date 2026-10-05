import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const AGENTS = ["claude", "codex", "kimi"] as const;
export type AgentKind = (typeof AGENTS)[number];

const EVENT_TYPES = [
  "session_created",
  "config_update_started",
  "user_message",
  "external_messages_added",
  "agent_text_delta",
  "thought_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "permission_request",
  "permission_resolved",
  "commands_updated",
  "config_updated",
  "remote_control_updated",
  "background_tasks_updated",
  "usage_updated",
  "turn_completed",
  "session_error",
  "process_exited",
  "worker_released",
  "raw_event",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export interface RemoteControlState {
  status: "disconnected" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "error";
  sessionUrl?: string;
  reason?: string;
}
/** Claude 的后台任务（后台 Bash、后台子代理等），来自 CLI 的 system/background_tasks_changed 全量清单。 */
export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
}
export type PermissionDecision = "allow" | "deny" | "always";
export type QuestionAnswers = Record<string, string>;

export const CONFIG_OPTION_IDS = ["model", "effort", "permissionMode"] as const;
export type ConfigOptionId = (typeof CONFIG_OPTION_IDS)[number];

export interface SessionConfig {
  /** Claude 会话级 Thinking；不写用户 settings。 */
  thinkingLevel?: "off" | "default_on";
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
}

type EffectiveConfigSource = "session" | "settings" | "init";

interface EffectiveConfigValue {
  value: string | null;
  source: EffectiveConfigSource | null;
}

export interface EffectiveConfigUpdate {
  model?: EffectiveConfigValue;
  effort?: EffectiveConfigValue;
}

export interface ConfigOptionValue {
  value: string | null;
  label: string;
  description?: string;
}

export interface DriverConfigOption {
  id: ConfigOptionId;
  name: string;
  values: ConfigOptionValue[];
  valuesByModel?: Record<string, ConfigOptionValue[]>;
  defaultsByModel?: Record<string, string | null>;
  default: string | null;
  mutable: boolean;
  mutableVia?: "restart" | "control";
}

export interface DriverConfigSchema {
  options: DriverConfigOption[];
  source: string;
}

export interface UnifiedCommand {
  name: string;
  description: string;
  argHint?: string;
  source: AgentKind;
}

export interface FileMention {
  type: "file";
  path: string;
  name?: string;
}

/** 图片附件（「+」上传或粘贴/拖入）；mimeType 限 png/jpeg/gif/webp，path 为服务端绝对路径。 */
export interface ImageMention {
  type: "image";
  path: string;
  mimeType: string;
  name?: string;
}

export type Mention = FileMention | ImageMention;

interface CommandInvocation {
  name: string;
  arguments?: string;
}

export interface UserMessageInput {
  text?: string;
  command?: CommandInvocation;
  mentions?: Mention[];
}

/** 由服务端状态决定，不能信任客户端传入的 steer。 */
export interface SendUserMessageOptions {
  steer: boolean;
}

export interface SendUserMessageReceipt {
  /** Kimi 不支持当前回合插话：已接收至 worker 内存队列。 */
  queued: true;
}

export interface UnifiedEvent {
  /** user_message 携带服务端计算的会话标题。 */
  title?: string;
  /** 临时工具参数更新：seq 为当前值，不持久化、不推进游标。 */
  ephemeral?: true;
  type: EventType;
  sessionId: string;
  agentId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionSnapshotState {
  latestUsage?: Record<string, unknown>;
  commands: UnifiedCommand[];
  configSwitching?: string;
  promptCacheTtlMs: number | null;
  promptCacheUsageAt: number | null;
}

export interface WorkerProcessIdentity {
  bootId: string;
  startTime: string;
  /** Only saved when the worker owns a dedicated Linux process group. */
  processGroupId?: number;
}

export interface SessionRecord {
  pinned?: boolean;
  customTitle?: string;
  /** 原生 CLI 标题或其正式标题概括接口返回值；手动标题始终优先。 */
  nativeTitle?: string;
  groupId?: string;
  /** Only tail snapshots carry reducers computed from the complete transcript. */
  snapshotState?: SessionSnapshotState;
  title?: string;
  pendingGateCount?: number;
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
  snapshotPath?: string;
  resumedFrom?: {
    agent: AgentKind;
    nativeSessionId: string;
    messageCount?: number;
    /** 导入时刻算出的历史分页截止 cursor（offset = 当时原生消息文件大小）；历史区首页截止在导入前 */
    historyCursor?: string;
  };
  processId?: number;
  /** Persisted Linux identity for crash recovery; never used to adopt or signal an old worker. */
  processIdentity?: WorkerProcessIdentity;
  /** true = worker 已释放（手动或空闲超时）；下次发送时按原生会话 id 从磁盘续接 */
  released?: boolean;
  /** 最近已同步的原生对话指纹随注册表写盘，重启后还原进内存（发现停服期间的外部续聊），不对外 */
  releasedMark?: { path: string; identity: string; offset: number; size: number };
  model?: string | null;
  effort?: string | null;
  effectiveModel?: string | null;
  effectiveEffort?: string | null;
  effectiveModelSource?: EffectiveConfigSource | null;
  effectiveEffortSource?: EffectiveConfigSource | null;
  permissionMode?: string | null;
  config: SessionConfig;
  riskyMode: boolean;
  remoteControl?: RemoteControlState;
  /** 仅 Claude：worker 当前的后台任务；非空时会话虽 idle 仍在干活。不跨 worker 保留。 */
  backgroundTasks?: BackgroundTask[];
}

export interface SessionGroup {
  id: string;
  name: string;
  createdAt: string;
}

export interface DriverCapabilities {
  usage: "detailed" | "context" | false;
  interrupt: boolean;
  commands: boolean;
  mentions: boolean;
}

export interface DriverCallbacks {
  emit(type: EventType, payload?: Record<string, unknown>): UnifiedEvent | undefined;
  metadata(metadata: {
    nativeTitle?: string;
    nativeSessionId?: string;
    nativeTranscriptPath?: string;
    config?: SessionConfig;
    effectiveConfig?: EffectiveConfigUpdate;
    remoteControl?: RemoteControlState;
    backgroundTasks?: BackgroundTask[];
  }): void;
  commands(commands: UnifiedCommand[]): void;
  status(status: SessionStatus): void;
  exited(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
}

export interface DriverOptions {
  sessionId: string;
  cwd: string;
  config: SessionConfig;
  resumeSessionId?: string;
  callbacks: DriverCallbacks;
}

export interface Driver {
  readonly kind: AgentKind;
  readonly child?: ChildProcessWithoutNullStreams;
  start(): Promise<void>;
  getConfigSchema(): DriverConfigSchema;
  setConfig(config: SessionConfig): Promise<SessionConfig>;
  setRemoteControl?(enabled: boolean): Promise<RemoteControlState>;
  /** 只读查询（Claude control_request，如 mcp_status），返回 CLI 的 response 原样 */
  queryInfo?(subtype: string): Promise<unknown>;
  /** Codex's curated app-server actions; never an arbitrary RPC proxy. */
  executeCommand?(name: string, args?: string): Promise<unknown>;
  /** MCP 会话开关/重连；只操作 CLI 实际枚举出的服务器。 */
  manageMcp?(action: import("./session-menu.js").McpAction): Promise<unknown>;
  stopTask?(taskId: string): Promise<void>;
  askSideQuestion?(input: import("./session-menu.js").SideQuestionInput, signal: AbortSignal): Promise<unknown>;
  /** 从磁盘刷新设置并重载插件，不重启 worker。 */
  reloadPlugins?(): Promise<void>;
  sendUserMessage(message: UserMessageInput, options?: SendUserMessageOptions): Promise<void | SendUserMessageReceipt>;
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSessionInput {
  agent: AgentKind;
  cwd: string;
  snapshot?: "auto" | "skip";
  agentId?: string;
  config?: SessionConfig;
  /** @deprecated Use config.model. */
  model?: string;
  resumeSessionId?: string;
  /** 服务端内部字段：带 resumeSessionId 建会话时由服务端在 create 前算出；客户端传值一律被覆盖 */
  historyCursor?: string;
  /** @deprecated Use config.permissionMode. */
  kimiMode?: "default" | "plan" | "auto" | "yolo";
  initialMessage?: string;
}
