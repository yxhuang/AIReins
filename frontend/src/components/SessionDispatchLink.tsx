import { useEffect, useState } from "react";
import { fetchParentDispatches } from "../api";
import { store } from "../store";

export function SessionDispatchLink({ nativeId, backgroundCount }: { nativeId?: string; backgroundCount: number }) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    setIds([]);
    if (!nativeId) return;
    const controller = new AbortController();
    let inFlight = false;
    let active = true;
    const poll = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const result = await fetchParentDispatches(nativeId, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (active) setIds(result.dispatches.map((run) => run.runId));
      } catch { /* A read-only link must not interrupt the conversation. */ }
      finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    document.addEventListener("visibilitychange", poll);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [nativeId]);
  if (!backgroundCount && !ids.length) return null;
  return <div className="session-dispatch-link">{backgroundCount > 0 && <span>后台 {backgroundCount} 个任务</span>}
    {ids.length > 0 && <button className="btn" onClick={() => store.navigateDispatches(ids)}>查看派单{ids.length > 1 ? `（${ids.length}）` : ""}</button>}
  </div>;
}
