import { t } from "../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fetchDispatchDetail, fetchDispatches } from "../api";
import { dispatchName, dispatcherSessions, dispatcherModel, dispatcherLabel, dispatchForests, dispatchParent, dispatchModelName, dispatchWirePath, dispatchSeconds, dispatchStatus, dispatchTime, groupDispatches, buildDispatchTree, type DispatchTreeNode, type DispatchTool, type DispatchRun } from "../dispatch-flow";
import { effectiveFor } from "../config-view";
import { startDispatchPolling } from "../dispatch-polling";
import { sessionTitle } from "../format";
import { useStore } from "../useStore";
import { AgentIcon } from "./AgentIcon";
import { store } from "../store";
import { DispatchDetail } from "./DispatchDetail";
import { DispatchHistory } from "./DispatchHistory";

const LABELS = { codex: "Codex", kimi: "Kimi", copilot: "Copilot", claude: "Claude Code" };
const selectTitles = (value: import("../store").Store) => value.sessions.map((session) => ({
  id: session.id, agent: session.agent, nativeSessionId: session.nativeSessionId,
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
    setRuns(items);
    setLoaded(true);
  }, setError, setNow), [terminalOpen, route]);

  const groups = groupDispatches(runs, now);
  const visibleRuns = groups.flatMap((group) => group.runs);
  const forests = dispatchForests(visibleRuns, sessions, runs);
  const running = forests.flatMap(forest => forest.runs).filter(run => run.status === "running").length;

  if (selectedId) return <DispatchDetail key={selectedId} runId={selectedId} sessions={sessions} terminalOpen={terminalOpen} />;

  return (
    <section className="dispatch-view" aria-label={t("ui.DispatchView.dispatch_flow")}>
      {error && <p className="dispatch-error" role="alert">{t("ui.DispatchView.failed_to_load_dispatches_will_retry_automatically_sentence", { p0: (error) })}</p>}
      <section className="dispatch-panel" aria-label={t("ui.DispatchView.dispatch_topology")}>
        <div className="dispatch-panel-head"><strong>{t("ui.DispatchView.active_dispatches")}</strong><span>{!loaded ? t("ui.common.loading") : running ? t("ui.DispatchView.dispatches_running_trees", { p0: (running), p1: (forests.length) }) : forests.length ? t("ui.DispatchView.trees_recently_ended", { p0: (forests.length) }) : t("ui.DispatchView.0_dispatches")}</span></div>
        {forests.length ? forests.map((forest) => {
          const roots = forest.runs.filter((run) => !dispatchParent(run, runs) && run.parent?.agent === forest.agent);
          return <DispatchTree key={forest.id} agent={forest.agent} groups={groupDispatches(forest.runs, now)}
            title={forest.title} dispatchers={dispatcherSessions(roots, sessions)} model={dispatcherModel(roots, sessions)}
            highlighted={highlighted} now={now} />;
        }) : null}
        {loaded && !error && !forests.length && <p className="dispatch-empty">{t("ui.DispatchView.no_dispatches_right_now")}</p>}
      </section>
      {highlighted.size > 0 && <p className="dispatch-note dispatch-highlight-note">{t("ui.DispatchView.highlighted_dispatches_linked_from_the_session_sentence", { p0: (highlighted.size) })}</p>}
      <DispatchHistory />
    </section>
  );
}


