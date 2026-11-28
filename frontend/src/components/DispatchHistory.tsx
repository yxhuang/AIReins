import { t, getLocale } from "../i18n";
import { useEffect, useState } from "react";
import { fetchDispatchHistory } from "../api";
import { dispatcherLabel, dispatchModelName, dispatchName, dispatchStatus, dispatchTime, type DispatchRun } from "../dispatch-flow";
import { store } from "../store";
import { AgentIcon } from "./AgentIcon";

export function DispatchToolIcon({ tool }: { tool: string }) {
  if (tool === "copilot") {
    return <svg className="agent-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3h8l2 4h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2l-2 3H8l-2-3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2z" /><rect x="5" y="8" width="6" height="6" rx="2" /><rect x="13" y="8" width="6" height="6" rx="2" /></svg>;
  }
  if (tool === "muse") {
    return <svg className="agent-icon agent-muse" viewBox="0 0 24 24" role="img" aria-label={dispatcherLabel(tool)} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <title>{dispatcherLabel(tool)}</title><path d="M4 18V7l8 8 8-8v11" />
    </svg>;
  }
  if (tool === "codex" || tool === "kimi" || tool === "claude" || tool === "antigravity" || tool === "grok-bot") {
    return <AgentIcon agent={tool} label={dispatcherLabel(tool)} />;
  }
  return null;
}

export function DispatchHistoryRow({ run }: { run: DispatchRun }) {
  const status = dispatchStatus(run.status);
  return <button type="button" className="dispatch-history-row" data-tool={run.tool} data-status={status.className}
    onClick={() => store.navigateDispatches([run.runId])}>
    <span className="dispatch-history-task"><DispatchToolIcon tool={run.tool} />
      <span className="dispatch-history-name">{dispatchName(run)}
        <span className="dispatch-history-model" title={run.model ?? undefined}>{run.model ? dispatchModelName(run.model) : t("ui.common.model_unknown")}</span>
      </span>
    </span>
    <span className={`dispatch-badge ${status.className}`}>{run.status === "DISPATCHED" ? status.label : run.status}</span>
    <span className="mono">{dispatchTime(run.elapsedS)}</span>
    <time>{new Date(run.endedAt || (Date.parse(run.startedAt || "") + (run.elapsedS || 0) * 1000)).toLocaleString(getLocale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
    <span aria-hidden="true">›</span>
  </button>;
}

export function DispatchHistory() {
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  // 平时折叠（用户 10-01 定）：主视图看委派关系，历史展开时才加载和轮询。
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let inFlight = false;
    let active = true;
    const load = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setBusy(true);
      try {
        // Refresh all loaded pages together so arrivals do not shift pagination into duplicates/gaps.
        const pages = await Promise.all(Array.from({ length: page + 1 }, (_, index) => fetchDispatchHistory(index * 20, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))));
        if (!active) return;
        setRuns([...new Map(pages.flatMap((result) => result.dispatches).map((run) => [run.runId, run])).values()]);
        setTotal(pages[0]!.total);
        setNext(pages.at(-1)!.nextOffset);
        setLoaded(true);
        setError("");
      } catch (cause) { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { inFlight = false; if (active) setBusy(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    document.addEventListener("visibilitychange", load);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [page, open]);
  return <details className="dispatch-history" aria-label={t("ui.DispatchHistory.dispatch_history_from_the_last_7_days")} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="dispatch-section-head"><h2>{t("ui.DispatchHistory.last_7_days")}</h2><span>{loaded ? t("ui.DispatchHistory.dispatches_ended", { p0: (total) }) : t("ui.DispatchHistory.expand_to_view")}</span></summary>
    {error && <p className="dispatch-error" role="alert">{t("ui.DispatchHistory.failed_to_load_history_sentence", { p0: (error) })}</p>}
    {!loaded ? <p className="dispatch-note">{t("ui.common.loading")}</p> : !runs.length ? <p className="dispatch-note">{t("ui.DispatchHistory.no_dispatches_ended_in_the_last_7")}</p> : <div className="dispatch-history-list">{runs.map(run => <DispatchHistoryRow key={run.runId} run={run} />)}</div>}
    {next !== null && <button className="btn dispatch-history-more" disabled={busy} onClick={() => setPage((value) => value + 1)}>{busy ? t("ui.common.loading_2") : t("ui.common.load_more")}</button>}
  </details>;
}
