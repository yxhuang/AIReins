import { t } from "../i18n";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fetchDispatchDetail } from "../api";
import { dispatchName, dispatcherSessions, dispatcherModel, dispatcherLabel, dispatchForests, dispatchParent, dispatchModelName, dispatchWirePath, dispatchSeconds, dispatchStatus, dispatchTime, groupDispatches, buildDispatchTree, isAntigravityNativeDispatch, type DispatchTreeNode, type DispatchTool, type DispatchRun } from "../dispatch-flow";
import { effectiveFor } from "../config-view";
import { startDispatchPolling } from "../dispatch-polling";
import { sessionTitle } from "../format";
import { useStore } from "../useStore";
import { store } from "../store";
import type { AntigravityRuntimeState } from "../types";
import { DispatchDetail } from "./DispatchDetail";
import { DispatchHistory, DispatchToolIcon } from "./DispatchHistory";
import { DispatchOverviewContext } from "./DispatchOverview";

const selectTitles = (value: import("../store").Store) => value.sessions.map((session) => ({
  id: session.id, agent: session.agent, nativeSessionId: session.nativeSessionId, status: session.status,
  model: session.config?.model || effectiveFor(session, "model")?.value || null,
  title: sessionTitle(session, value.data.get(session.id)?.events),
}));

