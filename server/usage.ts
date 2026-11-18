import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { connect as tlsConnect } from "node:tls";
import { log } from "./logger.js";
import { loadPrefs } from "./prefs.js";
import { proxyEnvironment } from "./proxy-env.js";
import type { AgentKind } from "./types.js";

export const USAGE_PROVIDER_ORDER = ["claude", "antigravity", "codex", "kimi"] as const;
export type UsageProviderId = (typeof USAGE_PROVIDER_ORDER)[number];

export const USAGE_PROVIDER_NAMES: Record<UsageProviderId, string> = {
  claude: "Claude",
  antigravity: "Antigravity",
  codex: "Codex",
  kimi: "Kimi",
};

export type UsageWindowNoteCode =
  | { code: "weekly_cap"; cap: number }
  | { code: "remaining_amount"; amount: string };

export interface UsageWindow {
  id: string;
  label: string;
  group?: string | null;
  window_label?: string | null;
  duration_ms?: number | null;
  used_pct: number;
  resets_at: string | null;
  note: string | null;
  note_code?: UsageWindowNoteCode | null;
}

export interface UsageResetCredit {
  expires_at: string | null;
  all_day?: boolean;
  title?: string;
}

export interface UsageResetCredits {
  available_count: number;
  credits: UsageResetCredit[] | null;
}

export type UsageProviderStatus = "ok" | "stale" | "auth_expired" | "error";

export type UsageProviderErrorCode =
  | "claude_cli_unavailable"
  | "claude_auth_expired"
  | "claude_forbidden"
  | "claude_no_limits"
  | "antigravity_cli_unavailable"
  | "antigravity_auth_expired"
  | "antigravity_no_limits"
  | "codex_unavailable"
  | "codex_local_fallback"
  | "kimi_no_key"
  | "kimi_auth_expired"
  | "kimi_no_plan"
  | "timeout"
  | "network_error"
  | "http_error"
  | "parse_error"
  | "internal_error";

export interface UsageProvider {
  id: UsageProviderId;
  name: string;
  plan: string | null;
  windows: UsageWindow[];
  status: UsageProviderStatus;
  error: string | null;
  error_code?: UsageProviderErrorCode | null;
  http_status?: number;
  fetched_at: string;
  reset_credits: UsageResetCredits | null;
  credits_note?: string | null;
  on_demand?: boolean;
}

export interface UsageSummary {
  instance_id?: string;
  revision?: number;
  updated_at: string | null;
  providers: UsageProvider[];
}

export interface UsageManualResetCreditInput {
  title?: string;
  expires?: string | null;
}

export interface UsageStoredConfig {
  version: 1;
  providers?: Partial<Record<UsageProviderId, { enabled?: boolean }>>;
  claude?: {
    resetCredits?: UsageManualResetCreditInput[];
  };
  kimi?: {
    apiKey?: string;
    apiKeyEnv?: string;
    apiKeyFile?: string;
    useProxy?: boolean;
  };
}

export interface UsageSettingsView {
  instance_id?: string;
  revision?: number;
  providers: Record<UsageProviderId, { enabled: boolean }>;
  kimi: {
    keyConfigured: boolean;
    keySource: "config" | "env" | "file" | "none";
    apiKeyEnv: string;
    apiKeyFile: string | null;
    useProxy: boolean;
  };
  claude: {
    resetCredits: UsageManualResetCreditInput[];
  };
}

export interface UsageSettingsPatch {
  providers?: Partial<Record<UsageProviderId, { enabled?: boolean }>>;
  kimi?: {
    apiKey?: string | null;
    apiKeyEnv?: string;
    apiKeyFile?: string | null;
    useProxy?: boolean;
  };
  claude?: {
    resetCredits?: UsageManualResetCreditInput[];
  };
}

export interface UsageProviderRunner {
  id: UsageProviderId;
  onDemand?: boolean;
  fetch(signal?: AbortSignal): Promise<UsageProvider>;
  resetBackoff?(): void;
}

export class UsageInputError extends Error {}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_INTERVAL_MS = 5 * MINUTE_MS;
const DEFAULT_FIRST_RETRY_MS = MINUTE_MS;
const DEFAULT_MAX_BACKOFF_MS = 30 * MINUTE_MS;
const DEFAULT_STALE_AFTER_MS = 15 * MINUTE_MS;
const DEFAULT_ON_DEMAND_FRESH_MS = 5 * MINUTE_MS;
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
};

type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return join(homedir(), filePath.slice(2));
  return filePath;
}

export function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function capitalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function errorUsage(
  id: UsageProviderId,
  status: "auth_expired" | "error",
  errorCode: UsageProviderErrorCode,
  error: string,
  nowMs = Date.now(),
  onDemand = false,
): UsageProvider {
  return {
    id,
    name: USAGE_PROVIDER_NAMES[id],
    plan: null,
    windows: [],
    status,
    error,
    error_code: errorCode,
    fetched_at: new Date(nowMs).toISOString(),
    reset_credits: null,
    ...(onDemand ? { on_demand: true } : {}),
  };
}

function formatMoney(amountMinor: number, exponent: number, currency: string): string {
  const value = amountMinor / 10 ** exponent;
  const upper = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[upper] ?? `${upper} `;
  const text = exponent > 0
    ? value.toFixed(exponent).replace(/\.?0+$/, "")
    : Math.round(value).toString();
  return `${symbol}${text}`;
}

export function formatClaudeCreditsNote(payload: Rec): string | null {
  const spend = asRecord(payload.spend);
  if (spend) {
    const used = asRecord(spend.used);
    const limit = asRecord(spend.limit);
    if (used && limit && typeof used.amount_minor === "number" && typeof limit.amount_minor === "number") {
      const currency = typeof used.currency === "string" && used.currency
        ? used.currency
        : typeof limit.currency === "string" && limit.currency
          ? limit.currency
          : "USD";
      const usedExp = typeof used.exponent === "number" ? Math.trunc(used.exponent) : 2;
      const limitExp = typeof limit.exponent === "number" ? Math.trunc(limit.exponent) : 2;
      if (usedExp >= 0 && usedExp <= 8 && limitExp >= 0 && limitExp <= 8) {
        return `${formatMoney(used.amount_minor, usedExp, currency)} / ${formatMoney(limit.amount_minor, limitExp, currency)}`;
      }
    }
  }
  const extra = asRecord(payload.extra_usage);
  if (extra && typeof extra.used_credits === "number" && typeof extra.monthly_limit === "number") {
    const exp = typeof extra.decimal_places === "number" ? Math.trunc(extra.decimal_places) : 2;
    const currency = typeof extra.currency === "string" && extra.currency ? extra.currency : "USD";
    if (exp >= 0 && exp <= 8) {
      return `${formatMoney(extra.used_credits, exp, currency)} / ${formatMoney(extra.monthly_limit, exp, currency)}`;
    }
  }
  return null;
}

export function activeManualResetCredits(
  raw: UsageManualResetCreditInput[] | undefined,
  nowMs = Date.now(),
): UsageResetCredits | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const nowDate = new Date(nowMs);
  const localToday = Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const alive: UsageResetCredit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : undefined;
    const expires = typeof item.expires === "string" ? item.expires.trim() : "";
    if (!expires) {
      alive.push({ expires_at: null, ...(title ? { title } : {}) });
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      const [y, m, d] = expires.split("-").map(Number);
      const targetDay = Date.UTC(y!, m! - 1, d!);
      if (!Number.isFinite(targetDay)) continue;
      if (targetDay >= localToday) {
        alive.push({ expires_at: expires, all_day: true, ...(title ? { title } : {}) });
      }
      continue;
    }
    const iso = parseIsoTimestamp(expires);
    if (!iso) continue;
    if (Date.parse(iso) > nowMs) {
      alive.push({ expires_at: iso, ...(title ? { title } : {}) });
    }
  }
  if (alive.length === 0) return null;
  alive.sort((a, b) => {
    if (a.expires_at === null && b.expires_at === null) return 0;
    if (a.expires_at === null) return 1;
    if (b.expires_at === null) return -1;
    return a.expires_at.localeCompare(b.expires_at);
  });
  return { available_count: alive.length, credits: alive };
}

