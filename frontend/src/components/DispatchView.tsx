import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { fetchDispatches } from "../api";
import { dispatchName, dispatcherTitle, dispatchSeconds, dispatchStatus, dispatchTime, groupDispatches, type DispatchRun } from "../dispatch-flow";
import { startDispatchPolling } from "../dispatch-polling";
import { sessionTitle } from "../format";
import { useStore } from "../useStore";
import { AgentIcon } from "./AgentIcon";

const LABELS = { codex: "Codex", kimi: "Kimi", copilot: "Copilot" };
const selectTitles = (value: import("../store").Store) => value.sessions.map((session) => ({
  id: session.id, nativeSessionId: session.nativeSessionId,
  title: sessionTitle(session, value.data.get(session.id)?.events),
}));

export function DispatchView({ terminalOpen = false }: { terminalOpen?: boolean }) {
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const observedEnds = useRef(new Map<string, number>());
  const sessions = useStore(selectTitles, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  useEffect(() => startDispatchPolling({
    visible: () => document.visibilityState !== "hidden"
      && !(terminalOpen && window.matchMedia("(max-width: 720px)").matches),
    now: Date.now,
    every: (callback, ms) => window.setInterval(callback, ms),
    cancel: (timer) => window.clearInterval(timer as number),
    onVisibility: (callback) => {
      const mobile = window.matchMedia("(max-width: 720px)");
      document.addEventListener("visibilitychange", callback);
      mobile.addEventListener("change", callback);
      return () => {
        document.removeEventListener("visibilitychange", callback);
        mobile.removeEventListener("change", callback);
      };
    },
  }, fetchDispatches, (items) => {
    for (const run of items) {
      if (run.status === "running") observedEnds.current.delete(run.runId);
      else if (run.status === "lost" && !observedEnds.current.has(run.runId)) observedEnds.current.set(run.runId, Date.now());
    }
    setRuns(items);
    setLoaded(true);
  }, setError, setNow), [terminalOpen]);

  const groups = groupDispatches(runs, now, observedEnds.current);
  const visibleRuns = groups.flatMap((group) => group.runs);
  const running = visibleRuns.filter((run) => run.status === "running").length;
  const title = dispatcherTitle(visibleRuns, sessions);
  const tree = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ width: number; height: number; paths: string[] }>({ width: 1, height: 1, paths: [] });
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element) return;
    const draw = () => {
      const svg = element.querySelector("svg.dispatch-wires")!;
      const box = svg.getBoundingClientRect();
      const source = element.querySelector(".dispatch-source")!.getBoundingClientRect();
      const cards = Array.from(element.querySelectorAll(".dispatch-executor"), (card) => card.getBoundingClientRect());
      if (!box.width || !box.height || cards.length !== 3) return;
      const x = (source.left + source.right) / 2 - box.left;
      const y = source.bottom - box.top;
      const spine = cards[0]!.left - box.left - 30;
      const paths: string[] = [];
      if (box.width < 720) {
        const last = cards[2]!;
        const lastY = (last.top + last.bottom) / 2 - box.top;
        paths.push(`M ${x} ${y} V ${y + 12} Q ${x} ${y + 24} ${x - 12} ${y + 24} H ${spine + 12} Q ${spine} ${y + 24} ${spine} ${y + 36} V ${lastY - 12}`);
      }
      for (const card of cards) {
        if (box.width >= 720) {
          const endX = (card.left + card.right) / 2 - box.left;
          const endY = card.top - box.top;
          const bend = (endY - y) * .5;
          paths.push(`M ${x} ${y} C ${x} ${y + bend} ${endX} ${endY - bend} ${endX} ${endY}`);
        } else {
          const endX = card.left - box.left;
          const endY = (card.top + card.bottom) / 2 - box.top;
          paths.push(`M ${spine} ${endY - 12} V ${endY - 10} Q ${spine} ${endY} ${spine + 10} ${endY} H ${endX}`);
        }
      }
      setGeometry({ width: box.width, height: box.height, paths });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    // 行数变化时即使树总高不变，也要重算各卡片的中点。
    element.querySelectorAll(".dispatch-node").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="dispatch-view" aria-label="派单流程图">
      <div className="dispatch-intro"><h1>谁在接力</h1><p>从派单会话，连到每个执行端。</p></div>
      {error && <p className="dispatch-error" role="alert">派单加载失败：{error}（稍后自动重试）</p>}
      <section className="dispatch-panel" aria-label="派单拓扑">
        <div className="dispatch-panel-head"><strong>执行端</strong><span>{!loaded ? "正在加载…" : running ? `${running} 单运行中 · 3 个执行端` : visibleRuns.length ? "3 个执行端 · 最近结束" : "3 个执行端 · 全部空闲"}</span></div>
        <div className="dispatch-tree" ref={tree}>
          <svg className="dispatch-wires" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
            {geometry.paths.length === 4 && <path className="dispatch-wire" d={geometry.paths[0]} vectorEffect="non-scaling-stroke" />}
            {groups.map((group, index) => <path key={group.tool} className={`dispatch-wire ${group.wireState}`} d={geometry.paths[index + (geometry.paths.length === 4 ? 1 : 0)]} vectorEffect="non-scaling-stroke" style={{ "--wire-color": `var(--agent-${group.tool})` } as CSSProperties} />)}
          </svg>
          <article className="dispatch-node dispatch-source">
            <div className="dispatch-source-head"><AgentIcon agent="claude" label="Claude Code" /><span>Claude Code</span><span className="dispatch-role">派单人</span></div>
            <p className="dispatch-session-title" title={title}>{title}</p>
          </article>
          <div className="dispatch-executors">
            {groups.map((group) => <article key={group.tool} className={`dispatch-node dispatch-executor${group.runs.length ? "" : " idle"}`} data-tool={group.tool}>
              <div className="dispatch-node-head">
                {group.tool === "copilot" ? <svg className="agent-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3h8l2 4h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2l-2 3H8l-2-3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2z" /><rect x="5" y="8" width="6" height="6" rx="2" /><rect x="13" y="8" width="6" height="6" rx="2" /><path d="M9 18h6" /></svg> : <AgentIcon agent={group.tool} label={LABELS[group.tool]} />}
                <h2>{LABELS[group.tool]}</h2>
              </div>
              <div className="dispatch-jobs">
                {group.visible.map((run) => {
                  const status = dispatchStatus(run.status);
                  const name = dispatchName(run);
                  return <div className="dispatch-job" key={run.runId}>
                    <p className="dispatch-model">{run.model || "—"} / {run.effort || "—"}</p>
                    <div className="dispatch-job-meta"><span className={`dispatch-status ${status.className}`}>{status.label}</span><span className="dispatch-elapsed" aria-label="已跑时长">{dispatchTime(dispatchSeconds(run, now))}</span></div>
                    <p className="dispatch-activity" title={name}>{name}</p>
                  </div>;
                })}
                {!group.runs.length && <div className="dispatch-job"><p className="dispatch-model">— / —</p><div className="dispatch-job-meta"><span>空闲</span><span className="dispatch-elapsed">—</span></div><p className="dispatch-activity">等待派单</p></div>}
                {group.more > 0 && <div className="dispatch-more">+{group.more}</div>}
              </div>
            </article>)}
          </div>
        </div>
      </section>
      {loaded && !error && !visibleRuns.length && <p className="dispatch-empty">现在没有派单</p>}
    </section>
  );
}
