import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CodexResetEvent, CodexResetStatus, CodexResetTime } from "../../../server/codex-resets";
import { formatDate, formatRelativeTime, t } from "../i18n";
import { store } from "../store";
import { useStore } from "../useStore";
import { modalKeyDown } from "./useAnchoredMenu";

const sourceUrl = "https://aihot.news/codex-reset";
const typeLabel = (event?: CodexResetEvent) => t(event?.type === "reset_credit" ? "ui.CodexResets.credit" : "ui.CodexResets.reset");
const eventUrl = (event: CodexResetEvent) => event.posts.find(post => post.url)?.url ?? event.url;

function relative(value: string | undefined, now: number): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return t("ui.CodexResets.time_unknown");
  const minutes = Math.round((timestamp - now) / 60_000);
  if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, "minute");
  if (Math.abs(minutes) < 1440) return formatRelativeTime(Math.round(minutes / 60), "hour");
  return formatRelativeTime(Math.round(minutes / 1440), "day");
}

function ResetTime({ event, now }: { event: CodexResetEvent; now: number }) {
  const timing: CodexResetTime | null = event.schedule?.label ? event.schedule : event.estimate ?? event.schedule;
  if (!timing) return null;
  const estimate = timing === event.estimate;
  const from = Date.parse(timing.from ?? ""), through = Date.parse(timing.through ?? "");
  const deadline = from > now ? from : Number.isFinite(through) ? through : from;
  const label = timing.label ?? (Number.isFinite(deadline) ? formatDate(deadline) : t("ui.CodexResets.time_unknown"));
  const minutes = Math.ceil((deadline - now) / 60_000);
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  const countdown = Number.isFinite(minutes) && minutes > 0
    ? hours ? t("ui.CodexResets.countdown_hours", { hours, minutes: remainder }) : t("ui.CodexResets.countdown_minutes", { minutes })
    : Number.isFinite(deadline) && event.status === "announced" ? t("ui.CodexResets.awaiting_confirmation") : null;
  return <div className="codex-reset-time">
    <span>{estimate ? t("ui.CodexResets.estimate") : t("ui.CodexResets.scheduled")}</span>
    <strong>{label}</strong>
    {event.status === "announced" && countdown && <span>{countdown}</span>}
  </div>;
}

// 本机失败优先；AIHOT 自身状态非 healthy 时说明是来源的问题；剩下的是 outage。
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

function Source() {
  return <a className="codex-reset-source" href={sourceUrl} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.source")}</a>;
}