/** Polling and fixture rendering share the same pure tree, including row anchors. */
export function DispatchTree({ groups, title, dispatchers = [], agent, model, highlighted = new Set<string>(), now = Date.now() }: {
  groups: ReturnType<typeof groupDispatches>; title: string; dispatchers?: ReturnType<typeof dispatcherSessions>;
  agent?: string; model: string | null; highlighted?: ReadonlySet<string>; now?: number;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const shownTools = new Set(expanded);
  for (const group of groups) if (group.runs.slice(3).some(run => highlighted.has(run.runId))) shownTools.add(group.tool);
  const topology = buildDispatchTree(groups, now, shownTools);
  // Geometry changes only with topology/content/size; the elapsed clock does not redraw it.
  const layoutKey = JSON.stringify({ title, model, dispatchers, nodes: [...topology.sidebranches, ...topology.levels.flat()].map(node =>
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
  const sourceTitle = [title, sessionTitles, model].filter(Boolean).join("\n");
  const sourceAgent = agent ?? (dispatchers.length && dispatchers.every((source) => source.agent === dispatchers[0]!.agent) ? dispatchers[0]!.agent : "unknown");
  return <div className="dispatch-tree" ref={tree}>
    <svg className="dispatch-wires" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
      {topology.edges.map(edge => <path key={edge.to} className={`dispatch-wire${edge.kind === "subagent" ? " dispatch-subagent-wire" : edge.kind === "sidebranch" ? " dispatch-sidebranch-wire" : ""} ${edge.state}`}
        data-from={edge.from} data-to={edge.to} d={geometry.paths[edge.to]} vectorEffect="non-scaling-stroke"
        style={{ "--wire-color": `var(--agent-${edge.tool})` } as CSSProperties} />)}
    </svg>
    <div className={`dispatch-root-row${topology.sidebranches.length ? " has-sidebranches" : ""}`}>
    <article className="dispatch-node dispatch-source" data-dispatch-anchor="dispatcher" data-source-agent={sourceAgent} title={sourceTitle}>
      <div className="dispatch-source-head">{["claude", "codex", "kimi"].includes(sourceAgent) && <AgentIcon agent={sourceAgent as "claude" | "codex" | "kimi"} label={dispatcherLabel(sourceAgent)} />}<span>{dispatcherLabel(sourceAgent)}</span><span className="dispatch-role">{t("ui.DispatchView.dispatcher")}</span></div>
      <p className="dispatch-session-title" title={sessionTitles}>{sessionSummary}</p>
      {model && <p className="dispatch-model" title={model}>{model}</p>}
    </article>
    {topology.sidebranches.length > 0 && <div className="dispatch-sidebranches" aria-label={t("ui.DispatchView.claude_code_subagent_branch")}>
      {topology.sidebranches.map(node => <DispatchNode key={node.id} node={node} now={now} highlighted={highlighted} onToggle={toggleGroup} />)}
    </div>}
    </div>
    {topology.levels.map((nodes, index) => <div className={`dispatch-level${index === 0 ? " dispatch-executors" : ""}`} aria-label={t("ui.DispatchView.execution_tree_level", { p0: (index + 2) })} style={{ "--dispatch-columns": Math.min(4, nodes.length) } as CSSProperties} key={index}>
      {nodes.map(node => <DispatchNode key={node.id} node={node} now={now} highlighted={highlighted} onToggle={toggleGroup} />)}
    </div>)}
  </div>;
}

function ExecutorIcon({ tool }: { tool: DispatchTool }) {
  return tool === "copilot"
    ? <svg className="agent-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3h8l2 4h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2l-2 3H8l-2-3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2z" /><rect x="5" y="8" width="6" height="6" rx="2" /><rect x="13" y="8" width="6" height="6" rx="2" /></svg>
    : <AgentIcon agent={tool} label={LABELS[tool]} />;
}

function runTitle(run: DispatchRun, now: number): string {
  return t("ui.DispatchView.started_ended", { p0: (dispatchName(run)), p1: (run.model || "—"), p2: (run.effort ? ` / ${run.effort}` : ""), p3: (run.agentType ? ` · ${run.agentType}` : ""), p4: (dispatchStatus(run.status).label), p5: (dispatchTime(dispatchSeconds(run, now))), p6: (run.startedAt || t("ui.DispatchView.unknown_detail")), p7: (run.endedAt || "—"), p8: (run.promptHead ? `\n${run.promptHead}` : "") });
}

function RunLines({ run, now, tool }: { run: DispatchRun; now: number; tool: DispatchTool }) {
  const status = dispatchStatus(run.status);
  return <>
    <div className={`dispatch-node-head${run.effort ? " dispatch-model-head" : ""}`}><ExecutorIcon tool={tool} /><span className="dispatch-model"><span className="dispatch-model-name">{run.model ? dispatchModelName(run.model) : LABELS[tool]}</span>{run.effort && <span className="dispatch-model-effort"> · {run.effort}</span>}</span></div>
    <div className="dispatch-job-meta"><span className={`dispatch-status ${status.className}${run.status === "running" ? " running" : ""}`}>{status.label}</span><span className="dispatch-elapsed">{dispatchTime(dispatchSeconds(run, now))}</span></div>
    {run.agentType && <strong className="dispatch-subagent-name">{run.agentType}</strong>}
    <p className="dispatch-activity">{dispatchName(run)}</p>
  </>;
}

function DispatchNode({ node, now, highlighted, onToggle }: {
  node: DispatchTreeNode; now: number; highlighted: ReadonlySet<string>; onToggle: (tool: string, open: boolean) => void;
}) {
  const className = `dispatch-node ${node.kind === "executor" ? "dispatch-executor" : node.kind === "subagent" ? "dispatch-subagent" : node.kind === "sidebranch" ? "dispatch-sidebranch" : "dispatch-run"}${node.mode === "idle" ? " idle" : ""}${node.run && highlighted.has(node.run.runId) ? " highlighted" : ""}`;
  const attrs = { className, "data-tool": node.tool, "data-dispatch-anchor": node.id, "data-depth": node.depth };
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
    <div className="dispatch-node-head"><ExecutorIcon tool={node.tool} /><h2 title={LABELS[node.tool]}>{LABELS[node.tool]}</h2>{node.mode === "idle" && <span className="dispatch-idle-label">{t("ui.common.idle")}</span>}</div>
    {node.mode === "group" && <>
      {node.rows.map((row, index) => {
        const status = dispatchStatus(row.run.status);
        const contents = <><span className={`dispatch-state-dot ${row.run.status === "running" ? "running" : status.className}`} /><span className="dispatch-row-name">{dispatchName(row.run)}</span><span className="dispatch-elapsed">{dispatchTime(dispatchSeconds(row.run, now))}</span></>;
        const rowAttrs = { className: `dispatch-summary-row${highlighted.has(row.run.runId) ? " highlighted" : ""}`, title: runTitle(row.run, now),
          "data-dispatch-anchor": row.id, "data-row-index": index, "aria-label": runTitle(row.run, now) };
        return row.run.native ? <div key={row.id} {...rowAttrs}>{contents}</div>
          : <button key={row.id} type="button" {...rowAttrs} onClick={() => store.navigateDispatches([row.run.runId])}>{contents}</button>;
      })}
      {node.more > 0 && <details className="dispatch-more" open={node.expanded || undefined} onToggle={event => onToggle(node.tool, event.currentTarget.open)}><summary>{t("ui.DispatchView.view_all_sentence", { p0: (node.more) })}</summary></details>}
    </>}
  </article>;
}
