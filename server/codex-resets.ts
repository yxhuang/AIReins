import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

const ENDPOINT = "https://aihot.news/api/v1/codex-resets/recent";
const SOURCE = "https://aihot.news/codex-reset";
const INTERVAL = 10 * 60_000;
const HOUR = 60 * 60_000;
const MAX_IDS = 2000;
const MAX_ALERTS = 100;

export interface CodexResetContext {
  id?: string;
  author?: string;
  text?: string;
  originalText?: string;
  url?: string;
  relation?: string;
}
export interface CodexResetPost extends CodexResetContext {
  id: string;
  publishedAt?: string;
  stage?: string;
  context: CodexResetContext[];
}
export interface CodexResetTime {
  precision?: string;
  from?: string;
  through?: string;
  label?: string;
  basis?: string;
  reason?: string;
}
export interface CodexResetEvent {
  id: string;
  type: "direct_reset" | "reset_credit";
  status?: string;
  title?: string;
  presentation: { status?: string; scopeLabel?: string; audienceZh?: string; productsZh?: string } | null;
  schedule: CodexResetTime | null;
  estimate: CodexResetTime | null;
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
  url?: string;
  posts: CodexResetPost[];
}
export interface CodexResetActivity extends CodexResetPost {
  kind?: string;
  action?: string;
  eventIds: string[];
}
export interface CodexResetAlert extends CodexResetActivity {
  action: "announce" | "confirm";
  events: CodexResetEvent[];
}
export type CodexResetMonitor = { status?: string; lastAttemptAt?: string; lastCollectedAt?: string; lastVerifiedAt?: string };
export interface CodexResetStatus {
  enabled: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  monitor: CodexResetMonitor | null;
  pending: CodexResetEvent[];
  recent: CodexResetEvent[];
  alerts: CodexResetAlert[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value.slice(0, 20_000) : undefined;
const id = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const url = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try { const parsed = new URL(value); return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : undefined; } catch { return undefined; }
};
const chinese = (...values: unknown[]): string | undefined => values.map(str).find((text) => text && /\p{Script=Han}/u.test(text));
function context(value: unknown): CodexResetContext {
  const v = record(value);
  return { id: id(v.id), author: str(v.author), text: chinese(v.text, v.fullText), originalText: str(v.originalText) ?? str(v.fullOriginalText), url: url(v.url), relation: str(v.relation) };
}
function post(value: unknown): CodexResetPost | undefined {
  const v = record(value), key = id(v.id);
  if (!key) return undefined;
  return { ...context(v), text: chinese(v.text), id: key, publishedAt: str(v.publishedAt), stage: str(v.stage), context: list(v.context).slice(0, 10).map(context) };
}
function time(value: unknown): CodexResetTime | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = record(value);
  return { precision: str(v.precision), from: str(v.from), through: str(v.through), label: str(v.label), basis: str(v.basis), reason: str(v.reason) };
}
function event(value: unknown): CodexResetEvent | undefined {
  const v = record(value), key = id(v.id), p = record(v.presentation);
  if (!key || (v.type !== "direct_reset" && v.type !== "reset_credit")) return undefined;
  return {
    id: key, type: v.type, status: str(v.status), title: str(v.title),
    presentation: v.presentation ? { status: str(p.status), scopeLabel: str(p.scopeLabel), audienceZh: str(p.audienceZh), productsZh: str(p.productsZh) } : null,
    schedule: time(v.schedule), estimate: time(v.estimate), createdAt: str(v.createdAt), updatedAt: str(v.updatedAt), confirmedAt: str(v.confirmedAt), url: url(v.url),
    posts: list(v.posts).slice(0, 30).map(post).filter((p): p is CodexResetPost => !!p),
  };
}
function activity(value: unknown): CodexResetActivity | undefined {
  const v = record(value), p = post(v);
  return p ? { ...p, text: chinese(v.text, v.fullText), kind: str(v.kind), action: str(v.action), eventIds: list(v.eventIds).map(id).filter((s): s is string => !!s).slice(0, 20) } : undefined;
}
function monitor(value: unknown): CodexResetMonitor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = record(value);
  return { status: str(v.status), lastAttemptAt: str(v.lastAttemptAt), lastCollectedAt: str(v.lastCollectedAt), lastVerifiedAt: str(v.lastVerifiedAt) };
}
const recentFirst = <T>(items: T[], stamp: (item: T) => string | undefined): T[] => items.sort((a, b) => (Date.parse(stamp(b) ?? "") || 0) - (Date.parse(stamp(a) ?? "") || 0));
function alert(a: CodexResetActivity, events: CodexResetEvent[]): CodexResetAlert | undefined {
  if (a.kind !== "event_update" || (a.action !== "announce" && a.action !== "confirm")) return undefined;
  const associated = events.filter((e) => a.eventIds.includes(e.id));
  const matching = associated.flatMap((e) => e.posts).filter((p) => p.id === a.id);
  const best = matching.find((p) => p.text) ?? matching[0];
  return { ...a, action: a.action, text: chinese(...matching.map((p) => p.text), a.text), originalText: best?.originalText ?? a.originalText,
    context: best?.context.length ? best.context : a.context, url: best?.url ?? a.url, events: associated };
}
function notification(a: CodexResetAlert): string {
  const credit = a.events.some((e) => e.type === "reset_credit");
  const stage = a.action === "announce" ? `预告${credit ? "重置卡" : "额度重置"}` : credit ? "重置卡已发放" : "已确认重置";
  const timing = a.events.map((e) => e.schedule?.label ?? (e.estimate?.label ? `${e.estimate.label}（推算）` : undefined)).filter(Boolean).join("；");
  const body = a.text ?? a.events.map((e) => e.title).filter(Boolean).join("；");
  return `[AIReins] Tibo ${stage}${timing ? `：${timing}` : ""}${body ? `。「${body}」` : ""}${a.url ? ` ${a.url}` : ""}\n数据来源 AIHOT ${SOURCE}`;
}

