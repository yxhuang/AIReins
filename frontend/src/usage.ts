import { getLocale, t } from "./i18n";
import type { UsageProvider, UsageProviderId, UsageResetCredit, UsageWindow } from "./types";

export const BUILTIN_USAGE_ID = "ai-usage";
export const USAGE_PROVIDER_ORDER: readonly UsageProviderId[] = ["claude", "antigravity", "codex", "kimi"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function windowDurationMs(w: Pick<UsageWindow, "id" | "duration_ms">): number | null {
  if (typeof w.duration_ms === "number" && Number.isFinite(w.duration_ms) && w.duration_ms > 0) {
    return w.duration_ms;
  }
  const id = w.id;
  if (id === "week" || id === "week_opus" || id === "week_sonnet" || id.startsWith("week_")) return 7 * DAY_MS;
  if (id === "5h") return 5 * HOUR_MS;
  const h = /^(\d+)h$/.exec(id);
  if (h) return Number(h[1]) * HOUR_MS;
  const m = /^(\d+)m$/.exec(id);
  if (m) return Number(m[1]) * MINUTE_MS;
  return null;
}

/** Elapsed percentage of the quota window; null when reset time or duration is unknown or out of (1%, 99%). */
export function pacePct(w: Pick<UsageWindow, "id" | "duration_ms" | "resets_at">, nowMs: number): number | null {
  if (!w.resets_at) return null;
  const duration = windowDurationMs(w);
  if (!duration) return null;
  const resetMs = Date.parse(w.resets_at);
  if (!Number.isFinite(resetMs)) return null;
  const remain = resetMs - nowMs;
  const elapsed = duration - remain;
  if (elapsed <= 0 || elapsed >= duration) return null;
  const pct = (elapsed / duration) * 100;
  return pct > 1 && pct < 99 ? pct : null;
}

export function barLevel(usedPct: number): "" | "warn" | "danger" {
  if (usedPct >= 90) return "danger";
  if (usedPct >= 70) return "warn";
  return "";
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatWeekdayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(d);
  return `${weekday} ${formatClockTime(iso)}`;
}

export function formatRemainDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return t("ui.UsageView.remain_days_hours", { days, hours });
  if (hours > 0) return t("ui.UsageView.remain_hours_mins", { hours, mins: mins % 60 });
  return t("ui.UsageView.remain_mins", { mins });
}

export function formatUsageReset(
  w: Pick<UsageWindow, "id" | "duration_ms" | "resets_at">,
  nowMs: number,
): { text: string; title: string } | null {
  if (!w.resets_at) return null;
  const resetMs = Date.parse(w.resets_at);
  if (!Number.isFinite(resetMs)) return null;
  const when = formatWeekdayTime(w.resets_at);
  const title = t("ui.UsageView.reset_title", { when });
  const ms = resetMs - nowMs;
  if (ms <= 0) return { text: t("ui.UsageView.reset_due"), title };
  const duration = windowDurationMs(w);
  const remain = formatRemainDuration(ms);
  const text = duration !== null && duration <= DAY_MS
    ? t("ui.UsageView.reset_short", { remain })
    : t("ui.UsageView.reset_long", { when, remain });
  return { text, title };
}