/** 全局公告；关闭仅收起本端，只有「知道了」才写共享 ack。 */
export function CodexResetDialog() {
  const state = useStore(value => value.codexResets);
  const now = useStore(value => value.now);
  const hasUsage = useStore(value => value.pages.some(page => page.id === "ai-usage"));
  const [hidden, setHidden] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const ack = useRef<HTMLButtonElement>(null);
  const alert = state?.enabled ? state.alerts[0] : undefined;
  const visibleId = alert && alert.id !== hidden ? alert.id : null;
  useEffect(() => {
    setError("");
    if (!visibleId) return;
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>(".app");
    const wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    ack.current?.focus();
    return () => {
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, [visibleId]);
  if (!alert || !visibleId) return null;
  const acknowledge = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try { await store.ackCodexReset(alert.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  };
  const close = () => setHidden(alert.id);
  return createPortal(<div className="dir-overlay codex-reset-overlay" onKeyDown={event => modalKeyDown(event, dialog.current, close)}>
    <div ref={dialog} className="dir-dialog codex-reset-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="codex-reset-title">
      <div className="codex-reset-heading">
        <span className={`codex-reset-stage${alert.action === "confirm" ? " confirmed" : ""}`}>{t(alert.action === "confirm" ? "ui.CodexResets.confirmed" : "ui.CodexResets.announced")}</span>
        <span>{[...new Set(alert.events.map(typeLabel))].join(" · ") || typeLabel()}</span>
        {state && state.alerts.length > 1 && <span className="codex-reset-more">{t("ui.CodexResets.more", { count: state.alerts.length - 1 })}</span>}
      </div>
      <h2 id="codex-reset-title">{alert.events.map(event => event.title || typeLabel(event)).join(" / ") || t("ui.CodexResets.title")}</h2>
      {alert.events.map(event => <div key={event.id}>
        <ResetTime event={event} now={now} />
        {event.presentation?.scopeLabel && <p className="codex-reset-scope">{t("ui.CodexResets.applies_to", { scope: event.presentation.scopeLabel })}</p>}
      </div>)}
      {alert.text && <p className="codex-reset-body">{alert.text}</p>}
      {alert.text && alert.context.filter(context => context.text).map((context, index) => <blockquote key={context.id ?? index}>
        <p>{context.text}</p>
        {context.url && <a href={context.url} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.context")}</a>}
      </blockquote>)}
      {alert.text && alert.originalText && <details className="codex-reset-original" key={alert.id}>
        <summary>{t("ui.CodexResets.original")}</summary>
        <p>{alert.originalText}</p>
        {alert.context.filter(context => context.originalText).map((context, index) => <blockquote key={context.id ?? index}>{context.originalText}</blockquote>)}
      </details>}
      {state?.stale && <p className="codex-reset-stale">{staleText(state, now)}</p>}
      {error && <p className="new-error" role="alert">{error}</p>}
      <div className="codex-reset-actions">
        {alert.url && <a className="btn" href={alert.url} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.post")}</a>}
        {hasUsage && <button type="button" className="btn codex-reset-open-usage" onClick={() => { store.navigatePage("ai-usage"); close(); }}>{t("ui.CodexResets.open_usage")}</button>}
        <button ref={ack} type="button" className="btn btn-primary codex-reset-ack" disabled={saving} onClick={() => void acknowledge()}>{t(saving ? "ui.common.saving" : "ui.CodexResets.ack")}</button>
      </div>
      <div className="codex-reset-footer"><Source /><span>{t("ui.CodexResets.synced")}</span></div>
    </div>
  </div>, document.body);
}

export function CodexResetCard() {
  const state = useStore(value => value.codexResets);
  const now = useStore(value => value.now);
  if (!state?.enabled) return null;
  // 只显示一条：待生效取预计时间最晚的那次（较早的多半已被它取代），其余在「最近事件」里。
  const expected = (event: CodexResetEvent) => Date.parse((event.schedule ?? event.estimate)?.from ?? "") || 0;
  const latest = state.pending.reduce<CodexResetEvent | undefined>((best, event) => !best || expected(event) > expected(best) ? event : best, undefined);
  const events = latest ? [latest] : state.recent.slice(0, 1);
  return <section className={`codex-reset-card${state.pending.length ? " has-pending" : ""}`} aria-label={t("ui.CodexResets.title")}>
    {events.length ? events.map(event => {
      const when = relative(event.confirmedAt ?? event.updatedAt ?? event.createdAt ?? event.posts[0]?.publishedAt, now);
      return <div className="codex-reset-card-event" key={event.id}>
        {state.pending.length ? <>
          <div className="codex-reset-card-heading">
            <strong>{t("ui.CodexResets.upcoming", { type: typeLabel(event) })}</strong>
            {eventUrl(event) && <a href={eventUrl(event)} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.post")}</a>}
          </div>
          <ResetTime event={event} now={now} />
        </> : <div className="codex-reset-card-heading">
          <strong>{t("ui.CodexResets.latest", { type: t(event.type === "reset_credit" ? "ui.CodexResets.credit" : "ui.CodexResets.reset_short") })}</strong>
          {eventUrl(event) ? <a className="codex-reset-relative" href={eventUrl(event)} target="_blank" rel="noopener noreferrer" title={t("ui.CodexResets.post")}>{when}</a> : <span className="codex-reset-relative">{when}</span>}
        </div>}
      </div>;
    }) : <p>{t(state.lastSuccessAt ? "ui.CodexResets.empty" : "ui.CodexResets.waiting")}</p>}
    {state.stale && <p className="codex-reset-stale">{staleText(state, now)}</p>}
    <div className="codex-reset-card-foot">
    <details className="codex-reset-history">
      <summary>{t("ui.CodexResets.history")}</summary>
      <ol>{state.recent.map(event => <li key={event.id}>
        <span>{typeLabel(event)} · {t(event.status === "confirmed" ? "ui.CodexResets.confirmed" : "ui.CodexResets.announced")}</span>
        <p>{event.title}</p>
        <ResetTime event={event} now={now} />
        {eventUrl(event) && <a href={eventUrl(event)} target="_blank" rel="noopener noreferrer">{t("ui.CodexResets.post")}</a>}
      </li>)}</ol>
    </details>
    <Source />
    </div>
  </section>;
}
