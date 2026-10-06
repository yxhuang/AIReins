import type { AgentKind, HistorySession, HistorySource, SessionRecord } from "./types";
import { normalizeDirectoryPath } from "./directory-path";

// 历史会话浏览的纯逻辑（无 DOM 依赖，可单测）：查询串构造、来源筛选、已导入对照。

/** 来源徽标文案：workbench 一眼可辨；interactive（CLI/VS Code/codex exec 委派等工作台以外启动）显示「其他」；unknown 如实显示「未知」，不猜。 */
export const SOURCE_LABELS: Record<HistorySource, string> = {
  interactive: "其他",
  workbench: "工作台",
  unknown: "未知",
};

/** 来源筛选项（「全部」= 不过滤任何东西，默认）。 */
export type SourceFilter = "all" | HistorySource;

export const SOURCE_FILTER_LABELS: Record<SourceFilter, string> = {
  all: "全部",
  interactive: "其他",
  workbench: "工作台",
  unknown: "未知",
};

/** 路径输入只在 Enter 时提交，不参与实时关键词搜索。 */
export function isHistoryDirectoryInput(value: string): boolean {
  return /^(?:\/|~|[a-z]:[\\/])/i.test(value.trim());
}

export function normalizeHistoryDirectory(value: string, homeDir?: string): string {
  let path = normalizeDirectoryPath(value);
  if (homeDir && (path === "~" || path.startsWith("~/"))) path = homeDir.replace(/\/+$/, "") + path.slice(1);
  return path.replace(/\/+$/, "") || (path.startsWith("/") ? "/" : "");
}

/** GET /api/history 的查询入参：agent/q/cwd/cursor 可省略，limit 有界。 */
export interface HistoryQueryInput {
  agent?: AgentKind;
  q?: string;
  cwd?: string;
  limit?: number;
  cursor?: string;
}

/** 构造 /api/history 查询串：空值一律省略，翻页时 cursor 原样带回。 */
export function buildHistoryQuery(input: HistoryQueryInput): string {
  const params = new URLSearchParams();
  if (input.agent) params.set("agent", input.agent);
  const q = input.q?.trim();
  if (q) params.set("q", q);
  const cwd = input.cwd?.trim();
  if (cwd) params.set("cwd", cwd);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  return params.toString();
}

/** 来源筛选（前端侧，接口没有 source 参数）：只作用于已加载的条目。 */
export function filterBySource(
  sessions: HistorySession[],
  source: SourceFilter,
): HistorySession[] {
  if (source === "all") return sessions;
  return sessions.filter((session) => session.source === source);
}

/**
 * 已导入对照：工作台注册表里已有同一 agent + 同一 nativeSessionId 的会话时，
 * 该历史条目视为「已在工作台中」（返回注册表里的会话，供「跳转过去」用）。
 */
export function findImportedSession(
  sessions: SessionRecord[],
  item: Pick<HistorySession, "agent" | "nativeSessionId">,
): SessionRecord | undefined {
  return sessions.filter(
    (session) =>
      session.agent === item.agent && session.nativeSessionId === item.nativeSessionId,
  ).sort((a, b) => Number(a.status === "dead") - Number(b.status === "dead")
    || Date.parse(b.lastActivityAt ?? b.createdAt) - Date.parse(a.lastActivityAt ?? a.createdAt))[0];
}
