import { useId, useMemo, useState } from "react";
import type { CodexResetEvent, CodexResetStatus, QuotaResetStatus } from "../../../server/codex-resets";
import { quotaResetFeeds, quotaResetSource, type QuotaResetProvider } from "../../../shared/quota-reset-feeds";
import { formatDate, formatRelativeTime, t } from "../i18n";
import { store } from "../store";
import { useStore } from "../useStore";
import { AgentIcon } from "./AgentIcon";
import { Segmented } from "./Segmented";

const typeLabel = (event?: CodexResetEvent) => t(event?.type === "reset_credit" ? "ui.CodexResets.credit" : "ui.CodexResets.reset");
const eventUrl = (event?: CodexResetEvent) => event?.posts.find(post => post.url)?.url ?? event?.url;
const eventDate = (event?: CodexResetEvent) => event?.confirmedAt ?? event?.updatedAt ?? event?.createdAt ?? event?.posts[0]?.publishedAt;
const resetTiming = (event: CodexResetEvent) => event.schedule?.label ? event.schedule : event.estimate ?? event.schedule;

function upcomingReset(event: CodexResetEvent, now: number): boolean {
  if (event.status !== "announced") return false;
  const timing = resetTiming(event);
  const through = Date.parse(timing?.through ?? "");
  const deadline = Number.isFinite(through) ? through : Date.parse(timing?.from ?? "");
  return !Number.isFinite(deadline) || deadline > now;
}

function resetSources(state: QuotaResetStatus | null) {
  return state?.enabled ? [{ provider: "codex" as const, status: state }, ...(state.sources ?? [])] : [];
}

export function hasResetUpdate(state: QuotaResetStatus | null, now: number): boolean {
  return resetSources(state).some(({ status }) => status.alerts.length || status.pending.some(event => upcomingReset(event, now)));
}

function relative(value: string | undefined, now: number): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return t("ui.CodexResets.time_unknown");
  const minutes = Math.round((timestamp - now) / 60_000);
  if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, "minute");
  if (Math.abs(minutes) < 1440) return formatRelativeTime(Math.round(minutes / 60), "hour");
  return formatRelativeTime(Math.round(minutes / 1440), "day");
}

function resetTime(event: CodexResetEvent, now: number): string {
  if (event.status !== "announced") return relative(eventDate(event), now);
  if (!upcomingReset(event, now)) return "";
  const timing = resetTiming(event);
  const time = [timing?.from, timing?.through].find(value => value && Number.isFinite(Date.parse(value)));
  const label = timing?.label ?? (time ? formatDate(time) : t("ui.CodexResets.time_unknown"));
  return timing && timing === event.estimate ? t("ui.CodexResets.estimated_time", { time: label }) : label;
}

export function staleText(state: CodexResetStatus, now: number): string {
  const success = Date.parse(state.lastSuccessAt ?? "");
  if (!Number.isFinite(success) || now - success > 60 * 60_000) return t("ui.CodexResets.stale_local");
  const monitor = state.monitor;
  if (monitor?.status !== "healthy" && monitor?.lastVerifiedAt) {
    const status = t(monitor.status === "attention" ? "ui.CodexResets.monitor_attention" : monitor.status === "delayed" ? "ui.CodexResets.monitor_delayed" : "ui.CodexResets.monitor_unknown");
    return t("ui.CodexResets.stale_source", { status, time: relative(monitor.lastVerifiedAt, now) });
  }
  return t("ui.CodexResets.stale");
}