export function formatUsageAgo(iso: string, nowMs: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const mins = Math.max(0, Math.floor((nowMs - ts) / MINUTE_MS));
  if (mins < 1) return t("ui.UsageView.just_now");
  if (mins < 60) return t("ui.UsageView.mins_ago", { mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("ui.UsageView.hours_ago", { hours });
  return t("ui.UsageView.days_ago", { days: Math.floor(hours / 24) });
}

export function formatUsageWindowLabel(w: UsageWindow): string {
  const key = w.window_label ?? w.id;
  if (w.id === "5h" || key === "5h") return t("ui.UsageView.window_5h");
  if (w.id === "week" || key === "Weekly" || key === "week") return t("ui.UsageView.window_week");
  if (w.id === "week_opus") return t("ui.UsageView.window_week_opus");
  if (w.id === "week_sonnet") return t("ui.UsageView.window_week_sonnet");
  if (w.id === "extra_credits") return t("ui.UsageView.window_extra_credits");
  if (w.id.startsWith("week_") && w.window_label) {
    return t("ui.UsageView.window_week_scoped", { model: w.window_label });
  }
  const minMatch = /^(\d+)m$/.exec(w.id);
  if (minMatch) return t("ui.UsageView.window_minutes", { mins: Number(minMatch[1]) });
  return w.window_label || w.label;
}

export function formatUsageWindowNote(w: UsageWindow): string | null {
  if (w.note_code?.code === "weekly_cap") {
    return t("ui.UsageView.note_weekly_cap", { cap: w.note_code.cap });
  }
  if (w.note_code?.code === "remaining_amount") {
    return t("ui.UsageView.note_remaining_amount", { amount: w.note_code.amount });
  }
  return w.note;
}

export function formatCreditExpiry(credit: UsageResetCredit, nowMs: number): { text: string; warn: boolean } {
  if (!credit.expires_at) return { text: t("ui.UsageView.credit_never_expires"), warn: false };
  if (credit.all_day && /^\d{4}-\d{2}-\d{2}$/.test(credit.expires_at)) {
    const [y, m, d] = credit.expires_at.split("-").map(Number);
    const today = new Date(nowMs);
    const days = Math.round(
      (Date.UTC(y!, m! - 1, d!) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS,
    );
    const remain = days < 0
      ? t("ui.UsageView.credit_expired")
      : days === 0
        ? t("ui.UsageView.credit_today")
        : t("ui.UsageView.credit_days", { days });
    return {
      text: `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} · ${remain}`,
      warn: days <= 7,
    };
  }
  const expiresMs = Date.parse(credit.expires_at);
  if (!Number.isFinite(expiresMs)) return { text: credit.expires_at, warn: false };
  const expires = new Date(expiresMs);
  const ms = expiresMs - nowMs;
  const month = String(expires.getMonth() + 1).padStart(2, "0");
  const date = String(expires.getDate()).padStart(2, "0");
  const remain = ms <= 0
    ? t("ui.UsageView.credit_expired")
    : ms < DAY_MS
      ? t("ui.UsageView.credit_within_1d")
      : t("ui.UsageView.credit_days", { days: Math.ceil(ms / DAY_MS) });
  return {
    text: `${month}-${date} ${formatClockTime(credit.expires_at)} · ${remain}`,
    warn: ms <= 7 * DAY_MS,
  };
}

export function formatUsageError(provider: UsageProvider, kimiEnv = "KIMI_API_KEY"): string {
  switch (provider.error_code) {
    case "claude_cli_unavailable": return t("ui.UsageView.err_claude_cli_unavailable");
    case "claude_auth_expired": return t("ui.UsageView.err_claude_auth_expired");
    case "claude_forbidden": return t("ui.UsageView.err_claude_forbidden");
    case "claude_no_limits": return t("ui.UsageView.err_claude_no_limits");
    case "antigravity_cli_unavailable": return t("ui.UsageView.err_antigravity_cli_unavailable");
    case "antigravity_auth_expired": return t("ui.UsageView.err_antigravity_auth_expired");
    case "antigravity_no_limits": return t("ui.UsageView.err_antigravity_no_limits");
    case "codex_unavailable": return t("ui.UsageView.err_codex_unavailable");
    case "codex_local_fallback": return t("ui.UsageView.err_codex_local_fallback");
    case "kimi_no_key": return t("ui.UsageView.err_kimi_no_key", { env: kimiEnv });
    case "kimi_auth_expired": return t("ui.UsageView.err_kimi_auth_expired");
    case "kimi_no_plan": return t("ui.UsageView.err_kimi_no_plan");
    case "timeout": return t("ui.UsageView.err_timeout");
    case "network_error": return t("ui.UsageView.err_network");
    case "http_error": {
      const code = provider.http_status ?? /^HTTP\s+(\d{3})/.exec(provider.error ?? "")?.[1] ?? "";
      return code ? t("ui.UsageView.err_http_status", { status: String(code) }) : t("ui.UsageView.err_network");
    }
    case "parse_error": return t("ui.UsageView.err_parse");
    case "internal_error": return t("ui.UsageView.err_internal");
    default: return provider.error || t("ui.UsageView.err_unknown");
  }
}

export function groupUsageWindows(windows: UsageWindow[]): Array<{ group: string | null; items: UsageWindow[] }> {
  const groups: Array<{ group: string | null; items: UsageWindow[] }> = [];
  for (const w of windows) {
    const g = w.group ?? null;
    const prev = groups.at(-1);
    if (prev && prev.group === g) prev.items.push(w);
    else groups.push({ group: g, items: [w] });
  }
  return groups;
}