export function DispatchView({ terminalOpen = false }: { terminalOpen?: boolean }) {
  const route = useStore(() => window.location.hash);
  const selected = route.match(/^#\/dispatches\/([^?]+)/)?.[1];
  const selectedId = selected ? decodeURIComponent(selected) : null;
  const highlighted = useMemo(() => new Set(new URLSearchParams(route.split("?")[1]).get("runs")?.split(",").filter(Boolean) ?? []), [route]);
  const { overview, error } = useContext(DispatchOverviewContext);
  const [extra, setExtra] = useState<{ highlighted: Set<string>; runs: DispatchRun[] } | null>(null);
  const overviewRuns = overview?.dispatches ?? [];
  const missingIds = overview && !selectedId
    ? [...highlighted].filter(id => !overviewRuns.some(run => run.runId === id)).join(",") : "";
  const [now, setNow] = useState(Date.now);
  const sessions = useStore(selectTitles, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const currentId = useStore(state => state.currentId);
  useEffect(() => {
    if (selectedId) return;
    const mobile = window.matchMedia("(max-width: 720px)");
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      if (document.visibilityState === "hidden" || (terminalOpen && mobile.matches)) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    mobile.addEventListener("change", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      mobile.removeEventListener("change", sync);
      window.clearInterval(timer);
    };
  }, [selectedId, terminalOpen]);
  useEffect(() => {
    if (!missingIds) return;
    const missing = missingIds.split(",");
    const mobile = window.matchMedia("(max-width: 720px)");
    return startDispatchPolling({
      visible: () => document.visibilityState !== "hidden" && !(terminalOpen && mobile.matches),
      every: (callback, ms) => window.setInterval(callback, ms),
      cancel: timer => window.clearInterval(timer as number),
      onVisibility: callback => {
        document.addEventListener("visibilitychange", callback);
        mobile.addEventListener("change", callback);
        return () => {
          document.removeEventListener("visibilitychange", callback);
          mobile.removeEventListener("change", callback);
        };
      },
    }, async signal => {
      const results = await Promise.allSettled(missing.map(id => fetchDispatchDetail(id, signal)));
      signal.throwIfAborted();
      return { dispatches: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []) };
    }, ({ dispatches }) => setExtra({ highlighted, runs: dispatches }), () => {});
  }, [missingIds, highlighted, terminalOpen]);

  const runs = extra?.highlighted === highlighted ? [...overviewRuns, ...extra.runs.filter(run =>
    !overviewRuns.some(item => item.runId === run.runId))] : overviewRuns;
  const groups = groupDispatches(runs, now);
  const visibleRuns = groups.flatMap((group) => group.runs);
  const forests = dispatchForests(visibleRuns, sessions, runs, currentId);
  const dispatchTreeCount = forests.filter(forest => forest.runs.length > 0).length;
  const running = forests.flatMap(forest => forest.runs).filter(run => run.status === "running").length;
  const currentAntigravity = sessions.find(session => session.id === currentId && session.agent === "antigravity");

  if (selectedId) return <DispatchDetail key={selectedId} runId={selectedId} sessions={sessions} terminalOpen={terminalOpen} />;

  return (
    <section className="dispatch-view" aria-label={t("ui.DispatchView.dispatch_flow")}>
      {error && <p className="dispatch-error" role="alert">{t("ui.DispatchView.failed_to_load_dispatches_will_retry_automatically_sentence", { p0: (error) })}</p>}
      <section className="dispatch-panel" aria-label={t("ui.DispatchView.dispatch_topology")}>
        <div className="dispatch-panel-head"><strong>{t("ui.DispatchView.active_dispatches")}</strong>
          <span className="dispatch-panel-stat" data-status={running ? "running" : undefined}>{!overview ? t("ui.common.loading") : running ? t("ui.DispatchView.dispatches_running_trees", { p0: (running), p1: (dispatchTreeCount) }) : dispatchTreeCount ? t("ui.DispatchView.trees_recently_ended", { p0: (dispatchTreeCount) }) : t("ui.DispatchView.0_dispatches")}</span>
        </div>
        {forests.map((forest) => {
          const roots = forest.runs.filter((run) => !dispatchParent(run, runs) && run.parent?.agent === forest.agent);
          const idle = forest.idleSession;
          const dispatchers = dispatcherSessions(roots, sessions);
          const candidates = forest.agent === "antigravity" ? (overview?.runtimeStates ?? []).filter(state => currentAntigravity
            ? state.sessionId === currentAntigravity.id || state.nativeSessionId === currentAntigravity.nativeSessionId
            : dispatchers.some(source => source.id === state.sessionId || source.id === state.nativeSessionId)) : [];
          const observations = candidates.map(state => {
            const session = sessions.find(item => item.agent === state.agent && item.id === state.sessionId);
            return { state, title: session?.title ?? dispatchers.find(source => source.id === state.nativeSessionId)?.title,
              running: session ? session.status === "running" : roots.some(run =>
                isAntigravityNativeDispatch(run) && run.agentType === "inner-loop"
                && run.parent?.sessionId === state.nativeSessionId && run.status === "running") };
          }).sort((a, b) => Number(b.running) - Number(a.running)
            || (b.state.updatedAt ?? "").localeCompare(a.state.updatedAt ?? ""));
          const observation = observations[0];
          return <DispatchTree key={forest.id} agent={forest.agent} groups={groupDispatches(forest.runs, now)}
            title={idle?.title ?? forest.title} dispatchers={dispatchers}
            model={idle?.model ? dispatchModelName(idle.model) : dispatcherModel(roots, sessions)}
            modelTitle={idle?.model ?? dispatcherModel(roots, sessions, true)}
            runtime={observation?.state} runtimeTitle={observation?.title} running={observation?.running}
            highlighted={highlighted} now={now} />;
        })}
        {overview && !error && !forests.length && <p className="dispatch-empty">{t("ui.DispatchView.no_dispatches_right_now")}</p>}
      </section>
      {highlighted.size > 0 && <p className="dispatch-note dispatch-highlight-note">{t("ui.DispatchView.highlighted_dispatches_linked_from_the_session_sentence", { p0: (highlighted.size) })}</p>}
      <DispatchHistory />
    </section>
  );
}


/** Polling and fixture rendering share the same pure tree, including row anchors. */
export function DispatchTree({ groups, title, dispatchers = [], agent, model, modelTitle, runtime, runtimeTitle, running,
  highlighted = new Set<string>(), now = Date.now() }: {
  groups: ReturnType<typeof groupDispatches>; title: string; dispatchers?: ReturnType<typeof dispatcherSessions>;
  agent?: string; model: string | null; modelTitle?: string | null; highlighted?: ReadonlySet<string>; now?: number;
  runtime?: Pick<AntigravityRuntimeState, "activeModel" | "activePhase" | "updatedAt">; runtimeTitle?: string; running?: boolean;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const shownTools = new Set(expanded);
  for (const group of groups) if (group.runs.slice(3).some(run => highlighted.has(run.runId))) shownTools.add(group.tool);
  const topology = buildDispatchTree(groups.filter(group => agent !== "antigravity" || group.tool !== "copilot" || group.runs.length > 0), now, shownTools);
  // Geometry changes only with topology/content/size; the elapsed clock does not redraw it.
  const layoutKey = JSON.stringify({ title, model, dispatchers, activeModel: runtime?.activeModel, activePhase: runtime?.activePhase,
    nodes: [...topology.sidebranches, ...topology.levels.flat()].map(node =>
    [node.id, node.parentId, node.mode, node.rows.map(row => row.id), node.more, node.expanded,
      node.run?.model, node.run?.effort, node.run?.agentType, node.run && dispatchName(node.run),
      node.subagent?.nickname, node.subagent?.role, node.subagent?.activity]) });
  const edges = useMemo(() => topology.edges.map(edge => ({ from: edge.from, to: edge.to, port: edge.port, side: edge.kind === "sidebranch" })), [layoutKey]);
  const tree = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{ width: number; height: number; paths: Record<string, string> }>({ width: 1, height: 1, paths: {} });
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element) return;
    const draw = () => {
      const box = element.querySelector("svg.dispatch-wires")!.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const anchors = new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-dispatch-anchor]"),
        node => [node.dataset.dispatchAnchor!, node]));
      const relative = (rect: DOMRect) => ({ left: rect.left - box.left, right: rect.right - box.left,
        top: rect.top - box.top, bottom: rect.bottom - box.top });
      const paths: Record<string, string> = {};
      for (const edge of edges) {
        const parent = anchors.get(edge.from), child = anchors.get(edge.to);
        if (!parent || !child) continue;
        const from = parent.getBoundingClientRect(), to = child.getBoundingClientRect();
        if (edge.port) {
          const card = parent.closest(".dispatch-node")!;
          paths[edge.to] = dispatchWirePath(relative(card.getBoundingClientRect()), relative(to), edge.port);
        } else {
          paths[edge.to] = dispatchWirePath(relative(from), relative(to), undefined, edge.side);
        }
      }
      setGeometry({ width: box.width, height: box.height, paths });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    element.querySelectorAll(".dispatch-node, .dispatch-summary-row").forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [edges]);

  const toggleGroup = (tool: string, open: boolean) => setExpanded(previous => {
    if (previous.has(tool) === open) return previous;
    const next = new Set(previous); if (open) next.add(tool); else next.delete(tool); return next;
  });
  const sessionTitles = dispatchers.map(source => source.title).join("\n") || title;
  const sessionSummary = dispatchers.length > 1
    ? dispatchers.map(source => t("ui.DispatchView.message", { p0: (source.title), p1: (source.running ? t("ui.DispatchView.dispatches_running_detail", { p0: (source.running) }) : "") })).join(" · ")
    : sessionTitles;
  const sourceTitle = [title, sessionTitles, modelTitle ?? model].filter(Boolean).join("\n");
  const sourceAgent = agent ?? (dispatchers.length && dispatchers.every((source) => source.agent === dispatchers[0]!.agent) ? dispatchers[0]!.agent : "unknown");
  const phase = runtime?.activePhase === "planning" ? t("ui.DispatchView.planning")
    : runtime?.activePhase === "executing" ? t("ui.DispatchView.execution_phase") : null;
  const liveModel = runtime?.activeModel ? dispatchModelName(runtime.activeModel) : null;
  const liveLabel = liveModel ? [liveModel, running ? phase : null].filter(Boolean).join(" · ")
    : runtime?.activePhase === "executing" ? t("ui.DispatchView.execution_model") : phase;
  const liveTitle = [runtime?.activeModel ?? (runtime?.activePhase === "executing" ? t("ui.DispatchView.waiting_for_executor") : phase),
    runtime?.updatedAt && t("ui.DispatchView.model_observed_at", { p0: runtime.updatedAt }), runtimeTitle].filter(Boolean).join("\n");
  const branchLabel = topology.sidebranches.some(node => node.run?.agentType === "swarm") ? t("ui.DispatchView.antigravity_native_dispatches")
    : t(sourceAgent === "antigravity" ? "ui.DispatchView.antigravity_inner_execution" : "ui.DispatchView.claude_code_subagent_branch");
  return <div className="dispatch-tree" ref={tree}>
    <svg className="dispatch-wires" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
      {topology.edges.map(edge => <path key={edge.to} className={`dispatch-wire${edge.kind === "subagent" ? " dispatch-subagent-wire" : edge.kind === "sidebranch" ? " dispatch-sidebranch-wire" : ""} ${edge.state}`}
        data-from={edge.from} data-to={edge.to} data-dispatch-model={edge.modelFamily} d={geometry.paths[edge.to]} vectorEffect="non-scaling-stroke"
        style={{ "--wire-color": `var(--agent-${edge.tool})` } as CSSProperties} />)}
    </svg>
    <div className={`dispatch-root-row${topology.sidebranches.length ? " has-sidebranches" : ""}`}>
    <article className="dispatch-node dispatch-source" data-dispatch-anchor="dispatcher" data-source-agent={sourceAgent} data-status={running ? "running" : undefined} title={sourceTitle}>
      <div className="dispatch-source-head"><DispatchToolIcon tool={sourceAgent} /><span>{dispatcherLabel(sourceAgent)}</span><span className="dispatch-role">{t("ui.DispatchView.dispatcher")}</span></div>
      <p className="dispatch-session-title" title={sessionTitles}>{sessionSummary}</p>
      {model && model !== liveModel && <p className="dispatch-model" title={modelTitle ?? model}>{model}</p>}
      {liveLabel && <div className="dispatch-live-model" data-status={running ? "running" : undefined} title={liveTitle}>
        <span>{t(running ? "ui.DispatchView.current_model" : "ui.DispatchView.last_model", { p0: liveLabel })}</span>
      </div>}
    </article>
    {topology.sidebranches.length > 0 && <div className="dispatch-sidebranches" aria-label={branchLabel}>
      {topology.sidebranches.map(node => <DispatchNode key={node.id} node={node} now={now} highlighted={highlighted} onToggle={toggleGroup} />)}
    </div>}
    </div>
    {topology.levels.map((nodes, index) => <div className={`dispatch-level${index === 0 ? " dispatch-executors" : ""}`} aria-label={t("ui.DispatchView.execution_tree_level", { p0: (index + 2) })} style={{ "--dispatch-columns": Math.min(4, nodes.length) } as CSSProperties} key={index}>
      {nodes.map(node => <DispatchNode key={node.id} node={node} now={now} highlighted={highlighted} onToggle={toggleGroup} />)}
    </div>)}
  </div>;
}

