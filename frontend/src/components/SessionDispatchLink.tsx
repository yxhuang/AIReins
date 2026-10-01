import { useEffect, useRef, useState } from "react";
import { fetchParentDispatches } from "../api";
import { store } from "../store";
import { startSessionDispatchPolling } from "../dispatch-polling";

export function SessionDispatchLink({ nativeId, backgroundCount }: { nativeId?: string; backgroundCount: number }) {
  const [ids, setIds] = useState<string[]>([]);
  const linkCount = useRef(0);
  useEffect(() => { setIds([]); linkCount.current = 0; }, [nativeId]);
  useEffect(() => {
    if (!nativeId) return;
    return startSessionDispatchPolling({
      visible: () => document.visibilityState !== "hidden", now: Date.now,
      every: (callback, ms) => window.setInterval(callback, ms), cancel: (timer) => window.clearInterval(timer as number),
      onVisibility: (callback) => { document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); },
    }, (signal) => fetchParentDispatches(nativeId, signal), (runs) => {
      linkCount.current = runs.length;
      setIds(runs.map((run) => run.runId));
    }, () => backgroundCount, linkCount.current);
  }, [nativeId, backgroundCount]);
  if (!backgroundCount && !ids.length) return null;
  return <div className="session-dispatch-link">{backgroundCount > 0 && <span>后台 {backgroundCount} 个任务</span>}
    {ids.length > 0 && <button className="btn" onClick={() => store.navigateDispatches(ids)}>查看派单{ids.length > 1 ? `（${ids.length}）` : ""}</button>}
  </div>;
}