export function parseClaudeUsagePayload(
  raw: Rec,
  options: { nowMs?: number; manualCredits?: UsageManualResetCreditInput[] } = {},
): UsageProvider {
  const nowMs = options.nowMs ?? Date.now();
  const rateLimits = asRecord(raw.rate_limits) ?? raw;
  const plan = capitalize(raw.subscription_type ?? rateLimits.subscription_type);
  const resetCredits = activeManualResetCredits(options.manualCredits, nowMs);
  if (raw.rate_limits_available === false) {
    return {
      ...errorUsage("claude", "error", "claude_no_limits", "No subscription usage allowance is available for this account.", nowMs),
      plan,
      reset_credits: resetCredits,
    };
  }
  const limits = rateLimits.limits;
  if (!Array.isArray(limits)) {
    throw new Error("Claude limits missing");
  }
  const caps = new Map<number, number>();
  if (Array.isArray(rateLimits.weekly_scoped_shares)) {
    for (const share of rateLimits.weekly_scoped_shares) {
      const s = asRecord(share);
      if (s && typeof s.limit_index === "number" && typeof s.allowance_percent_of_weekly === "number") {
        caps.set(s.limit_index, s.allowance_percent_of_weekly);
      }
    }
  }
  const kindMap: Record<string, { id: string; label: string; durationMs: number }> = {
    session: { id: "5h", label: "5h", durationMs: 5 * HOUR_MS },
    weekly_all: { id: "week", label: "Weekly", durationMs: 7 * DAY_MS },
    weekly_opus: { id: "week_opus", label: "Weekly Opus", durationMs: 7 * DAY_MS },
    weekly_sonnet: { id: "week_sonnet", label: "Weekly Sonnet", durationMs: 7 * DAY_MS },
  };
  const windows: UsageWindow[] = [];
  for (const [index, entry] of limits.entries()) {
    const item = asRecord(entry);
    if (!item) continue;
    const kind = typeof item.kind === "string" ? item.kind : "";
    const mapped = kindMap[kind];
    let id = mapped?.id ?? (kind || `window_${index}`);
    let label = mapped?.label ?? (kind || `Window ${index + 1}`);
    let durationMs: number | null = mapped?.durationMs ?? (id.startsWith("week") ? 7 * DAY_MS : null);
    let windowLabel: string | null = null;
    const scopeModel = asRecord(asRecord(item.scope)?.model);
    const modelName = typeof scopeModel?.display_name === "string" ? scopeModel.display_name.trim() : "";
    if (kind === "weekly_scoped" && modelName) {
      id = `week_${modelName.toLowerCase().replace(/\s+/g, "_")}`;
      label = `Weekly ${modelName}`;
      windowLabel = modelName;
      durationMs = 7 * DAY_MS;
    }
    const usedPct = clampPercent(typeof item.percent === "number" ? item.percent : Number(item.percent ?? 0));
    const cap = caps.get(index);
    const hasCap = typeof cap === "number" && Number.isFinite(cap);
    windows.push({
      id,
      label,
      ...(windowLabel ? { window_label: windowLabel } : {}),
      duration_ms: durationMs,
      used_pct: usedPct,
      resets_at: parseIsoTimestamp(item.resets_at),
      note: hasCap ? `Up to ${cap}% of weekly` : null,
      ...(hasCap ? { note_code: { code: "weekly_cap", cap } } : {}),
    });
  }
  const sortOrder = (id: string): number => {
    if (id === "5h") return 0;
    if (id === "week") return 1;
    if (id === "extra_credits") return 90;
    if (id.startsWith("week")) return 10;
    return 20;
  };
  windows.sort((a, b) => sortOrder(a.id) - sortOrder(b.id));

  const extra = asRecord(rateLimits.extra_usage);
  if (extra && extra.is_enabled === true) {
    windows.push({
      id: "extra_credits",
      label: "Extra credits",
      duration_ms: null,
      used_pct: clampPercent(typeof extra.utilization === "number" ? extra.utilization : Number(extra.utilization ?? 0)),
      resets_at: null,
      note: formatClaudeCreditsNote(rateLimits),
    });
  }
  return {
    id: "claude",
    name: "Claude",
    plan,
    windows,
    status: "ok",
    error: null,
    error_code: null,
    fetched_at: new Date(nowMs).toISOString(),
    reset_credits: resetCredits,
  };
}

function classifyClaudeError(reason: string, nowMs: number): UsageProvider {
  const lower = reason.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found")) {
    return errorUsage("claude", "error", "claude_cli_unavailable", "Claude CLI is not installed or not in PATH.", nowMs);
  }
  if (lower.includes("401") || lower.includes("expired") || lower.includes("not logged in") || lower.includes("authentication") || lower.includes("unauthorized")) {
    return errorUsage("claude", "auth_expired", "claude_auth_expired", "Claude authentication expired; run claude CLI to refresh.", nowMs);
  }
  if (lower.includes("403") || lower.includes("forbidden")) {
    return errorUsage("claude", "error", "claude_forbidden", "HTTP 403 from Anthropic; check proxyUrl in settings.", nowMs);
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return errorUsage("claude", "error", "timeout", "Request timed out.", nowMs);
  }
  return errorUsage("claude", "error", "parse_error", "Failed to query Claude usage.", nowMs);
}