function runTitle(run: DispatchRun, now: number): string {
  const nativeAntigravity = isAntigravityNativeDispatch(run);
  return t("ui.DispatchView.started_ended", { p0: (dispatchName(run)), p1: (run.model || (nativeAntigravity && run.agentType === "inner-loop" ? t("ui.DispatchView.waiting_for_executor") : "—")), p2: (run.effort ? ` / ${run.effort}` : ""), p3: (run.agentType && !nativeAntigravity ? ` · ${run.agentType}` : ""), p4: (dispatchStatus(run.status).label), p5: (dispatchTime(dispatchSeconds(run, now))), p6: (run.startedAt || t("ui.DispatchView.unknown_detail")), p7: (run.endedAt || "—"), p8: (run.promptHead ? `\n${run.promptHead}` : "") });
}

function RunLines({ run, now, tool }: { run: DispatchRun; now: number; tool: DispatchTool }) {
  const status = dispatchStatus(run.status);
  const nativeAntigravity = isAntigravityNativeDispatch(run);
  const inner = nativeAntigravity && run.agentType === "inner-loop";
  const modelTitle = nativeAntigravity ? run.model ?? (inner ? t("ui.DispatchView.waiting_for_executor") : undefined) : undefined;
  return <>
    <div className={`dispatch-node-head${run.effort ? " dispatch-model-head" : ""}`}><DispatchToolIcon tool={tool} /><span className="dispatch-model"><span className="dispatch-model-name" title={modelTitle}>{run.model ? dispatchModelName(run.model) : inner ? t("ui.DispatchView.execution_model") : dispatcherLabel(tool)}</span>{run.effort && <span className="dispatch-model-effort"> · {run.effort}</span>}</span></div>
    <div className="dispatch-job-meta"><span className={`dispatch-status ${status.className}${run.status === "running" ? " running" : ""}`}>{status.label}</span><span className="dispatch-elapsed">{dispatchTime(dispatchSeconds(run, now))}</span></div>
    {run.agentType && !nativeAntigravity && <strong className="dispatch-subagent-name">{run.agentType}</strong>}
    <p className="dispatch-activity">{dispatchName(run)}</p>
  </>;
}

