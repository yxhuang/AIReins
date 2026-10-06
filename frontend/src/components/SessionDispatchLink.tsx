import { useEffect, useRef, useState } from "react";
import { fetchParentDispatches } from "../api";
import { store } from "../store";
import { startSessionDispatchPolling } from "../dispatch-polling";
import type { DispatchRun } from "../dispatch-flow";
import { dispatchBadge, dispatchIcon } from "./PanelActions";

/** 本会话派出的任务：会话里只轮询一份，顶栏图标和标题下的行共用。 */
export function useSessionDispatches(nativeId: string | undefined, backgroundCount: number, agent?: string): DispatchRun[] {
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const linkCount = useRef(0);
  useEffect(() => { setRuns([]); linkCount.current = 0; }, [nativeId, agent]);
  useEffect(() => {
    if (!nativeId) return;
    return startSessionDispatchPolling({
      visible: () => document.visibilityState !== "hidden", now: Date.now,
      every: (callback, ms) => window.setInterval(callback, ms), cancel: (timer) => window.clearInterval(timer as number),
      onVisibility: (callback) => { document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); },
    }, (signal) => fetchParentDispatches(nativeId, signal, agent), (next) => {
      linkCount.current = next.length;
      setRuns(next);
    }, () => backgroundCount, linkCount.current);
  }, [nativeId, backgroundCount, agent]);
  return runs;
}

/** 手机顶栏「⋯」左侧的派单图标：填执行端身份色，多家按扇区分色；点开派单流程图。 */
export function SessionDispatchBadge({ runs, backgroundCount }: { runs: DispatchRun[]; backgroundCount: number }) {
  if (!runs.length) return null;
  // 手机上标题下那行有派单时隐藏，后台任务数并进这里。
  const { fill, label } = dispatchBadge(runs, backgroundCount);
  return <button type="button" className="btn mobile-round session-dispatch-badge" style={{ background: fill }} aria-label={label} title={label}
    onClick={() => store.navigateDispatches(runs.map((run) => run.runId))}>{dispatchIcon}</button>;
}

export function SessionDispatchLink({ runs, backgroundCount, desktop = false }: { runs: DispatchRun[]; backgroundCount: number; desktop?: boolean }) {
  if (!backgroundCount && !runs.length) return null;
  if (desktop) return <button type="button" className="session-dispatch-link" onClick={() => store.navigateDispatches(runs.length ? runs.map((run) => run.runId) : undefined)}>
    {backgroundCount > 0 && `后台 ${backgroundCount} 个任务 · `}查看派单{runs.length > 1 ? `（${runs.length}）` : ""}
  </button>;
  return <div className={`session-dispatch-link${runs.length ? " has-runs" : ""}`}>{backgroundCount > 0 && <span>后台 {backgroundCount} 个任务</span>}
    {runs.length > 0 && <button className="btn" onClick={() => store.navigateDispatches(runs.map((run) => run.runId))}>查看派单{runs.length > 1 ? `（${runs.length}）` : ""}</button>}
  </div>;
}
