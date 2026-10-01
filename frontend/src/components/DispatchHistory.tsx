import { useEffect, useState } from "react";
import { fetchDispatchHistory } from "../api";
import { dispatchName, dispatchTime, type DispatchRun } from "../dispatch-flow";
import { store } from "../store";

export function DispatchHistory() {
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
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
  }, [page]);
  return <section className="dispatch-history" aria-label="近 7 天历史派单">
    <div className="dispatch-section-head"><h2>近 7 天历史</h2><span>{total} 单已结束</span></div>
    {error && <p className="dispatch-error" role="alert">历史加载失败：{error}</p>}
    {!loaded ? <p className="dispatch-note">正在加载…</p> : !runs.length ? <p className="dispatch-note">近 7 天没有已结束派单</p> : <div className="dispatch-history-list">{runs.map((run) => <button className="dispatch-history-row" key={run.runId} onClick={() => store.navigateDispatches([run.runId])}>
      <span className="dispatch-history-name">{dispatchName(run)}<span className="dispatch-note">{run.tool} · {run.model || "模型未知"}</span></span>
      <span className={`dispatch-badge ${run.status === "OK" ? "" : "failed"}`}>{run.status}</span>
      <span className="mono">{dispatchTime(run.elapsedS)}</span>
      <time>{new Date(run.endedAt || (Date.parse(run.startedAt || "") + (run.elapsedS || 0) * 1000)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
      <span aria-hidden="true">›</span>
    </button>)}</div>}
    {next !== null && <button className="btn dispatch-history-more" disabled={busy} onClick={() => setPage((value) => value + 1)}>{busy ? "加载中…" : "加载更多"}</button>}
  </section>;
}
