// 与 server/types.ts 对应的纯前端类型（只保留界面需要的字段形状）。
// 后端是唯一事实源；这里不引入对 server/ 的编译期依赖，保持前端 tsconfig 独立。

export type AgentKind = "claude" | "codex" | "kimi";
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export type PermissionDecision = "allow" | "deny" | "always";

export type ConfigOptionId = "model" | "effort" | "permissionMode";

/** claude 实际生效值（effectiveModel/effectiveEffort）的来源；null = 该项无有效值 */
export type EffectiveSource = "session" | "settings" | "init" | null;

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
  /**
   * "restart" = 界面上允许修改，但代价是停止并重启底层 worker
   * （claude 的 model/effort：停 worker → --resume 同一原生会话 → 带新参数重启，
   * 期间后端先广播 config_update_started，初始化成功后才有 config_updated）。
   */
  mutableVia?: "restart";
}

export interface UnifiedEvent {
  type: string;
  sessionId: string;
  agentId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

/** Claude AskUserQuestion 的单个选项（label 必填，description 可选）。 */
export interface AskQuestionOption {
  label: string;
  description?: string;
}

/**
 * Claude AskUserQuestion 的单条问题（permission_request 上 interactionType:"ask_user_question"
 * 时随事件下行）。question 是回传 questionAnswers 的 key，必须逐字使用，不能用 header。
 */
export interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
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
  /** 以 resumeSessionId 建出的会话带的续接来源；messageCount 可选（后端默认省略） */
  resumedFrom?: {
    agent: AgentKind;
    nativeSessionId: string;
    messageCount?: number;
  };
  processId?: number;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** claude 额外固定返回：当前能确认的实际生效值与来源（codex/kimi 恒缺省，不是异常） */
  effectiveModel?: string | null;
  effectiveEffort?: string | null;
  effectiveModelSource?: EffectiveSource;
  effectiveEffortSource?: EffectiveSource;
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
  /** 内容区最大宽度（CSS 长度），省略即撑满 */
  maxWidth?: string;
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

/** 三家 CLI 原生历史会话的可识别创建来源；unknown 如实显示「未知」，不猜。 */
export type HistorySource = "interactive" | "workbench" | "unknown";

/** GET /api/history 的列表项：三家 CLI 自己保存的历史会话（只读扫描结果）。 */
export interface HistorySession {
  agent: AgentKind;
  nativeSessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: string;
  messageCount?: number;
  source: HistorySource;
  filePath: string;
}

/** GET /api/history 的 data；truncated = 扫描触发时间/数量预算，分页看 nextCursor。 */
export interface HistoryListData {
  sessions: HistorySession[];
  nextCursor?: string;
  truncated: boolean;
  /** 本页坏/空/不可读候选数：正常也可能非零，不是错误 */
  skipped: number;
  discovered: number;
  durationMs: number;
}

/** GET /api/history/:agent/:nativeSessionId 的预览消息（≤8 条，只读文件头部）。 */
export interface HistoryPreviewMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface HistoryPreview {
  session: HistorySession;
  messages: HistoryPreviewMessage[];
  /** true 是常态（只读头部），界面写中性说明，不渲染成警告 */
  truncated: boolean;
}

/** GET …/messages 的归一历史消息：思考/工具调用已被后端丢弃，前端不伪造。 */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** 原生记录缺失时间时为 null，前端如实不显示时间 */
  timestamp: string | null;
}

/** GET /api/history/:agent/:nativeSessionId/messages 的 data：最新一页 + 向更早翻页。 */
export interface HistoryMessagesPage {
  session: HistorySession;
  /** 页内按时间正序，前端直接 prepend 到已有消息前 */
  messages: HistoryMessage[];
  /** 不透明分页位置；继续向更早翻页时原样带回 */
  nextCursor?: string;
  hasMore: boolean;
  /** 当前页受条数或 4 MiB 读取窗口限制（中性说明，不是错误） */
  truncated: boolean;
  durationMs: number;
}

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}
