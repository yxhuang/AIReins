import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { fetchDispatchDetail, fetchDispatches } from "../api";
import { dispatchName, dispatcherTitle, dispatcherModel, dispatchSeconds, dispatchStatus, dispatchTime, groupDispatches, type DispatchRun } from "../dispatch-flow";
import { effectiveFor, modelShortName } from "../config-view";
import { startDispatchPolling } from "../dispatch-polling";
import { sessionTitle } from "../format";
import { useStore } from "../useStore";
import { AgentIcon } from "./AgentIcon";
import { store } from "../store";
import { DispatchDetail } from "./DispatchDetail";
import { DispatchHistory } from "./DispatchHistory";

const LABELS = { codex: "Codex", kimi: "Kimi", copilot: "Copilot" };
const selectTitles = (value: import("../store").Store) => value.sessions.map((session) => ({
  id: session.id, nativeSessionId: session.nativeSessionId,
  model: session.config?.model || effectiveFor(session, "model")?.value || null,
  title: sessionTitle(session, value.data.get(session.id)?.events),
}));

export function DispatchView({ terminalOpen = false }: { terminalOpen?: boolean }) {
  const route = useStore(() => window.location.hash);
  const selected = route.match(/^#\/dispatches\/([^?]+)/)?.[1];
  const selectedId = selected ? decodeURIComponent(selected) : null;
  const highlighted = new Set(new URLSearchParams(route.split("?")[1]).get("runs")?.split(",").filter(Boolean) ?? []);
  const [runs, setRuns] = useState<DispatchRun[]>([]);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const observedEnds = useRef(new Map<string, number>());
  const sessions = useStore(selectTitles, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  useEffect(() => startDispatchPolling({
    visible: () => !selectedId && document.visibilityState !== "hidden"
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
  }, async (signal) => {
    const data = await fetchDispatches(signal);
    const missing = [...highlighted].filter((id) => !data.dispatches.some((run) => run.runId === id));
    const extra = await Promise.allSettled(missing.map((id) => fetchDispatchDetail(id, signal)));
    for (const result of extra) if (result.status === "fulfilled") data.dispatches.push(result.value);
    return data;
  }, (items) => {
    for (const run of items) {
      if (run.status === "running") observedEnds.current.delete(run.runId);
      else if (run.status === "lost" && !observedEnds.current.has(run.runId)) observedEnds.current.set(run.runId, Date.now());
    }
    setRuns(items);
    setLoaded(true);
  }, setError, setNow), [terminalOpen, route]);

  const groups = groupDispatches(runs, now, observedEnds.current);
  const visibleRuns = groups.flatMap((group) => group.runs);
  const running = visibleRuns.filter((run) => run.status === "running").length;
  const title = dispatcherTitle(visibleRuns, sessions);
  const model = dispatcherModel(visibleRuns, sessions);

  if (selectedId) return <DispatchDetail key={selectedId} runId={selectedId} sessions={sessions} terminalOpen={terminalOpen} />;

  return (
    <section className="dispatch-view" aria-label="派单流程图">
      {error && <p className="dispatch-error" role="alert">派单加载失败：{error}（稍后自动重试）</p>}
      <section className="dispatch-panel" aria-label="派单拓扑">
        <div className="dispatch-panel-head"><strong>执行端</strong><span>{!loaded ? "正在加载…" : running ? `${running} 单运行中 · 3 个执行端` : visibleRuns.length ? "3 个执行端 · 最近结束" : "3 个执行端 · 全部空闲"}</span></div>
        <DispatchTree groups={groups} title={title} model={model} highlighted={highlighted} now={now} />
      </section>
      {loaded && !error && !visibleRuns.length && <p className="dispatch-empty">现在没有派单</p>}
      {highlighted.size > 0 && <p className="dispatch-note dispatch-highlight-note">已标出从会话跳转的 {highlighted.size} 张派单。</p>}
      <DispatchHistory />
    </section>
  );
}


/** Kept separate so fixture rendering exercises the same topology as polling updates. */
export function DispatchTree({ groups, title, model, highlighted = new Set<string>(), now = Date.now() }: {
  groups: ReturnType<typeof groupDispatches>; title: string; model: string | null; highlighted?: ReadonlySet<string>; now?: number;
}) {
  const subagents = [...new Map(groups.filter((group) => group.tool === "codex").flatMap((group) =>
    group.runs.flatMap((run) => run.subagents ?? [])).map((agent) => [agent.threadId, agent])).values()];
  const firstLevel = subagents.filter((agent) => agent.depth === 1);
  const parents = new Set(firstLevel.map((agent) => agent.threadId));
  const levels = [firstLevel, subagents.filter((agent) => agent.depth === 2 && parents.has(agent.parentThreadId))];
  const layoutKey = groups.map((group) => group.runs.map((run) => run.runId).join(",")).join(";")
    + subagents.map((agent) => `${agent.threadId}:${agent.parentThreadId}:${agent.status}`).join(",");
  const tree = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ width: number; height: number; paths: string[]; subpaths: Record<string, string> }>({ width: 1, height: 1, paths: [], subpaths: {} });
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
      // 任何宽度都是从上往下的树（用户 10-01 定）：窄面板/手机只把卡片缩小，不改成竖排。
      const paths = cards.map((card) => {
        const endX = (card.left + card.right) / 2 - box.left;
        const endY = card.top - box.top;
        const bend = (endY - y) * .5;
        return `M ${x} ${y} C ${x} ${y + bend} ${endX} ${endY - bend} ${endX} ${endY}`;
      });
      const codex = element.querySelector('.dispatch-executor[data-tool="codex"]')!;
      const nodes = Array.from(element.querySelectorAll<HTMLElement>(".dispatch-subagent"));
      const byThread = new Map(nodes.map((node) => [node.dataset.threadId, node]));
      const subpaths: Record<string, string> = {};
      for (const node of nodes) {
        const parent = node.dataset.depth === "1" ? codex : byThread.get(node.dataset.parentId);
        if (!parent) continue;
        const from = parent.getBoundingClientRect();
        const to = node.getBoundingClientRect();
        const startX = (from.left + from.right) / 2 - box.left;
        const startY = from.bottom - box.top;
        const endX = (to.left + to.right) / 2 - box.left;
        const endY = to.top - box.top;
        const bend = (endY - startY) * .5;
        subpaths[node.dataset.threadId!] = `M ${startX} ${startY} C ${startX} ${startY + bend} ${endX} ${endY - bend} ${endX} ${endY}`;
      }
      setGeometry({ width: box.width, height: box.height, paths, subpaths });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    // 行数变化时即使树总高不变，也要重算各卡片的中点。
    element.querySelectorAll(".dispatch-node").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [layoutKey]);

  return (
        <div className="dispatch-tree" ref={tree}>
          <svg className="dispatch-wires" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
            {groups.map((group, index) => <path key={group.tool} className={`dispatch-wire ${group.wireState}`} d={geometry.paths[index]} vectorEffect="non-scaling-stroke" style={{ "--wire-color": `var(--agent-${group.tool})` } as CSSProperties} />)}
            {levels.flat().map((agent) => <path key={agent.threadId} className={`dispatch-wire dispatch-subagent-wire ${agent.status === "running" ? "flow" : agent.status === "finished" ? "finish" : "idle"}`} d={geometry.subpaths[agent.threadId]} vectorEffect="non-scaling-stroke" style={{ "--wire-color": "var(--agent-codex)" } as CSSProperties} />)}
          </svg>
          <article className="dispatch-node dispatch-source">
            <div className="dispatch-source-head"><AgentIcon agent="claude" label="Claude Code" /><span>Claude Code</span><span className="dispatch-role">派单人</span></div>
            <p className="dispatch-session-title" title={title}>{title}</p>
            {model && <p className="dispatch-model">{model}</p>}
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
                  return <button type="button" className={`dispatch-job dispatch-job-link${highlighted.has(run.runId) ? " highlighted" : ""}`} key={run.runId} onClick={() => store.navigateDispatches([run.runId])}>
                    <p className="dispatch-model">{run.model ? modelShortName(run.model) : "—"} / {run.effort || "—"}</p>
                    <div className="dispatch-job-meta"><span className={`dispatch-status ${status.className}`}>{status.label}</span><span className="dispatch-elapsed" aria-label="已跑时长">{dispatchTime(dispatchSeconds(run, now))}</span></div>
                    <p className="dispatch-activity" title={name}>{name}</p>
                  </button>;
                })}
                {!group.runs.length && <div className="dispatch-job"><p className="dispatch-model">— / —</p><div className="dispatch-job-meta"><span>空闲</span><span className="dispatch-elapsed">—</span></div><p className="dispatch-activity">等待派单</p></div>}
                {group.more > 0 && <details className="dispatch-more" open={group.runs.slice(3).some((run) => highlighted.has(run.runId)) || undefined}><summary>+{group.more} · 查看全部</summary>{group.runs.slice(3).map((run) => <button key={run.runId} className={`dispatch-job-link${highlighted.has(run.runId) ? " highlighted" : ""}`} onClick={() => store.navigateDispatches([run.runId])}>{dispatchName(run)} · {dispatchStatus(run.status).label}</button>)}</details>}
              </div>
            </article>)}
          </div>
          {levels.map((agents, index) => agents.length > 0 && <div className="dispatch-subagents" aria-label={`Codex 子 agent 第 ${index + 1} 层`} key={index}>
            {agents.map((agent) => <article className="dispatch-node dispatch-subagent" key={agent.threadId} data-thread-id={agent.threadId} data-parent-id={agent.parentThreadId} data-depth={agent.depth}>
              <strong className="dispatch-subagent-name" title={agent.nickname}>{agent.nickname}</strong>
              <p className="dispatch-model">{agent.role || "—"}</p>
              <span className={`dispatch-status${agent.status === "finished" ? " finished" : ""}`}>{agent.status === "running" ? "运行中" : agent.status === "finished" ? "已完成" : "未知"}</span>
              {agent.status === "running" && <p className="dispatch-activity" title={agent.activity || "执行中"}>{agent.activity || "执行中"}</p>}
            </article>)}
          </div>)}
        </div>
  );
}