export function CodexResetCard() {
  const snapshot = useStore(value => value.codexResets);
  const now = useStore(value => value.now);
  const detailsId = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [selection, setSelection] = useState<{ provider: QuotaResetProvider; eventKey: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const providerOptions = useMemo(() => resetSources(snapshot).map(({ provider }) => {
    const label = quotaResetFeeds[provider];
    return { value: provider, label, icon: <AgentIcon agent={provider} label={label} /> };
  }), [snapshot]);

  const scheduledAt = (event: CodexResetEvent) => Date.parse(resetTiming(event)?.from ?? "") || 0;
  const sources = resetSources(snapshot).map(source => ({
    ...source,
    alert: source.status.alerts[0],
    pending: source.status.pending.filter(event => upcomingReset(event, now)).sort((a, b) => scheduledAt(b) - scheduledAt(a))[0],
    confirmed: source.status.recent.find(event => event.status === "confirmed"),
  }));
  const active = sources.filter(source => source.alert)
    .sort((a, b) => (Date.parse(b.alert?.publishedAt ?? "") || 0) - (Date.parse(a.alert?.publishedAt ?? "") || 0))[0]
    ?? sources.find(source => source.pending);
  const eventKey = active ? `${active.provider}:${active.alert ? "post:" + active.alert.id : "event:" + active.pending?.id}` : null;
  const confirmedAt = (source: (typeof sources)[number]) => Date.parse(eventDate(source.confirmed) ?? "") || 0;
  const feed = (selection?.eventKey === eventKey && sources.find(source => source.provider === selection.provider))
    || active
    || sources.reduce<(typeof sources)[number] | undefined>((best, source) => !best || confirmedAt(source) > confirmedAt(best) ? source : best, undefined);
  if (!feed) return null;

  const { provider, status, alert } = feed;
  const open = manualOpen || (eventKey !== null && eventKey !== dismissed);
  const summary = open ? (feed.alert || feed.pending ? feed : undefined) : active;
  const event = alert?.events[0] ?? feed.pending ?? feed.confirmed;
  const timestamp = event ? resetTime(event, now) : alert ? relative(alert.publishedAt, now) : "";
  const url = alert?.url ?? eventUrl(event);
  const stage = (action?: string) => t(action === "confirm" ? "ui.CodexResets.confirmed" : "ui.CodexResets.announced");
  const acknowledge = async () => {
    if (!alert || saving) return;
    setSaving(true);
    setError("");
    try { await store.ackCodexReset(alert.id, provider === "codex" ? undefined : provider); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  return <section className="codex-reset-card" aria-label={t("ui.CodexResets.title")}>
    <div className="codex-reset-header">
      <button type="button" className="codex-reset-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => {
        setManualOpen(!open);
        if (open) setDismissed(eventKey);
      }}>
        <span>{t("ui.CodexResets.events")}</span>
        {summary && <span className="codex-reset-summary">{!open && providerOptions.length === 1 && `${quotaResetFeeds[summary.provider]} · `}{stage(summary.alert?.action)}</span>}
        <span className="codex-reset-chevron" aria-hidden="true" />
      </button>
      {providerOptions.length > 1 && <Segmented className="codex-reset-rail" role="radiogroup"
        ariaLabel={t("ui.CodexResets.provider")} options={providerOptions} value={open ? provider : active?.provider ?? null} onChange={next => {
          setSelection({ provider: next, eventKey });
          if (!open) setManualOpen(true);
          setError("");
        }} />}
    </div>
    <div id={detailsId} className="codex-reset-details" hidden={!open}>
      <div className="codex-reset-line">
        <span className="codex-reset-event">
          {alert || event ? <>{typeLabel(event)}{timestamp && <> · {timestamp}</>}</>
            : t(status.lastSuccessAt ? "ui.CodexResets.empty" : "ui.CodexResets.waiting")}
        </span>
        <div className="codex-reset-links">
          {url && <a href={url} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.post")}</a>}
          <a href={quotaResetSource(provider)} aria-label={t("ui.CodexResets.source")} target="_blank" rel="noopener noreferrer">AIHOT</a>
          {alert && <button type="button" className="btn codex-reset-ack" disabled={saving} onClick={() => void acknowledge()}>{t(saving ? "ui.common.saving" : "ui.CodexResets.ack")}</button>}
        </div>
      </div>
      {status.stale && status.lastSuccessAt && <p className="codex-reset-stale">{staleText(status, now)}</p>}
      {error && <p className="new-error" role="alert">{error}</p>}
      {!alert && status.recent.length > 1 && <details className="codex-reset-history" key={provider}>
        <summary>{t("ui.CodexResets.history")}</summary>
        <ul>{status.recent.map(item => <li key={item.id}>
          {eventUrl(item) ? <a href={eventUrl(item)} target="_blank" rel="noopener noreferrer">{item.title || typeLabel(item)}</a> : item.title || typeLabel(item)}
        </li>)}</ul>
      </details>}
    </div>
  </section>;
}
