// 与 server/types.ts 对应的纯前端类型（只保留界面需要的字段形状）。
// 后端是唯一事实源；这里不引入对 server/ 的编译期依赖，保持前端 tsconfig 独立。

export type AgentKind = "claude" | "codex" | "kimi";
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
  mutableVia?: "restart" | "control";
}

export interface UnifiedEvent {
  /** user_message 携带服务端计算的会话标题。 */
  title?: string;
  /** 临时工具参数更新：seq 为当前值，不持久化、不推进游标。 */
  ephemeral?: true;
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
  /** false = 协议不接收「其他」自由文本（kimi 全部、codex isOther:false 的题）；缺省 = 支持（claude） */
  otherSupported?: boolean;
}

export interface SessionRecord {
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
  /** 以 resumeSessionId 建出的会话带的续接来源；messageCount 可选（后端默认省略） */
  resumedFrom?: {
    agent: AgentKind;
    nativeSessionId: string;
    messageCount?: number;
    /** 服务端在导入时刻记下的历史分页截止 cursor；历史区首页截止在导入前，缺省则从最新一页开始 */
    historyCursor?: string;
  };
  processId?: number;
  /** true = worker 已释放（手动或空闲超时）；下次发送时后端按原生会话 id 从磁盘续接 */
  released?: boolean;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** claude 额外固定返回：当前能确认的实际生效值与来源（codex/kimi 恒缺省，不是异常） */
  effectiveModel?: string | null;
  effectiveEffort?: string | null;
  effectiveModelSource?: EffectiveSource;
  effectiveEffortSource?: EffectiveSource;
  config: SessionConfig;
  /** 建会话时后端自动快照的写入路径；git 目录/跳过快照/旧会话为缺省或 null，缺失就不显示 */
  snapshotPath?: string | null;
  /** true = 该会话已关闭 agent 主动询问（claude bypass/dontAsk、codex never、kimi yolo） */
  riskyMode: boolean;
  remoteControl?: RemoteControlState;
  /** 仅 Claude：后台任务清单；非空时虽 idle 仍在干活（列表状态点显示黄色） */
  backgroundTasks?: BackgroundTask[];
}

/** GET /api/sessions/:id/commands 与 commands_updated 的命令项；name 不含开头的 /。 */
export interface CommandInfo {
  name: string;
  description: string;
  argHint?: string;
  source: AgentKind;
}

/** WS user_message 的 mentions 项：文件引用（@ 引用或「+」附件），path 为会话 cwd 相对路径或 uploads 绝对路径。 */
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

export interface DriverCapabilities {
  usage: "detailed" | "context" | false;
  interrupt: boolean;
  /** Codex 使用 wb 按本机协议映射的命令表；Claude/Kimi 使用原生枚举。 */
  commands: boolean;
  /** @ 文件引用能力位：false = 不弹 @ 面板、不显示预览条、发送不解析引用（纯文本原样发） */
  mentions: boolean;
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
  capabilities: { terminal: boolean };
  drivers: Record<AgentKind, DriverMeta>;
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
  /** 目标地址；proxy 为 true 时 iframe 改走 /pages/<id>/ 反向代理 */
  url: string;
  healthCheck?: string;
  description?: string;
  /** 内容区最大宽度（CSS 长度），省略即撑满 */
  maxWidth?: string;
  /** 经 workbench 反向代理访问（手机经 Tailscale 也能用） */
  proxy?: boolean;
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

/**
 * POST /api/snapshot/preflight 的 data：建会话前的快照预检。
 * needed 等价于 !isGit；snapshotPath 在 needed 为 false 时为 null。
 */
export interface SnapshotPreflight {
  /** cwd 是否在 git 仓库内（git 有自身回滚能力，不需要快照） */
  isGit: boolean;
  /** 是否需要快照 */
  needed: boolean;
  /** 是否超过阈值（500MB 或 20000 文件） */
  exceeds: boolean;
  /** 是否已存在该 cwd 的旧快照（再快照会覆盖刷新） */
  existing: boolean;
  /** 目标盘空间是否足够（false 时后端会拒绝复制，「仍然快照」必失败） */
  freeSpaceOk: boolean;
  /** 快照写入路径；needed 为 false 时为 null */
  snapshotPath: string | null;
}

/** GET /api/fs/dirs 的 data：一级子目录及可返回的逻辑父路径；files=1 时多带同层普通文件列表。 */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  truncated: boolean;
  /** 仅 files=1 时返回：同层普通文件（隐藏文件不列） */
  files?: { name: string; path: string }[];
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
  dispatch?: { runId: string; name: string };
}

/** GET /api/history 的 data；truncated = 扫描触发时间/数量预算，分页看 nextCursor。 */
export interface HistoryListData {
  sessions: HistorySession[];
  nextCursor?: string;
  truncated: boolean;
  /** 本页坏/不可读候选数：正常也可能非零，不是错误 */
  skipped: number;
  empty: number;
  discovered: number;
  durationMs: number;
}

export type HistoryMessage =
  | { role: "user" | "assistant" | "thought"; text: string; timestamp: string | null }
  | { role: "tool"; timestamp: string | null; tool: {
      id: string; name: string; input: unknown; result?: string; rawResult?: unknown;
      status: "ok" | "error" | "unknown";
    } };

export type DispatchDetail = import("./dispatch-flow").DispatchRun & {
  cwd: string | null;
  prompt: string | null;
  promptTruncated: boolean;
  summary: string | null;
  final: string | null;
  accept: string | null;
  acceptResult: string | null;
  resume: string | null;
  credits: number | null;
}

export interface DispatchMessages {
  source: "native" | "stdout";
  agent?: AgentKind;
  messages: HistoryMessage[];
  replaceFrom: number;
  cursor: string | null;
  truncated: boolean;
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

/** 终端面板的终端信息（docs/terminal-panel-design.md §9 契约）。 */
export type ShellKind = "bash" | "powershell";

export interface TerminalInfo {
  id: string;
  cwd: string;
  kind: ShellKind;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
}

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

/** GET/PUT /api/prefs 的服务端偏好；idleReleaseMinutes 为 0 表示关闭空闲自动释放。 */
export interface WorkbenchPrefs {
  idleReleaseMinutes: number;
}