export function probeClaudeUsageCli(
  cwd: string,
  command = "claude",
  timeoutMs = 20_000,
  env: NodeJS.ProcessEnv = proxyEnvironment(),
  signal?: AbortSignal,
): Promise<Rec> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const childEnv = { ...env };
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(command, [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-prompt-tool", "stdio",
    ], { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    registerChildProbe(child);
    child.stdin.on("error", () => { /* child exit/error handles failure without EPIPE crash */ });
    child.stdout.on("error", () => { /* ignore */ });
    child.stderr.on("error", () => { /* ignore */ });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1024) stderr += chunk.toString("utf8");
    });
    const requestId = randomUUID();
    let settled = false;
    const onAbort = () => fail(new Error("claude usage probe aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { child.stdin.end(); } catch { /* ignore */ }
      terminateChildProbe(child);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("claude usage probe timeout")), timeoutMs);
    timer.unref();
    child.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (!settled) fail(new Error(`claude exited (${code ?? "signal"}): ${stderr.slice(0, 200)}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (settled || !line.trim()) return;
      try {
        const message = JSON.parse(line) as Rec;
        if (message.type !== "control_response") return;
        const response = asRecord(message.response);
        if (!response || response.request_id !== requestId) return;
        if (response.subtype !== "success") {
          fail(new Error(typeof response.error === "string" ? response.error : "claude get_usage failed"));
          return;
        }
        const payload = asRecord(response.response);
        if (!payload) {
          fail(new Error("claude get_usage returned empty payload"));
          return;
        }
        settled = true;
        cleanup();
        resolvePromise(payload);
      } catch { /* ignore non-JSON stdout lines */ }
    });
    try {
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_usage" } })}\n`);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function parseWindowSpec(rawWindow: unknown, fallbackName = ""): {
  canonicalId: string;
  label: string;
  durationMs: number | null;
} {
  const candidates = [typeof rawWindow === "string" ? rawWindow.trim() : "", fallbackName.trim()].filter(Boolean);
  for (const text of candidates) {
    const lower = text.toLowerCase();
    if (lower === "5h" || /\b5\s*[- ]?\s*h(?:ours?|rs?)?\b/.test(lower) || lower === "300m") {
      return { canonicalId: "5h", label: "5h", durationMs: 5 * HOUR_MS };
    }
    if (lower === "week" || lower === "weekly" || lower === "7d" || /\b(?:7\s*[- ]?\s*d(?:ays?)?|1\s*week|168\s*h)\b/.test(lower) || lower === "10080m") {
      return { canonicalId: "week", label: "Weekly", durationMs: 7 * DAY_MS };
    }
    const hourMatch = /^(\d+)\s*[- ]?\s*h(?:ours?|rs?)?$/i.exec(lower);
    if (hourMatch) {
      const hours = Number(hourMatch[1]);
      if (hours === 5) return { canonicalId: "5h", label: "5h", durationMs: 5 * HOUR_MS };
      if (hours === 168) return { canonicalId: "week", label: "Weekly", durationMs: 7 * DAY_MS };
      return { canonicalId: `${hours}h`, label: `${hours}h`, durationMs: hours * HOUR_MS };
    }
    const dayMatch = /^(\d+)\s*[- ]?\s*d(?:ays?)?$/i.exec(lower);
    if (dayMatch) {
      const days = Number(dayMatch[1]);
      if (days === 7) return { canonicalId: "week", label: "Weekly", durationMs: 7 * DAY_MS };
      return { canonicalId: `${days * 24}h`, label: `${days * 24}h`, durationMs: days * DAY_MS };
    }
    const minMatch = /^(\d+)\s*[- ]?\s*m(?:in(?:ute)?s?)?$/i.exec(lower);
    if (minMatch) {
      const mins = Number(minMatch[1]);
      if (mins === 300) return { canonicalId: "5h", label: "5h", durationMs: 5 * HOUR_MS };
      if (mins === 10080) return { canonicalId: "week", label: "Weekly", durationMs: 7 * DAY_MS };
      if (mins % 60 === 0) {
        const hours = mins / 60;
        return { canonicalId: `${hours}h`, label: `${hours}h`, durationMs: hours * HOUR_MS };
      }
      return { canonicalId: `${mins}m`, label: `${mins}m`, durationMs: mins * MINUTE_MS };
    }
  }
  const clean = (typeof rawWindow === "string" && rawWindow.trim()) || fallbackName.trim() || "Quota";
  return { canonicalId: clean.toLowerCase().replace(/[^a-z0-9_]+/g, "_"), label: clean, durationMs: null };
}

function unwrapJsonPayload(raw: unknown): Rec {
  const top = asRecord(raw);
  if (!top) throw new Error("JSON output is not an object");
  if (Array.isArray(top.groups) || "remaining_credits" in top || "plan_name" in top) return top;
  for (const key of ["result", "data", "output", "quota", "usage"]) {
    const nested = asRecord(top[key]);
    if (nested && (Array.isArray(nested.groups) || "remaining_credits" in nested || "plan_name" in nested)) {
      return nested;
    }
  }
  return top;
}

export function parseAntigravityUsagePayload(
  usageRaw: unknown,
  creditsRaw?: unknown,
  nowMs = Date.now(),
): UsageProvider {
  const usage = unwrapJsonPayload(usageRaw);
  const credits = creditsRaw !== undefined && creditsRaw !== null ? unwrapJsonPayload(creditsRaw) : null;
  const rawPlan = credits?.plan_name ?? usage.plan_name ?? usage.plan_tier ?? usage.tier ?? usage.plan;
  const plan = typeof rawPlan === "string" && rawPlan.trim() ? rawPlan.trim() : null;
  const remainingCredits = typeof credits?.remaining_credits === "number" && Number.isFinite(credits.remaining_credits)
    ? credits.remaining_credits
    : null;
  const creditsNote = remainingCredits !== null && remainingCredits >= 0 ? `${remainingCredits}` : null;

  const groups = usage.groups;
  if (!Array.isArray(groups)) {
    throw new Error("Antigravity quota groups missing");
  }
  const activeGroups = groups.map(asRecord).filter((g): g is Rec => g !== null);
  const multiGroup = activeGroups.length > 1;
  const windows: UsageWindow[] = [];

  for (const [gIndex, group] of activeGroups.entries()) {
    const groupName = typeof group.name === "string" ? group.name.trim() : "";
    const buckets = Array.isArray(group.buckets) ? group.buckets.map(asRecord).filter((b): b is Rec => b !== null) : [];
    const enabledBuckets = buckets.filter((b) => b.disabled !== true);
    const chosen = enabledBuckets.length > 0 ? enabledBuckets : [];
    for (const [bIndex, bucket] of chosen.entries()) {
      const bucketName = typeof bucket.name === "string" ? bucket.name.trim() : "";
      const spec = parseWindowSpec(bucket.window, bucketName);
      let usedPct = 0;
      if (typeof bucket.used_percentage === "number") {
        usedPct = clampPercent(bucket.used_percentage);
      } else if (typeof bucket.remaining_percentage === "number") {
        usedPct = clampPercent(100 - bucket.remaining_percentage);
      } else if (typeof bucket.remaining_fraction === "number") {
        usedPct = clampPercent((1 - bucket.remaining_fraction) * 100);
      }
      const remAmount = bucket.remaining_amount !== undefined && bucket.remaining_amount !== null
        ? String(bucket.remaining_amount).trim()
        : "";
      // Avoid duplicating groupName when bucketName already equals groupName.
      const subLabel = bucketName && bucketName.toLowerCase() !== groupName.toLowerCase() && spec.durationMs === null
        ? bucketName
        : spec.label;
      const winId = !multiGroup && chosen.length <= 2 && (spec.canonicalId === "5h" || spec.canonicalId === "week")
        ? spec.canonicalId
        : `${(groupName || `g${gIndex}`).toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${typeof bucket.id === "string" && bucket.id ? bucket.id : `${spec.canonicalId}_${bIndex}`}`;
      windows.push({
        id: winId,
        label: multiGroup && groupName ? `${groupName} · ${subLabel}` : (subLabel || groupName || "Quota"),
        group: multiGroup && groupName ? groupName : null,
        window_label: subLabel,
        duration_ms: spec.durationMs,
        used_pct: usedPct,
        resets_at: parseIsoTimestamp(bucket.reset_time ?? bucket.resets_at),
        note: remAmount ? `Remaining: ${remAmount}` : null,
        ...(remAmount ? { note_code: { code: "remaining_amount", amount: remAmount } } : {}),
      });
    }
  }

  if (windows.length === 0) {
    return {
      ...errorUsage(
        "antigravity",
        "error",
        "antigravity_no_limits",
        "No quota windows were returned for this Antigravity account.",
        nowMs,
        true,
      ),
      plan,
      ...(creditsNote ? { credits_note: creditsNote } : {}),
    };
  }

  return {
    id: "antigravity",
    name: "Antigravity",
    plan,
    windows,
    status: "ok",
    error: null,
    error_code: null,
    fetched_at: new Date(nowMs).toISOString(),
    reset_credits: null,
    ...(creditsNote ? { credits_note: creditsNote } : {}),
    on_demand: true,
  };
}

const activeProbeChildren = new Set<ChildProcess>();

function registerChildProbe(child: ChildProcess): void {
  activeProbeChildren.add(child);
  child.once("close", () => activeProbeChildren.delete(child));
}

function terminateChildProbe(child: ChildProcess, graceMs = 2_000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, graceMs);
  killTimer.unref();
  child.once("close", () => clearTimeout(killTimer));
}

async function drainActiveChildProbes(graceMs = 500): Promise<void> {
  if (activeProbeChildren.size === 0) return;
  const children = [...activeProbeChildren];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
  await Promise.race([
    Promise.all(children.map((child) => (
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("close", () => resolve()))
    ))),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, graceMs);
      t.unref();
    }),
  ]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

export function runJsonCliCommand(
  command: string,
  args: string[],
  timeoutMs = 20_000,
  env: NodeJS.ProcessEnv = proxyEnvironment(),
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChildProbe(child);
    child.stdout.on("error", () => { /* ignore */ });
    child.stderr.on("error", () => { /* ignore */ });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_048_576) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    let settled = false;
    const onAbort = () => finish(new Error(`${command} aborted`));
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (err?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      terminateChildProbe(child);
      if (err) reject(err);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error(`${command} timeout`)), timeoutMs);
    timer.unref();
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`${command} exited ${code}: ${(stderr || stdout).slice(0, 240)}`));
        return;
      }
      try {
        const trimmed = stdout.trim();
        const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
        // Support either single JSON document or final JSON line.
        try {
          finish(undefined, JSON.parse(trimmed));
        } catch {
          finish(undefined, JSON.parse(lines.at(-1) ?? ""));
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function classifyAntigravityError(reason: string, nowMs: number): UsageProvider {
  const lower = reason.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found")) {
    return errorUsage("antigravity", "error", "antigravity_cli_unavailable", "Antigravity CLI (agy) is not installed or not in PATH.", nowMs, true);
  }
  if (lower.includes("auth") || lower.includes("login") || lower.includes("sign in") || lower.includes("unauthenticated") || lower.includes("401")) {
    return errorUsage("antigravity", "auth_expired", "antigravity_auth_expired", "Antigravity login required; run agy to sign in.", nowMs, true);
  }
  if (lower.includes("timeout")) {
    return errorUsage("antigravity", "error", "timeout", "Request timed out.", nowMs, true);
  }
  return errorUsage("antigravity", "error", "parse_error", "Failed to query Antigravity usage.", nowMs, true);
}

function pickField(record: Rec, camel: string, snake: string): unknown {
  return camel in record ? record[camel] : record[snake];
}

function codexWindowIdentity(durationMins: number): { id: string; label: string; durationMs: number } {
  if (durationMins === 300) return { id: "5h", label: "5h", durationMs: 5 * HOUR_MS };
  if (durationMins === 10080) return { id: "week", label: "Weekly", durationMs: 7 * DAY_MS };
  if (durationMins % 60 === 0) {
    const hours = durationMins / 60;
    return { id: `${hours}h`, label: `${hours}h`, durationMs: hours * HOUR_MS };
  }
  return { id: `${durationMins}m`, label: `${durationMins}m`, durationMs: durationMins * MINUTE_MS };
}

export function parseCodexRateLimits(
  rateLimitsRaw: unknown,
  options: {
    status?: UsageProviderStatus;
    fetchedAtMs?: number;
    resetCreditsRaw?: unknown;
    previousCredits?: UsageResetCredit[] | null;
  } = {},
): { usage: UsageProvider; creditDetails: UsageResetCredit[] | null } {
  const rateLimits = asRecord(rateLimitsRaw);
  if (!rateLimits) throw new Error("Codex rateLimits missing");
  const fetchedAtMs = options.fetchedAtMs ?? Date.now();
  const status = options.status ?? "ok";

  const entries: Array<{ mins: number; win: UsageWindow }> = [];
  for (const key of ["primary", "secondary"] as const) {
    const rawWin = rateLimits[key];
    if (rawWin === null || rawWin === undefined) continue;
    const win = asRecord(rawWin);
    if (!win) throw new Error(`Codex ${key} window invalid`);
    const durationVal = pickField(win, "windowDurationMins", "window_minutes");
    const usedVal = pickField(win, "usedPercent", "used_percent");
    if (typeof durationVal !== "number" || typeof usedVal !== "number") {
      throw new Error(`Codex ${key} window fields missing`);
    }
    const mins = Math.trunc(durationVal);
    const identity = codexWindowIdentity(mins);
    const resetVal = pickField(win, "resetsAt", "resets_at");
    const resetsAt = typeof resetVal === "number" && Number.isFinite(resetVal)
      ? new Date(resetVal * 1000).toISOString()
      : parseIsoTimestamp(resetVal);
    entries.push({
      mins,
      win: {
        id: identity.id,
        label: identity.label,
        duration_ms: identity.durationMs,
        used_pct: clampPercent(usedVal),
        resets_at: resetsAt,
        note: null,
      },
    });
  }
  if (entries.length === 0) throw new Error("Codex rateLimits has no windows");
  entries.sort((a, b) => a.mins - b.mins);

  let resetCredits: UsageResetCredits | null = null;
  let nextDetails: UsageResetCredit[] | null = options.previousCredits ?? null;
  const creditsObj = asRecord(options.resetCreditsRaw);
  if (creditsObj && typeof creditsObj.availableCount === "number") {
    const count = Math.max(0, Math.trunc(creditsObj.availableCount));
    if (Array.isArray(creditsObj.credits)) {
      const available: UsageResetCredit[] = [];
      for (const item of creditsObj.credits) {
        const c = asRecord(item);
        if (!c || c.status !== "available") continue;
        const exp = typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt)
          ? new Date(c.expiresAt * 1000).toISOString()
          : parseIsoTimestamp(c.expiresAt);
        available.push({ expires_at: exp });
      }
      available.sort((a, b) => {
        if (a.expires_at === null && b.expires_at === null) return 0;
        if (a.expires_at === null) return 1;
        if (b.expires_at === null) return -1;
        return a.expires_at.localeCompare(b.expires_at);
      });
      nextDetails = available;
      resetCredits = { available_count: count, credits: available };
    } else {
      const alive = (options.previousCredits ?? []).filter(
        (c) => c.expires_at === null || Date.parse(c.expires_at) > fetchedAtMs,
      );
      resetCredits = {
        available_count: count,
        credits: alive.length > 0 && alive.length === count ? alive : null,
      };
    }
  } else if (options.resetCreditsRaw === null) {
    nextDetails = null;
  }

  const plan = capitalize(pickField(rateLimits, "planType", "plan_type"));
  return {
    creditDetails: nextDetails,
    usage: {
      id: "codex",
      name: "Codex",
      plan,
      windows: entries.map((e) => e.win),
      status,
      error: null,
      error_code: null,
      fetched_at: new Date(fetchedAtMs).toISOString(),
      reset_credits: resetCredits,
    },
  };
}