/** 构造只读本地快照；start 后才轮询，测试必须显式注入 fetch 和隔离路径。 */
export function createCodexResetWatch({ path, enabled = false, fetch: request = globalThis.fetch, now = Date.now, onChange = () => {}, send,
  warn = (message: string) => log("warn", message),
}: {
  path: string;
  enabled?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onChange?: () => void;
  send?: (text: string) => Promise<unknown>;
  warn?: (message: string) => void;
}) {
  let baseline = false, seen: string[] = [], acked: string[] = [], etag: string | undefined;
  let events: CodexResetEvent[] = [], activities: CodexResetActivity[] = [], alerts: CodexResetAlert[] = [];
  let lastSuccessAt: string | null = null, sourceMonitor: CodexResetMonitor | null = null, outage = false;
  let failureSince: number | undefined, failures = 0, nextAt = 0;
  let running = false, generation = 0, timer: NodeJS.Timeout | undefined, controller: AbortController | undefined;
  let inFlight: Promise<CodexResetStatus> | undefined;
  try {
    const v = record(JSON.parse(readFileSync(path, "utf8")));
    if (v.version === 1) {
      baseline = v.baseline === true;
      seen = list(v.seen).map(id).filter((s): s is string => !!s).slice(-MAX_IDS);
      acked = list(v.acked).map(id).filter((s): s is string => !!s).slice(-MAX_IDS);
      etag = str(v.etag);
      lastSuccessAt = typeof v.lastSuccessAt === "string" && Number.isFinite(Date.parse(v.lastSuccessAt)) ? v.lastSuccessAt : null;
      events = list(v.events).slice(0, 100).map(event).filter((e): e is CodexResetEvent => !!e);
      activities = list(v.activities).slice(0, 1000).map(activity).filter((a): a is CodexResetActivity => !!a);
      alerts = list(v.alerts).slice(0, MAX_ALERTS).flatMap((raw) => {
        const a = activity(raw), associated = list(record(raw).events).slice(0, 20).map(event).filter((e): e is CodexResetEvent => !!e);
        const restored = a && alert(a, associated);
        return restored && !acked.includes(restored.id) ? [restored] : [];
      });
      sourceMonitor = monitor(v.monitor); outage = v.outage === true;
      failureSince = typeof v.failureSince === "number" && Number.isFinite(v.failureSince) ? v.failureSince : undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn("codex resets state could not be loaded");
  }
  const persist = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify({ version: 1, baseline, seen, acked, etag, lastSuccessAt, events, activities, alerts, monitor: sourceMonitor, outage, failureSince })}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return true;
    } catch { warn("codex resets state could not be saved"); return false; }
  };
  const status = (): CodexResetStatus => ({
    enabled, lastSuccessAt, stale: sourceMonitor?.status !== "healthy" || outage || (failureSince !== undefined && now() - failureSince > HOUR),
    monitor: sourceMonitor,
    pending: enabled ? events.filter((e) => e.status === "announced") : [],
    recent: events.slice(0, 5), alerts: enabled ? alerts.filter((a) => !acked.includes(a.id)) : [],
  });
  const changed = () => { try { onChange(); } catch { warn("codex resets change callback failed"); } };
  const schedule = () => {
    clearTimeout(timer); timer = undefined;
    if (running && enabled) {
      timer = setTimeout(() => { void poll(); }, Math.min(2_147_483_647, Math.max(0, nextAt - now())));
      timer.unref();
    }
  };
  const fail = (message: string, retryAfter?: string | null) => {
    warn(message); failureSince ??= now(); failures++;
    const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : NaN;
    const retry = Number.isFinite(seconds) ? seconds : retryAfter ? Date.parse(retryAfter) - now() : NaN;
    nextAt = now() + (Number.isFinite(retry) && retry > 0 ? Math.max(INTERVAL, retry) : Math.min(HOUR, INTERVAL * 2 ** Math.min(failures - 1, 3)));
    persist(); changed();
  };
  async function poll(): Promise<CodexResetStatus> {
    if (!enabled) return status();
    if (now() < nextAt) { schedule(); return status(); }
    if (inFlight) return inFlight;
    const requestGeneration = generation;
    controller = new AbortController();
    const abort = controller;
    const timeout = setTimeout(() => abort.abort(), 15_000);
    timeout.unref();
    inFlight = Promise.resolve().then(async () => {
      try {
        if (!enabled || requestGeneration !== generation) return status();
        const response = await request(ENDPOINT, { headers: baseline && etag ? { "If-None-Match": etag } : {}, signal: abort.signal });
        if (!enabled || requestGeneration !== generation) { await response.body?.cancel(); return status(); }
        if (response.status === 304 && baseline) {
          lastSuccessAt = new Date(now()).toISOString(); failureSince = undefined; failures = 0; nextAt = now() + INTERVAL;
          persist(); changed(); return status();
        }
        if (!response.ok) {
          await response.body?.cancel();
          fail(`codex resets request failed (HTTP ${response.status})`, response.status === 429 || response.status >= 500 ? response.headers.get("retry-after") : undefined);
          return status();
        }
        const value = record(await response.json());
        if (!enabled || requestGeneration !== generation) return status();
        if (value.schemaVersion !== 1) { fail("codex resets unsupported schemaVersion; skipped response"); return status(); }
        const freshEvents = recentFirst(list(value.events).slice(0, 100).map(event).filter((e): e is CodexResetEvent => !!e), (e) => e.updatedAt ?? e.confirmedAt ?? e.createdAt);
        const freshActivities = recentFirst(list(value.activities).slice(0, 1000).map(activity).filter((a): a is CodexResetActivity => !!a), (a) => a.publishedAt);
        const cutoff = now() - 24 * HOUR;
        const newAlerts = baseline ? freshActivities.filter((a) => !seen.includes(a.id) && Date.parse(a.publishedAt ?? "") >= cutoff).flatMap((a) => {
          const item = alert(a, freshEvents);
          if (!item || acked.includes(item.id)) return [];
          if (item.action === "announce" && a.eventIds.length > 0
            && a.eventIds.every((key) => freshEvents.some((e) => e.id === key && e.status === "confirmed"))) return [];
          return [item];
        }) : [];
        // 一条帖子即使被重复列出、关联多个事件，也只提醒一次。
        const unique = new Map(newAlerts.map((a) => [a.id, a]));
        events = freshEvents; activities = freshActivities; baseline = true;
        seen = [...new Set([...seen, ...freshActivities.map((a) => a.id)])].slice(-MAX_IDS);
        alerts = recentFirst([...unique.values(), ...alerts.filter((a) => !unique.has(a.id))], (a) => a.publishedAt).slice(0, MAX_ALERTS);
        const retainedIds = new Set([...seen, ...alerts.map((a) => a.id)]);
        acked = acked.filter((key) => retainedIds.has(key)).slice(-MAX_IDS);
        sourceMonitor = monitor(value.monitor); outage = value.outage !== null && value.outage !== undefined;
        etag = response.headers.get("etag") ?? undefined; lastSuccessAt = new Date(now()).toISOString();
        failureSince = undefined; failures = 0; nextAt = now() + INTERVAL;
        persist(); changed();
        for (const item of unique.values()) {
          if (!enabled || requestGeneration !== generation) break;
          try { await send?.(notification(item)); } catch { warn("codex resets notification failed"); }
        }
      } catch {
        if (enabled && requestGeneration === generation) fail("codex resets request or JSON parsing failed");
      } finally {
        clearTimeout(timeout); controller = undefined; inFlight = undefined; schedule();
      }
      return status();
    });
    return inFlight;
  }
  return {
    status,
    poll,
    ack(key: string): CodexResetStatus {
      if (!alerts.some((a) => a.id === key) || acked.includes(key)) return status();
      const previousAcked = acked, previousAlerts = alerts;
      acked = [...acked, key].slice(-MAX_IDS); alerts = alerts.filter((a) => a.id !== key);
      if (!persist()) { acked = previousAcked; alerts = previousAlerts; throw new Error("重置提醒确认未能保存，请重试"); }
      changed(); return status();
    },
    start() { if (running) return; running = true; if (enabled) void poll(); },
    stop() { running = false; generation++; clearTimeout(timer); timer = undefined; controller?.abort(); },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value; generation++; clearTimeout(timer); timer = undefined; controller?.abort();
      nextAt = 0; changed();
      if (enabled && running) { if (inFlight) void inFlight.then(() => { if (enabled && running) void poll(); }); else void poll(); }
    },
  };
}
