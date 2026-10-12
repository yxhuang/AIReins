import { formatRelativeTime, t } from "./i18n";
import type { AgentKind } from "./types";

// 相对时间：左栏「刚刚 / N分钟前」等。
export function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return t("core.029");
  if (seconds < 60) return formatRelativeTime(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatRelativeTime(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatRelativeTime(-hours, "hour");
  return formatRelativeTime(-Math.floor(hours / 24), "day");
}

// 会话列表行尾用的紧凑版：去掉「前」，单位压短（完整说法放 title）。
export function relativeTimeShort(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
  if (minutes < 1) return t("core.029");
  if (minutes < 60) return t("core.034", { p0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("core.035", { p0: hours });
  return t("core.036", { p0: Math.floor(hours / 24) });
}

// 历史 / 外部续聊消息的角色名：用户显示「我」，助手显示所属 CLI。
const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", kimi: "Kimi" };
export function messageRoleLabel(role: string, agent: AgentKind | undefined): string {
  if (role === "user") return t("core.037");
  return agent ? AGENT_NAMES[agent] : t("core.038");
}

// token 数紧凑格式：25.4k。
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

import { sessionTitle as sharedSessionTitle } from "../../shared/session-title";
export { truncateDisplayWidth } from "../../shared/session-title";
export function sessionTitle(session: Parameters<typeof sharedSessionTitle>[0], events?: Parameters<typeof sharedSessionTitle>[1]): string {
  if (session.title === undefined && !session.customTitle?.trim() && !session.nativeTitle?.trim()
    && !events?.some(event => event.type === "user_message" && (event.payload.text || event.payload.command))) return t("core.newSession");
  return sharedSessionTitle(session, events);
}

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
