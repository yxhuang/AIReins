// 与 server/types.ts 对应的纯前端类型（只保留界面需要的字段形状）。
// 后端是唯一事实源；这里不引入对 server/ 的编译期依赖，保持前端 tsconfig 独立。

export type AgentKind = "claude" | "codex" | "kimi";
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export type PermissionDecision = "allow" | "deny" | "always";

export type ConfigOptionId = "model" | "effort" | "permissionMode";

/** 会话级配置覆盖；字段为 null 表示不覆盖、跟随 CLI 有效配置。 */
export interface SessionConfig {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
}

export interface ConfigOptionValue {
  value: string | null;
  label: string;
  description?: string;
}

/** /api/meta 的 drivers.<agent>.options[] 项：前端配置控件的唯一事实源，不许硬编码值。 */
export interface DriverConfigOption {
  id: ConfigOptionId;
  name: string;
  values: ConfigOptionValue[];
  default: string | null;
  /** false = 只能建会话时设置，活改会被后端拒绝 */
  mutable: boolean;
}

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
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  config: SessionConfig;
  /** true = 该会话已关闭 agent 主动询问（claude bypass/dontAsk、codex never、kimi yolo） */
  riskyMode: boolean;
}

/** GET /api/sessions/:id/commands 与 commands_updated 的命令项；name 不含开头的 /。 */
export interface CommandInfo {
  name: string;
  description: string;
  argHint?: string;
  source: AgentKind;
}

/** WS user_message 的 mentions 项（当前只有文件引用）；path 为会话 cwd 相对路径。 */
export interface FileMention {
  type: "file";
  path: string;
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
  /** false = 无斜杠命令枚举协议（codex）：不弹命令面板，结构化 command 会被后端拒绝 */
  commands: boolean;
  /** @ 文件引用能力位：false = 不弹 @ 面板、不显示预览条、发送不解析引用（纯文本原样发） */
  mentions: boolean;
  terminal?: boolean;
  fsWrite?: boolean;
  finalApprovalGates?: string[];
}

/** meta.drivers.<agent> = 能力位 + 配置 schema（options 探针失败时为空数组并带 error） */
export interface DriverMeta extends DriverCapabilities {
  options?: DriverConfigOption[];
  source?: string;
  error?: string;
}

export interface MetaInfo {
  serverVersion: string;
  /** server 进程 cwd：新建会话表单 cwd 预填的最后一级回退 */
  defaultCwd: string;
  cliVersions: Record<AgentKind, string>;
  capabilities: Record<string, unknown>;
  drivers: Record<AgentKind, DriverMeta>;
  security: Record<string, unknown>;
}

export interface Snapshot {
  session: SessionRecord;
  seq: number;
  events: UnifiedEvent[];
}

/** GET /api/pages 的页面 manifest（本轮只有 type:"iframe"；未知类型前端跳过并提示）。 */
export interface PageManifest {
  id: string;
  name: string;
  /** emoji 或以 <svg...>...</svg> 表示的内联 SVG 字符串 */
  icon: string;
  type: string;
  /** iframe 直接加载的地址；server 不代理 */
  url: string;
  healthCheck?: string;
  description?: string;
}

/** GET /api/pages/:id/health：只回答「服务在不在」，收到任何 HTTP 响应即 reachable。 */
export interface PageHealth {
  id: string;
  reachable: boolean;
  /** 如 "HTTP 200"、"连接被拒绝"、"超过 2000 ms 未响应" */
  reason: string;
  status?: number;
  durationMs: number;
  /**
   * 后端对「能否被 iframe 嵌入」的判定（看 X-Frame-Options / CSP frame-ancestors）：
   * true = 允许嵌入；false = 明确拒绝；null/缺省 = 无法确定（前端不猜）。
   */
  embeddable?: boolean | null;
  /** embeddable:false 时的原因，如 "目标站点设置了 X-Frame-Options: DENY" */
  embedReason?: string | null;
}

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}
