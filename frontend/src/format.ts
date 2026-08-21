import type { SessionRecord, UnifiedEvent } from "./types";

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

// 会话标题：后端没有标题字段，用该会话第一条 user_message 的文本派生。
// 所有空白（含换行）压成单空格后按显示宽度截断（CJK/全角计 2，其余计 1，上限 30，超出加 …）；
// 首条消息还没到时返回占位「新会话」。
export function sessionTitle(session: SessionRecord, events: UnifiedEvent[] | undefined): string {
  const firstUser = events?.find((event) => event.type === "user_message");
  const text = firstUser ? String(firstUser.payload.text ?? "") : "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return truncateDisplayWidth(flat, 30);
}

// 按显示宽度截断：CJK/全角字符计 2，其余计 1；超出上限时截断并追加 …。
function truncateDisplayWidth(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charDisplayWidth(ch);
    if (width + w > maxWidth) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

// 宽字符区间：CJK 统一表意、假名、谚文、全角形式等（足够覆盖标题场景的近似判定）。
const WIDE_CHAR = /[ᄀ-ᅟ⺀-鿿ꥠ-꥿가-ퟻ豈-﫿︰-﹏＀-｠￠-￦𠀀-𫿿]/u;

function charDisplayWidth(ch: string): number {
  return WIDE_CHAR.test(ch) ? 2 : 1;
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