function DispatchNode({ node, now, highlighted, onToggle }: {
  node: DispatchTreeNode; now: number; highlighted: ReadonlySet<string>; onToggle: (tool: string, open: boolean) => void;
}) {
  const className = `dispatch-node ${node.kind === "executor" ? "dispatch-executor" : node.kind === "subagent" ? "dispatch-subagent" : node.kind === "sidebranch" ? "dispatch-sidebranch" : "dispatch-run"}${node.mode === "idle" ? " idle" : ""}${node.run && highlighted.has(node.run.runId) ? " highlighted" : ""}`;
  const rowStates = node.rows.map(({ run }) => run.status === "running" ? "running" : dispatchStatus(run.status).className);
  const status = node.run ? node.run.status === "running" ? "running" : dispatchStatus(node.run.status).className
    : node.subagent?.status ?? ["running", "failed", "finished", "unknown"].find(state => rowStates.includes(state));
  const attrs = { className, "data-tool": node.tool, "data-dispatch-anchor": node.id, "data-depth": node.depth, "data-status": status,
    "data-dispatch-model": node.modelFamily };
  if (node.run) {
    const contents = <RunLines run={node.run} tool={node.tool} now={now} />;
    return node.run.native ? <article {...attrs} title={runTitle(node.run, now)}>{contents}</article>
      : <button type="button" {...attrs} title={runTitle(node.run, now)} onClick={() => store.navigateDispatches([node.run!.runId])}>{contents}</button>;
  }
  if (node.subagent) {
    const agent = node.subagent;
    const label = agent.status === "running" ? t("ui.common.running") : agent.status === "finished" ? t("ui.DispatchView.completed") : t("ui.common.unknown");
    const start = Date.parse(agent.startedAt || ""), end = agent.status === "running" ? now : Date.parse(agent.lastActivityAt);
    const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null;
    return <article {...attrs} data-thread-id={agent.threadId} data-parent-id={agent.parentThreadId}
      title={t("ui.DispatchView.started_last_activity", { p0: (agent.nickname), p1: (agent.role || "—"), p2: (label), p3: (dispatchTime(elapsed)), p4: (agent.activity || ""), p5: (agent.startedAt || t("ui.DispatchView.unknown_detail")), p6: (agent.lastActivityAt) })}>
      <strong className="dispatch-subagent-name">{agent.nickname}{agent.role ? ` · ${agent.role}` : ""}</strong>
      <div className="dispatch-job-meta"><span className={`dispatch-status${agent.status === "finished" ? " finished" : agent.status === "running" ? " running" : " unknown"}`}>{label}</span><span className="dispatch-elapsed">{dispatchTime(elapsed)}</span></div>
      <p className="dispatch-activity">{agent.status === "running" ? agent.activity || t("ui.DispatchView.executing") : label}</p>
    </article>;
  }
  return <article {...attrs}>
    <div className="dispatch-node-head"><DispatchToolIcon tool={node.tool} /><h2 title={dispatcherLabel(node.tool)}>{dispatcherLabel(node.tool)}</h2>{node.mode === "idle" && <span className="dispatch-idle-label">{t("ui.common.idle")}</span>}</div>
    {node.mode === "group" && <>
      {node.rows.map((row, index) => {
        const status = dispatchStatus(row.run.status);
        const contents = <><span className={`dispatch-state-dot ${row.run.status === "running" ? "running" : status.className}`} /><span className="dispatch-row-name">{dispatchName(row.run)}</span><span className="dispatch-elapsed">{dispatchTime(dispatchSeconds(row.run, now))}</span></>;
        const rowAttrs = { className: `dispatch-summary-row${highlighted.has(row.run.runId) ? " highlighted" : ""}`, title: runTitle(row.run, now),
          "data-dispatch-anchor": row.id, "data-row-index": index, "data-status": rowStates[index], "aria-label": runTitle(row.run, now) };
        return row.run.native ? <div key={row.id} {...rowAttrs}>{contents}</div>
          : <button key={row.id} type="button" {...rowAttrs} onClick={() => store.navigateDispatches([row.run.runId])}>{contents}</button>;
      })}
      {node.more > 0 && <details className="dispatch-more" open={node.expanded || undefined} onToggle={event => onToggle(node.tool, event.currentTarget.open)}><summary>{t("ui.DispatchView.view_all_sentence", { p0: (node.more) })}</summary></details>}
    </>}
  </article>;
}