export function codexSessionsDir(): string {
  return process.env.WORKBENCH_CODEX_HISTORY_DIR || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

function listRolloutFiles(root: string): Array<{ mtimeMs: number; path: string }> {
  const results: Array<{ mtimeMs: number; path: string }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          results.push({ mtimeMs: statSync(full).mtimeMs, path: full });
        } catch { /* ignore */ }
      }
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

export function readLatestCodexSessionUsage(sessionsRoot = codexSessionsDir()): UsageProvider | null {
  for (const file of listRolloutFiles(sessionsRoot).slice(0, 12)) {
    let latest: UsageProvider | null = null;
    try {
      const content = readFileSync(file.path, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (!line.includes("rate_limits")) continue;
        try {
          const item = asRecord(JSON.parse(line));
          const payload = asRecord(item?.payload);
          if (!item || !payload || !asRecord(payload.rate_limits)) continue;
          const ts = parseIsoTimestamp(item.timestamp);
          if (!ts) continue;
          latest = parseCodexRateLimits(payload.rate_limits, {
            status: "stale",
            fetchedAtMs: Date.parse(ts),
          }).usage;
        } catch { /* ignore malformed lines */ }
      }
    } catch {
      continue;
    }
    if (latest) {
      latest.error_code = "codex_local_fallback";
      latest.error = "Showing cached rate limits from local Codex session rollout; app-server could not reach chatgpt.com.";
      return latest;
    }
  }
  return null;
}

export function queryCodexAppServerRateLimits(
  command = "codex",
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = proxyEnvironment(),
  signal?: AbortSignal,
): Promise<Rec> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const childEnv = { ...env };
    const prefs = loadPrefs();
    const explicitProxy = prefs.proxyUrl ?? prefs.codexProxyUrl;
    if (explicitProxy) {
      // Match ai-usage: prevent inherited NO_PROXY=* from bypassing configured proxy on app-server API calls.
      delete childEnv.no_proxy;
      delete childEnv.NO_PROXY;
    }
    const child = spawn(command, ["app-server", "--stdio"], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    registerChildProbe(child);
    child.stdin.on("error", () => { /* child close/error handles failure without EPIPE crash */ });
    child.stdout.on("error", () => { /* ignore */ });
    child.stderr.on("error", () => { /* ignore */ });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 512) stderr += chunk.toString("utf8");
    });
    let settled = false;
    let stage: "init" | "read" = "init";
    const onAbort = () => finish(new Error("codex app-server aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (err?: Error, result?: Rec) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { child.stdin.end(); } catch { /* ignore */ }
      terminateChildProbe(child);
      if (err) reject(err);
      else resolvePromise(result!);
    };
    const timer = setTimeout(() => finish(new Error("codex app-server timeout")), timeoutMs);
    timer.unref();
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`codex app-server closed (${code ?? "signal"}): ${stderr.trim()}`));
    });
    const send = (frame: Rec) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (settled || !line.trim()) return;
      let msg: Rec | null;
      try {
        msg = asRecord(JSON.parse(line));
      } catch {
        finish(new Error("invalid JSON-RPC from codex app-server"));
        return;
      }
      if (!msg) return;
      if (stage === "init" && msg.id === 1) {
        if ("error" in msg) {
          finish(new Error("codex initialize failed"));
          return;
        }
        stage = "read";
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        return;
      }
      if (stage === "read" && msg.id === 2) {
        if ("error" in msg) {
          finish(new Error("codex account/rateLimits/read failed"));
          return;
        }
        const result = asRecord(msg.result);
        if (!result) {
          finish(new Error("codex rateLimits result invalid"));
          return;
        }
        finish(undefined, result);
      }
    });
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "aireins-usage", version: "0.5.0" } },
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

const MAX_API_KEY_FILE_BYTES = 65_536;

