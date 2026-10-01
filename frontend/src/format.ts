import type { AgentKind, SessionRecord, UnifiedEvent } from "./types";

// 相对时间：左栏「刚刚 / N分钟前」等。
export function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// 会话列表行尾用的紧凑版：去掉「前」，单位压短（完整说法放 title）。
export function relativeTimeShort(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

// 历史 / 外部续聊消息的角色名：用户显示「我」，助手显示所属 CLI。
const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", kimi: "Kimi" };
export function messageRoleLabel(role: string, agent: AgentKind | undefined): string {
  if (role === "user") return "我";
  return agent ? AGENT_NAMES[agent] : "助手";
}

// 用时：1m12s / 2h03m 这种紧凑格式，等宽展示。
export function duration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

// token 数紧凑格式：25.4k。
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export { sessionTitle, truncateDisplayWidth } from "../../shared/session-title";

// 把未知形状的 input 收敛成可读的等宽文本（命令/路径优先，兜底 JSON）。
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringifyBlock(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