export function isValidKimiApiKey(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function extractKeyFromShellFile(filePath: string, envName: string): string | null {
  let content: string;
  let fd: number | undefined;
  try {
    fd = openSync(expandHome(filePath), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_API_KEY_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(Math.min(st.size || MAX_API_KEY_FILE_BYTES, MAX_API_KEY_FILE_BYTES));
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    content = buf.subarray(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  const escaped = envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, "m");
  const match = pattern.exec(content);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return isValidKimiApiKey(value) ? value : null;
}

export function resolveKimiKey(
  config: UsageStoredConfig["kimi"],
  env: NodeJS.ProcessEnv = process.env,
): { key: string | null; source: "config" | "env" | "file" | "none"; envName: string } {
  const envName = typeof config?.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)
    ? config.apiKeyEnv
    : "KIMI_API_KEY";
  if (typeof config?.apiKey === "string") {
    const cfgVal = config.apiKey.trim();
    if (isValidKimiApiKey(cfgVal)) return { key: cfgVal, source: "config", envName };
  }
  const envVal = (env[envName] ?? "").trim();
  if (isValidKimiApiKey(envVal)) {
    return { key: envVal, source: "env", envName };
  }
  if (typeof config?.apiKeyFile === "string" && config.apiKeyFile.trim()) {
    const fileVal = extractKeyFromShellFile(config.apiKeyFile.trim(), envName);
    if (fileVal) return { key: fileVal, source: "file", envName };
  }
  return { key: null, source: "none", envName };
}

export interface HttpJsonResponse {
  status: number;
  body: string;
}

export function httpsGetDirectOrProxy(
  targetUrl: string,
  headers: Record<string, string>,
  options: { proxyUrl?: string | null; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HttpJsonResponse> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const target = new URL(targetUrl);
  const proxyRaw = options.proxyUrl?.trim();
  if (!proxyRaw) {
    return new Promise((resolvePromise, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      let settled = false;
      let req: ReturnType<typeof httpsRequest> | undefined;
      const done = (err?: Error, value?: HttpJsonResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (err) {
          try { req?.destroy(); } catch { /* ignore */ }
          reject(err);
        } else {
          resolvePromise(value!);
        }
      };
      const wallTimer = setTimeout(() => done(new Error("timeout")), timeoutMs);
      wallTimer.unref();
      const onAbort = () => {
        done(new Error("aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        req = httpsRequest({
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: "GET",
          headers,
          timeout: timeoutMs,
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_048_576) req?.destroy(new Error("response too large"));
          });
          res.on("end", () => done(undefined, { status: res.statusCode ?? 0, body }));
          res.on("error", (err) => done(err));
        });
        req.on("timeout", () => req?.destroy(new Error("timeout")));
        req.on("error", (err) => done(err));
        req.end();
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  const proxy = new URL(proxyRaw);
  const targetPort = Number(target.port || 443);
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let settled = false;
    let activeSocket: import("node:stream").Duplex | undefined;
    let activeTls: ReturnType<typeof tlsConnect> | undefined;
    let activeReq: ReturnType<typeof httpsRequest> | undefined;
    let connectReq: ReturnType<typeof httpRequest> | undefined;
    const finish = (err?: Error, value?: HttpJsonResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) {
        try { activeReq?.destroy(); } catch { /* ignore */ }
        try { activeTls?.destroy(); } catch { /* ignore */ }
        try { activeSocket?.destroy(); } catch { /* ignore */ }
        try { connectReq?.destroy(); } catch { /* ignore */ }
        reject(err);
      } else {
        resolvePromise(value!);
      }
    };
    const wallTimer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    wallTimer.unref();
    const onAbort = () => {
      finish(new Error("aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      connectReq = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
        hostname: proxy.hostname,
        port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT",
        path: `${target.hostname}:${targetPort}`,
        headers: { Host: `${target.hostname}:${targetPort}` },
        timeout: timeoutMs,
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    connectReq.on("timeout", () => connectReq?.destroy(new Error("timeout")));
    connectReq.on("error", (err) => finish(err));
    connectReq.on("connect", (res, socket) => {
      activeSocket = socket;
      socket.on("error", (err) => finish(err));
      if (res.statusCode !== 200) {
        finish(new Error(`proxy CONNECT status ${res.statusCode ?? 0}`));
        return;
      }
      try {
        const req = httpsRequest({
          hostname: target.hostname,
          port: targetPort,
          path: target.pathname + target.search,
          method: "GET",
          headers,
          // NOTE: Do NOT pass `agent: false` here — in Node `https.request`, `agent: false` constructs
          // a fresh `https.Agent` whose `createConnection` overrides `options.createConnection`.
          createConnection: () => {
            const tlsSocket = tlsConnect({
              socket,
              servername: target.hostname,
            });
            activeTls = tlsSocket;
            tlsSocket.on("error", (err) => finish(err));
            return tlsSocket;
          },
          timeout: timeoutMs,
        }, (upRes) => {
          let body = "";
          upRes.setEncoding("utf8");
          upRes.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 1_048_576) req.destroy(new Error("response too large"));
          });
          upRes.on("end", () => finish(undefined, { status: upRes.statusCode ?? 0, body }));
          upRes.on("error", (err) => finish(err));
        });
        activeReq = req;
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (err) => finish(err));
        req.end();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    connectReq.end();
  });
}

function kimiWindowMinutes(win: Rec): number | null {
  const duration = win.duration;
  const unit = typeof win.timeUnit === "string" ? win.timeUnit.toUpperCase() : "";
  if (typeof duration !== "number" || !Number.isFinite(duration)) return null;
  if (unit.includes("MINUTE")) return Math.trunc(duration);
  if (unit.includes("HOUR")) return Math.trunc(duration * 60);
  if (unit.includes("DAY")) return Math.trunc(duration * 60 * 24);
  return null;
}

function kimiUsedPct(detail: Rec): number {
  const limit = Number(detail.limit ?? 0);
  const used = Number(detail.used ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return 0;
  return clampPercent((used / limit) * 100);
}

export function parseKimiUsagePayload(raw: unknown, nowMs = Date.now()): UsageProvider {
  const payload = asRecord(raw);
  if (!payload) throw new Error("Kimi payload is not an object");
  if (!("limits" in payload) && !("usage" in payload)) {
    return errorUsage("kimi", "auth_expired", "kimi_no_plan", "Kimi subscription has expired (API key valid, no active plan returned).", nowMs);
  }
  if (!Array.isArray(payload.limits)) throw new Error("Kimi limits missing");
  const shortWindows: Array<{ mins: number; win: UsageWindow }> = [];
  for (const entry of payload.limits) {
    const item = asRecord(entry);
    const win = asRecord(item?.window);
    const detail = asRecord(item?.detail);
    if (!item || !win || !detail) throw new Error("Kimi limits entry invalid");
    const mins = kimiWindowMinutes(win);
    if (mins === null) continue;
    const identity = codexWindowIdentity(mins);
    shortWindows.push({
      mins,
      win: {
        id: identity.id,
        label: identity.label,
        duration_ms: identity.durationMs,
        used_pct: kimiUsedPct(detail),
        resets_at: parseIsoTimestamp(detail.resetTime),
        note: null,
      },
    });
  }
  shortWindows.sort((a, b) => a.mins - b.mins);
  const windows = shortWindows.map((item) => item.win);
  const usage = asRecord(payload.usage);
  if (usage) {
    windows.push({
      id: "week",
      label: "Weekly",
      duration_ms: 7 * DAY_MS,
      used_pct: kimiUsedPct(usage),
      resets_at: parseIsoTimestamp(usage.resetTime),
      note: null,
    });
  }
  let plan: string | null = null;
  if (typeof payload.subType === "string" && payload.subType.trim()) {
    const stripped = payload.subType.trim().replace(/^TYPE_/i, "");
    plan = capitalize(stripped.toLowerCase());
  }
  return {
    id: "kimi",
    name: "Kimi",
    plan,
    windows,
    status: "ok",
    error: null,
    error_code: null,
    fetched_at: new Date(nowMs).toISOString(),
    reset_credits: null,
  };
}

function readPrivateJsonFile(filePath: string): { parsed: Rec | null; privateMode: boolean } {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0);
    fd = openSync(filePath, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1_048_576) return { parsed: null, privateMode: false };
    let privateMode = (st.mode & 0o077) === 0;
    if (!privateMode) {
      try {
        fchmodSync(fd, 0o600);
        privateMode = (fstatSync(fd).mode & 0o077) === 0;
      } catch {
        privateMode = false;
      }
    }
    const buf = Buffer.allocUnsafe(st.size);
    const bytes = st.size > 0 ? readSync(fd, buf, 0, st.size, 0) : 0;
    const parsed = asRecord(JSON.parse(buf.subarray(0, bytes).toString("utf8")));
    return { parsed, privateMode };
  } catch {
    return { parsed: null, privateMode: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writePrivateJsonFile(targetPath: string, data: unknown, pretty = false): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const content = pretty ? `${JSON.stringify(data, null, 2)}\n` : `${JSON.stringify(data)}\n`;
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function loadUsageConfig(configPath: string): UsageStoredConfig {
  try {
    if (!existsSync(configPath)) return { version: 1 };
    const { parsed, privateMode } = readPrivateJsonFile(configPath);
    if (!parsed) return { version: 1 };
    const providersRaw = asRecord(parsed.providers);
    const providers: Partial<Record<UsageProviderId, { enabled?: boolean }>> = {};
    if (providersRaw) {
      for (const id of USAGE_PROVIDER_ORDER) {
        const entry = asRecord(providersRaw[id]);
        if (entry && typeof entry.enabled === "boolean") providers[id] = { enabled: entry.enabled };
      }
    }
    const kimiRaw = asRecord(parsed.kimi);
    const allowStoredSecret = privateMode;
    if (!allowStoredSecret && typeof kimiRaw?.apiKey === "string" && kimiRaw.apiKey.trim()) {
      log("warn", "ignoring stored Kimi apiKey because usage.json permissions could not be restricted to 0600");
    }
    const claudeRaw = asRecord(parsed.claude);
    return {
      version: 1,
      providers,
      ...(kimiRaw ? {
        kimi: {
          ...(allowStoredSecret && typeof kimiRaw.apiKey === "string" && isValidKimiApiKey(kimiRaw.apiKey.trim()) ? { apiKey: kimiRaw.apiKey.trim() } : {}),
          ...(typeof kimiRaw.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(kimiRaw.apiKeyEnv) ? { apiKeyEnv: kimiRaw.apiKeyEnv } : {}),
          ...(typeof kimiRaw.apiKeyFile === "string" && kimiRaw.apiKeyFile.trim() ? { apiKeyFile: kimiRaw.apiKeyFile.trim() } : {}),
          ...(typeof kimiRaw.useProxy === "boolean" ? { useProxy: kimiRaw.useProxy } : {}),
        },
      } : {}),
      ...(claudeRaw && Array.isArray(claudeRaw.resetCredits) ? {
        claude: {
          resetCredits: claudeRaw.resetCredits
            .map(asRecord)
            .filter((item): item is Rec => item !== null)
            .slice(0, 50)
            .map((item) => ({
              ...(typeof item.title === "string" && item.title.trim() ? { title: item.title.trim().slice(0, 120) } : {}),
              ...(typeof item.expires === "string" && item.expires.trim() ? { expires: item.expires.trim().slice(0, 64) } : { expires: null }),
            })),
        },
      } : {}),
    };
  } catch {
    log("warn", "usage config could not be loaded; using defaults");
    return { version: 1 };
  }
}

export function saveUsageConfig(configPath: string, config: UsageStoredConfig): void {
  writePrivateJsonFile(configPath, { ...config, version: 1 }, true);
}

export function buildUsageSettingsView(
  config: UsageStoredConfig,
  env: NodeJS.ProcessEnv = process.env,
  meta?: { instanceId: string; revision: number },
): UsageSettingsView {
  const providers = {} as Record<UsageProviderId, { enabled: boolean }>;
  for (const id of USAGE_PROVIDER_ORDER) {
    providers[id] = { enabled: config.providers?.[id]?.enabled !== false };
  }
  const resolved = resolveKimiKey(config.kimi, env);
  return {
    ...(meta ? { instance_id: meta.instanceId, revision: meta.revision } : {}),
    providers,
    kimi: {
      keyConfigured: resolved.key !== null,
      keySource: resolved.source,
      apiKeyEnv: resolved.envName,
      apiKeyFile: config.kimi?.apiKeyFile ?? null,
      useProxy: config.kimi?.useProxy === true,
    },
    claude: {
      resetCredits: config.claude?.resetCredits ?? [],
    },
  };
}

export function applyUsageSettingsPatch(current: UsageStoredConfig, input: unknown): UsageStoredConfig {
  const body = asRecord(input);
  if (!body) throw new UsageInputError("Request body must be a JSON object");
  const next: UsageStoredConfig = {
    version: 1,
    providers: { ...current.providers },
    ...(current.kimi ? { kimi: { ...current.kimi } } : {}),
    ...(current.claude ? { claude: { ...current.claude } } : {}),
  };

  if (body.providers !== undefined) {
    const prov = asRecord(body.providers);
    if (!prov) throw new UsageInputError("providers must be an object");
    for (const [key, val] of Object.entries(prov)) {
      if (!USAGE_PROVIDER_ORDER.includes(key as UsageProviderId)) {
        throw new UsageInputError(`Unknown provider: ${key}`);
      }
      const entry = asRecord(val);
      if (!entry || typeof entry.enabled !== "boolean") {
        throw new UsageInputError(`providers.${key}.enabled must be a boolean`);
      }
      next.providers![key as UsageProviderId] = { enabled: entry.enabled };
    }
  }

  if (body.kimi !== undefined) {
    const kimi = asRecord(body.kimi);
    if (!kimi) throw new UsageInputError("kimi must be an object");
    const nextKimi = { ...next.kimi };
    if ("apiKey" in kimi) {
      if (kimi.apiKey === null || kimi.apiKey === "") {
        delete nextKimi.apiKey;
      } else if (typeof kimi.apiKey === "string") {
        const trimmed = kimi.apiKey.trim();
        if (!trimmed) {
          delete nextKimi.apiKey;
        } else if (!isValidKimiApiKey(trimmed)) {
          throw new UsageInputError("Invalid Kimi API key format");
        } else {
          nextKimi.apiKey = trimmed;
        }
      } else {
        throw new UsageInputError("kimi.apiKey must be a string or null");
      }
    }
    if ("apiKeyFile" in kimi) {
      if (kimi.apiKeyFile === null || kimi.apiKeyFile === "") {
        delete nextKimi.apiKeyFile;
      } else if (typeof kimi.apiKeyFile === "string") {
        const file = kimi.apiKeyFile.trim();
        const expanded = expandHome(file);
        if (file.length > 1024 || file.includes("\0") || !isAbsolute(expanded)) {
          throw new UsageInputError("kimi.apiKeyFile must be an absolute or ~/ path");
        }
        let fd: number | undefined;
        try {
          fd = openSync(expanded, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
          const st = fstatSync(fd);
          if (!st.isFile() || st.size > MAX_API_KEY_FILE_BYTES) {
            throw new UsageInputError("kimi.apiKeyFile must be a regular file up to 64 KiB");
          }
        } catch (err) {
          if (err instanceof UsageInputError) throw err;
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw new UsageInputError("kimi.apiKeyFile is unreadable or not a regular file");
          }
        } finally {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* ignore */ }
          }
        }
        nextKimi.apiKeyFile = file;
      } else {
        throw new UsageInputError("kimi.apiKeyFile must be a string or null");
      }
    }
    if ("useProxy" in kimi) {
      if (typeof kimi.useProxy !== "boolean") throw new UsageInputError("kimi.useProxy must be a boolean");
      nextKimi.useProxy = kimi.useProxy;
    }
    next.kimi = nextKimi;
  }

  if (body.claude !== undefined) {
    const claude = asRecord(body.claude);
    if (!claude) throw new UsageInputError("claude must be an object");
    if ("resetCredits" in claude) {
      if (!Array.isArray(claude.resetCredits) || claude.resetCredits.length > 50) {
        throw new UsageInputError("claude.resetCredits must be an array of up to 50 items");
      }
      next.claude = {
        resetCredits: claude.resetCredits.map((raw) => {
          const item = asRecord(raw);
          if (!item) throw new UsageInputError("resetCredits item must be an object");
          const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : undefined;
          const expires = item.expires === null || item.expires === undefined || item.expires === ""
            ? null
            : typeof item.expires === "string" ? item.expires.trim() : undefined;
          if (expires === undefined || (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires) && !parseIsoTimestamp(expires))) {
            throw new UsageInputError("resetCredits.expires must be YYYY-MM-DD, ISO8601, or null");
          }
          return { ...(title ? { title } : {}), expires };
        }),
      };
    }
  }

  return next;
}

function sanitizeCachedProvider(raw: unknown): UsageProvider | null {
  const p = asRecord(raw);
  if (!p || !USAGE_PROVIDER_ORDER.includes(p.id as UsageProviderId)) return null;
  const fetchedAt = parseIsoTimestamp(p.fetched_at);
  if (!fetchedAt) return null;
  const status = p.status;
  if (status !== "ok" && status !== "stale" && status !== "auth_expired" && status !== "error") return null;
  if (!Array.isArray(p.windows)) return null;
  const windows: UsageWindow[] = [];
  for (const wRaw of p.windows) {
    const w = asRecord(wRaw);
    if (!w || typeof w.id !== "string" || typeof w.label !== "string" || typeof w.used_pct !== "number") continue;
    windows.push({
      id: w.id,
      label: w.label,
      ...(typeof w.group === "string" ? { group: w.group } : {}),
      ...(typeof w.window_label === "string" ? { window_label: w.window_label } : {}),
      ...(typeof w.duration_ms === "number" ? { duration_ms: w.duration_ms } : {}),
      used_pct: clampPercent(w.used_pct),
      resets_at: parseIsoTimestamp(w.resets_at),
      note: typeof w.note === "string" ? w.note : null,
      ...(asRecord(w.note_code) ? { note_code: w.note_code as UsageWindowNoteCode } : {}),
    });
  }
  let resetCredits: UsageResetCredits | null = null;
  const rc = asRecord(p.reset_credits);
  if (rc && typeof rc.available_count === "number") {
    resetCredits = {
      available_count: Math.max(0, Math.trunc(rc.available_count)),
      credits: Array.isArray(rc.credits)
        ? rc.credits.map(asRecord).filter((c): c is Rec => c !== null).map((c) => ({
            expires_at: typeof c.expires_at === "string" ? c.expires_at : null,
            ...(c.all_day === true ? { all_day: true } : {}),
            ...(typeof c.title === "string" ? { title: c.title } : {}),
          }))
        : null,
    };
  }
  const id = p.id as UsageProviderId;
  return {
    id,
    name: USAGE_PROVIDER_NAMES[id],
    plan: typeof p.plan === "string" ? p.plan : null,
    windows,
    status,
    error: typeof p.error === "string" ? p.error : null,
    ...(typeof p.error_code === "string" ? { error_code: p.error_code as UsageProviderErrorCode } : {}),
    ...(typeof p.http_status === "number" && Number.isFinite(p.http_status) ? { http_status: Math.trunc(p.http_status) } : {}),
    fetched_at: fetchedAt,
    reset_credits: resetCredits,
    ...(typeof p.credits_note === "string" ? { credits_note: p.credits_note } : {}),
    ...(p.on_demand === true || id === "antigravity" ? { on_demand: true } : {}),
  };
}

export function createDefaultUsageRunners(options: {
  cwd?: string;
  getConfig: () => UsageStoredConfig;
  now?: () => number;
  liveClaudeUsage?: () => Promise<Rec | null>;
  httpGet?: typeof httpsGetDirectOrProxy;
  codexSessionsRoot?: () => string;
  env?: NodeJS.ProcessEnv;
}): Record<UsageProviderId, UsageProviderRunner> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? Date.now;
  const httpGet = options.httpGet ?? httpsGetDirectOrProxy;
  const sessionsRoot = options.codexSessionsRoot ?? codexSessionsDir;

  let codexFailures = 0;
  let lastCodexAttemptMs: number | null = null;
  let lastCodexCreditDetails: UsageResetCredit[] | null = null;
  const CODEX_MAX_FAILURES = 3;
  const CODEX_RETRY_AFTER_MS = 30 * MINUTE_MS;

  const claudeRunner: UsageProviderRunner = {
    id: "claude",
    async fetch(signal?: AbortSignal): Promise<UsageProvider> {
      const manualCredits = options.getConfig().claude?.resetCredits;
      try {
        const live = await options.liveClaudeUsage?.().catch(() => null);
        const payload = live ?? await probeClaudeUsageCli(cwd, "claude", 20_000, proxyEnvironment(), signal);
        return parseClaudeUsagePayload(payload, { nowMs: now(), manualCredits });
      } catch (err) {
        const errAt = now();
        const reason = err instanceof Error ? err.message : String(err);
        log("warn", "claude usage fetch failed", { reason: err instanceof Error ? err.name : "Error" });
        const fallback = classifyClaudeError(reason, errAt);
        fallback.reset_credits = activeManualResetCredits(manualCredits, errAt);
        return fallback;
      }
    },
  };

  // Compliance boundary: Antigravity is strictly onDemand (never background-polled) and uses official `agy -p`.
  const antigravityRunner: UsageProviderRunner = {
    id: "antigravity",
    onDemand: true,
    async fetch(signal?: AbortSignal): Promise<UsageProvider> {
      try {
        const env = proxyEnvironment();
        const [usageOut, creditsOut] = await Promise.all([
          runJsonCliCommand("agy", ["-p", "/usage", "--output-format", "json"], 20_000, env, signal),
          runJsonCliCommand("agy", ["-p", "/credits", "--output-format", "json"], 15_000, env, signal).catch(() => null),
        ]);
        return parseAntigravityUsagePayload(usageOut, creditsOut, now());
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log("warn", "antigravity usage fetch failed", { reason: err instanceof Error ? err.name : "Error" });
        return classifyAntigravityError(reason, now());
      }
    },
  };

  const codexRunner: UsageProviderRunner = {
    id: "codex",
    resetBackoff() {
      codexFailures = 0;
      lastCodexAttemptMs = null;
    },
    async fetch(signal?: AbortSignal): Promise<UsageProvider> {
      const nowMs = now();
      const shouldTryAppServer = codexFailures < CODEX_MAX_FAILURES
        || lastCodexAttemptMs === null
        || nowMs - lastCodexAttemptMs >= CODEX_RETRY_AFTER_MS;
      if (shouldTryAppServer) {
        lastCodexAttemptMs = nowMs;
        try {
          const result = await queryCodexAppServerRateLimits("codex", 30_000, proxyEnvironment(), signal);
          const parsed = parseCodexRateLimits(result.rateLimits, {
            status: "ok",
            fetchedAtMs: now(),
            resetCreditsRaw: result.rateLimitResetCredits,
            previousCredits: lastCodexCreditDetails,
          });
          lastCodexCreditDetails = parsed.creditDetails;
          codexFailures = 0;
          return parsed.usage;
        } catch (err) {
          codexFailures++;
          log("warn", "codex app-server usage failed; trying local session rollout", {
            failures: codexFailures,
            reason: err instanceof Error ? err.name : "Error",
          });
        }
      }
      const fallback = readLatestCodexSessionUsage(sessionsRoot());
      if (fallback) return fallback;
      return errorUsage(
        "codex",
        "error",
        "codex_unavailable",
        "Codex app-server is unavailable and no local session rate-limit snapshot was found.",
        now(),
      );
    },
  };

  const kimiRunner: UsageProviderRunner = {
    id: "kimi",
    async fetch(signal?: AbortSignal): Promise<UsageProvider> {
      const nowMs = now();
      const cfg = options.getConfig().kimi;
      const resolved = resolveKimiKey(cfg, options.env);
      if (!resolved.key) {
        return errorUsage(
          "kimi",
          "error",
          "kimi_no_key",
          `Kimi API key is not configured. Add it in Usage Settings or export ${resolved.envName}.`,
          nowMs,
        );
      }
      const prefs = loadPrefs();
      const proxyUrl = cfg?.useProxy === true ? (prefs.proxyUrl ?? prefs.codexProxyUrl ?? null) : null;
      let resp: HttpJsonResponse;
      try {
        resp = await httpGet(KIMI_USAGE_URL, {
          Authorization: `Bearer ${resolved.key}`,
          Accept: "application/json",
        }, { proxyUrl, timeoutMs: 20_000, signal });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.toLowerCase().includes("timeout")) {
          return errorUsage("kimi", "error", "timeout", "Request timed out.", now());
        }
        return errorUsage("kimi", "error", "network_error", "Network request to Kimi failed.", now());
      }
      if (resp.status === 401 || resp.status === 403) {
        return errorUsage("kimi", "auth_expired", "kimi_auth_expired", "Kimi API key is invalid or expired.", now());
      }
      if (resp.status < 200 || resp.status >= 300) {
        return {
          ...errorUsage("kimi", "error", "http_error", `HTTP ${resp.status}`, now()),
          http_status: resp.status,
        };
      }
      try {
        return parseKimiUsagePayload(JSON.parse(resp.body), now());
      } catch {
        log("warn", "kimi usage payload parse failed");
        return errorUsage("kimi", "error", "parse_error", "Failed to parse Kimi usage response.", now());
      }
    },
  };

  return {
    claude: claudeRunner,
    antigravity: antigravityRunner,
    codex: codexRunner,
    kimi: kimiRunner,
  };
}

export function createUsageService(options: {
  configPath: string;
  cachePath: string;
  cwd?: string;
  now?: () => number;
  initialDelayMs?: number;
  intervalMs?: number;
  firstRetryMs?: number;
  maxBackoffMs?: number;
  staleAfterMs?: number;
  onDemandFreshMs?: number;
  runners?: Partial<Record<UsageProviderId, UsageProviderRunner>>;
  liveClaudeUsage?: () => Promise<Rec | null>;
  httpGet?: typeof httpsGetDirectOrProxy;
  codexSessionsRoot?: () => string;
  env?: NodeJS.ProcessEnv;
  onChange?: () => void;
}) {
  const now = options.now ?? Date.now;
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 0);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstRetryMs = options.firstRetryMs ?? DEFAULT_FIRST_RETRY_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const onDemandFreshMs = options.onDemandFreshMs ?? DEFAULT_ON_DEMAND_FRESH_MS;

  let config = loadUsageConfig(options.configPath);
  const defaultRunners = createDefaultUsageRunners({
    cwd: options.cwd,
    getConfig: () => config,
    now,
    liveClaudeUsage: options.liveClaudeUsage,
    httpGet: options.httpGet,
    codexSessionsRoot: options.codexSessionsRoot,
    env: options.env,
  });
  const runners: Record<UsageProviderId, UsageProviderRunner> = {
    ...defaultRunners,
    ...options.runners,
  };

  const cache = new Map<UsageProviderId, UsageProvider>();
  const nextDue = new Map<UsageProviderId, number>();
  const failures = new Map<UsageProviderId, number>();
  const inFlight = new Map<UsageProviderId, Promise<UsageProvider>>();
  const providerGen = new Map<UsageProviderId, number>();
  const instanceId = randomUUID();
  let codexLiveCreditDetails: UsageResetCredit[] | null = null;
  let revision = 1;
  let serviceAbort = new AbortController();
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const bumpProviderGen = (id: UsageProviderId) => {
    providerGen.set(id, (providerGen.get(id) ?? 0) + 1);
    inFlight.delete(id);
  };

  // Load persisted cache on construction.
  try {
    if (existsSync(options.cachePath)) {
      const { parsed } = readPrivateJsonFile(options.cachePath);
      if (parsed) {
        for (const id of USAGE_PROVIDER_ORDER) {
          const item = sanitizeCachedProvider(parsed[id]);
          if (item) cache.set(id, item);
        }
      }
    }
  } catch {
    log("warn", "usage cache corrupted; starting empty");
  }

  for (const id of USAGE_PROVIDER_ORDER) {
    failures.set(id, 0);
    providerGen.set(id, 0);
    if (!runners[id].onDemand) nextDue.set(id, now());
  }

  const isEnabled = (id: UsageProviderId): boolean => config.providers?.[id]?.enabled !== false;

  const persistCache = () => {
    try {
      const payload: Record<string, UsageProvider> = {};
      for (const [id, item] of cache.entries()) payload[id] = item;
      writePrivateJsonFile(options.cachePath, payload, false);
    } catch {
      log("warn", "usage cache could not be persisted");
    }
  };

  const emitChange = () => {
    try {
      options.onChange?.();
    } catch {
      log("warn", "usage onChange callback failed");
    }
  };

  const fetchOne = (id: UsageProviderId): Promise<UsageProvider> => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const runner = runners[id];
    if (stopped || serviceAbort.signal.aborted) {
      return Promise.resolve(cache.get(id) ?? errorUsage(id, "error", "internal_error", "Service stopped", now(), Boolean(runner.onDemand)));
    }
    const startGen = providerGen.get(id) ?? 0;
    const signal = serviceAbort.signal;
    const promise = (async () => {
      let usage: UsageProvider;
      try {
        usage = await runner.fetch(signal);
      } catch {
        log("error", "usage provider threw unexpected error", { provider: id });
        usage = errorUsage(id, "error", "internal_error", "Internal error", now(), Boolean(runner.onDemand));
      }
      if (signal.aborted || (providerGen.get(id) ?? 0) !== startGen) {
        return cache.get(id) ?? usage;
      }
      cache.set(id, usage);
      revision++;
      persistCache();
      emitChange();
      return usage;
    })().finally(() => {
      if (inFlight.get(id) === promise) inFlight.delete(id);
    });
    inFlight.set(id, promise);
    return promise;
  };

  const fetchAndSchedule = async (id: UsageProviderId): Promise<UsageProvider> => {
    const startGen = providerGen.get(id) ?? 0;
    const usage = await fetchOne(id);
    if ((providerGen.get(id) ?? 0) !== startGen) return usage;
    const nowMs = now();
    if (usage.status === "ok") {
      failures.set(id, 0);
      nextDue.set(id, nowMs + intervalMs);
    } else {
      const count = (failures.get(id) ?? 0) + 1;
      failures.set(id, count);
      const delay = Math.min(firstRetryMs * 2 ** (count - 1), maxBackoffMs);
      nextDue.set(id, nowMs + delay);
    }
    return usage;
  };

  const scheduleTick = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    let earliest = Infinity;
    for (const id of USAGE_PROVIDER_ORDER) {
      if (runners[id].onDemand || !isEnabled(id)) continue;
      const due = nextDue.get(id) ?? now();
      if (due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;
    const waitMs = Math.min(2_147_483_647, Math.max(50, earliest - now()));
    timer = setTimeout(() => { void runDue(); }, waitMs);
    timer.unref();
  };

  const runDue = async () => {
    if (!running) return;
    const nowMs = now();
    const dueIds = USAGE_PROVIDER_ORDER.filter(
      (id) => !runners[id].onDemand && isEnabled(id) && nowMs >= (nextDue.get(id) ?? 0),
    );
    if (dueIds.length > 0) {
      await Promise.allSettled(dueIds.map((id) => fetchAndSchedule(id)));
    }
    scheduleTick();
  };

  const summary = (): UsageSummary => {
    const cutoff = now() - staleAfterMs;
    const providers: UsageProvider[] = [];
    let latestMs = -Infinity;
    for (const id of USAGE_PROVIDER_ORDER) {
      if (!isEnabled(id)) continue;
      const item = cache.get(id);
      if (!item) continue;
      const fetchedMs = Date.parse(item.fetched_at);
      if (Number.isFinite(fetchedMs) && fetchedMs > latestMs) latestMs = fetchedMs;
      const stale = item.status === "ok" && Number.isFinite(fetchedMs) && fetchedMs < cutoff;
      const withCredits = id === "claude"
        ? { ...item, reset_credits: activeManualResetCredits(config.claude?.resetCredits, now()) }
        : item;
      providers.push(stale ? { ...withCredits, status: "stale" } : withCredits);
    }
    return {
      instance_id: instanceId,
      revision,
      updated_at: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
      providers,
    };
  };

  const settingsView = (): UsageSettingsView =>
    buildUsageSettingsView(config, options.env, { instanceId, revision });

  return {
    start() {
      if (running) return;
      stopped = false;
      if (serviceAbort.signal.aborted) serviceAbort = new AbortController();
      running = true;
      if (initialDelayMs > 0) {
        timer = setTimeout(() => { void runDue(); }, initialDelayMs);
        timer.unref();
      } else {
        void runDue();
      }
    },
    async stop() {
      stopped = true;
      running = false;
      clearTimeout(timer);
      timer = undefined;
      serviceAbort.abort();
      inFlight.clear();
      await drainActiveChildProbes(500);
    },
    summary,
    settings(): UsageSettingsView {
      return settingsView();
    },
    async updateSettings(patch: unknown): Promise<{ settings: UsageSettingsView; summary: UsageSummary }> {
      const prevConfig = config;
      const next = applyUsageSettingsPatch(config, patch);
      saveUsageConfig(options.configPath, next);
      config = next;
      revision++;

      // Refresh newly-enabled background providers or Kimi if Kimi settings changed.
      const toRefresh: UsageProviderId[] = [];
      for (const id of USAGE_PROVIDER_ORDER) {
        const wasEnabled = prevConfig.providers?.[id]?.enabled !== false;
        const nowEnabled = next.providers?.[id]?.enabled !== false;
        if (!wasEnabled && nowEnabled && !runners[id].onDemand) {
          toRefresh.push(id);
        }
      }
      const kimiChanged = JSON.stringify(prevConfig.kimi ?? {}) !== JSON.stringify(next.kimi ?? {});
      if (kimiChanged) {
        bumpProviderGen("kimi");
        cache.delete("kimi");
        persistCache();
        if (isEnabled("kimi") && !toRefresh.includes("kimi")) {
          toRefresh.push("kimi");
        }
      }
      for (const id of toRefresh) {
        runners[id].resetBackoff?.();
        failures.set(id, 0);
        nextDue.set(id, now() + intervalMs);
        void fetchAndSchedule(id);
      }
      scheduleTick();
      emitChange();
      return { settings: settingsView(), summary: summary() };
    },
    /** Triggered when the user opens the Usage panel: refreshes missing/expired providers (including on-demand Antigravity) asynchronously. */
    notifyPanelOpened() {
      const nowMs = now();
      for (const id of USAGE_PROVIDER_ORDER) {
        if (!isEnabled(id)) continue;
        const cached = cache.get(id);
        const fetchedMs = cached ? Date.parse(cached.fetched_at) : NaN;
        const freshEnough = cached && cached.status === "ok" && Number.isFinite(fetchedMs) && nowMs - fetchedMs < onDemandFreshMs;
        if (freshEnough) continue;
        if (runners[id].onDemand) {
          // Respect cooldown on errors too so rapid panel open/close never loops on a failing CLI.
          if (cached && Number.isFinite(fetchedMs) && nowMs - fetchedMs < DEFAULT_FIRST_RETRY_MS) continue;
          void fetchOne(id);
        } else if (!cached) {
          void fetchAndSchedule(id);
        }
      }
    },
    async refresh(providerParam = "all"): Promise<UsageSummary> {
      let targets: UsageProviderId[];
      if (providerParam === "all") {
        targets = USAGE_PROVIDER_ORDER.filter((id) => isEnabled(id));
      } else {
        if (!USAGE_PROVIDER_ORDER.includes(providerParam as UsageProviderId)) {
          throw new UsageInputError(`Unknown provider: ${providerParam}`);
        }
        const id = providerParam as UsageProviderId;
        targets = isEnabled(id) ? [id] : [];
      }
      await Promise.allSettled(targets.map(async (id) => {
        runners[id].resetBackoff?.();
        failures.set(id, 0);
        if (!runners[id].onDemand) nextDue.set(id, now() + intervalMs);
        await fetchOne(id);
      }));
      scheduleTick();
      return summary();
    },
    /** Real-time push from active AIReins Codex app-server sessions (`account/rateLimits/updated`). */
    ingestCodexRateLimits(params: unknown) {
      if (!isEnabled("codex")) return;
      const p = asRecord(params);
      if (!p) return;
      const rawLimits = asRecord(p.rateLimits) ?? (asRecord(p.primary) || asRecord(p.secondary) ? p : null);
      if (!rawLimits) return;
      try {
        const parsed = parseCodexRateLimits(rawLimits, {
          status: "ok",
          fetchedAtMs: now(),
          resetCreditsRaw: p.rateLimitResetCredits,
          previousCredits: codexLiveCreditDetails,
        });
        codexLiveCreditDetails = parsed.creditDetails;
        // Preserve existing reset_credits if live update notification omitted rateLimitResetCredits.
        if (p.rateLimitResetCredits === undefined) {
          const prev = cache.get("codex");
          if (prev?.reset_credits) parsed.usage.reset_credits = prev.reset_credits;
        }
        bumpProviderGen("codex");
        cache.set("codex", parsed.usage);
        revision++;
        failures.set("codex", 0);
        nextDue.set("codex", now() + intervalMs);
        persistCache();
        emitChange();
      } catch {
        /* ignore malformed live notification */
      }
    },
  };
}
