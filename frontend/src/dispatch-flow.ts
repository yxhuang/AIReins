import { t } from "./i18n";
import { modelShortName } from "./config-view";

/** 列表接口的显示字段；不引入服务端模块或详情/日志数据。 */
export interface DispatchRun {
  runId: string;
  tool: string;
  name: string;
  model: string | null;
  effort: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsedS: number | null;
  session: string | null;
  parent: { agent: string; sessionId: string | null; entrypoint: string | null; model?: string | null; title?: string | null; runId?: string } | null;
  promptHead?: string | null;
  agentType?: string | null;
  native?: boolean;
  subagents?: DispatchSubagent[];
}

export interface DispatchSubagent {
  threadId: string; nickname: string; role: string | null; depth: number; parentThreadId: string;
  status: "running" | "finished" | "unknown";
  startedAt: string | null; lastActivityAt: string; activity?: string;
}

const DISPATCH_TOOLS = ["codex", "kimi", "copilot", "claude"] as const;
export type DispatchTool = typeof DISPATCH_TOOLS[number];
export type DispatchWireState = "flow" | "finish" | "idle";
export const RECENT_DISPATCH_MS = 30 * 60 * 1000;
export const FINISHED_WIRE_MS = 10 * 60 * 1000;

function recentWireEnd(end: number, now: number): boolean {
  return Number.isFinite(end) && now - end >= 0 && now - end <= FINISHED_WIRE_MS;
}

export function subagentWireState(agent: DispatchSubagent, now: number): "flow" | "finish" | "idle" {
  if (agent.status === "running") return "flow";
  return agent.status === "finished" && recentWireEnd(timestamp(agent.lastActivityAt), now) ? "finish" : "idle";
}

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

/** 仅信任记录的结束时间或 startedAt + 非负 elapsedS；观察时间不代表结束时间。 */
function dispatchEnd(run: DispatchRun): number {
  const end = timestamp(run.endedAt);
  if (Number.isFinite(end)) return end;
  const start = timestamp(run.startedAt);
  if (Number.isFinite(start) && run.elapsedS !== null && Number.isFinite(run.elapsedS) && run.elapsedS >= 0) {
    return start + run.elapsedS * 1000;
  }
  return NaN;
}

export function groupDispatches(runs: readonly DispatchRun[], now: number) {
  return DISPATCH_TOOLS.map((tool) => {
    const items = runs.filter((run) => {
      if (run.tool !== tool) return false;
      if (run.status === "running") return true;
      const end = dispatchEnd(run);
      return Number.isFinite(end) && now - end >= 0 && now - end <= RECENT_DISPATCH_MS;
    }).sort((a, b) => Number(b.status === "running") - Number(a.status === "running")
      || (timestamp(b.startedAt) || 0) - (timestamp(a.startedAt) || 0));
    return {
      tool, runs: items, visible: items.slice(0, 3), more: Math.max(0, items.length - 3),
      wireState: items.some((run) => run.status === "running") ? "flow"
        : items.some((run) => recentWireEnd(dispatchEnd(run), now)) ? "finish" : "idle",
    };
  }).filter((group) => group.tool !== "claude" || group.runs.length > 0);
}

export interface DispatchTreeRow { id: string; run: DispatchRun }
export interface DispatchTreeNode {
  id: string;
  parentId: string;
  depth: number;
  tool: DispatchTool;
  kind: "executor" | "run" | "subagent" | "sidebranch";
  mode?: "idle" | "single" | "group";
  run?: DispatchRun;
  runId?: string;
  subagent?: DispatchSubagent;
  rows: DispatchTreeRow[];
  more: number;
  expanded?: boolean;
}
export interface DispatchTreeEdge {
  from: string; to: string; tool: DispatchTool; state: DispatchWireState;
  kind: "executor" | "run" | "subagent" | "sidebranch";
  /** Group-mode run wires: ordered port on the executor card bottom (folded runs keep theirs). */
  port?: { index: number; count: number };
}

interface DispatchBounds { left: number; right: number; top: number; bottom: number }

/** One independent curve per edge; summary rows select ordered ports on the card bottom. */
export function dispatchWirePath(from: DispatchBounds, to: DispatchBounds, row?: { index: number; count: number }, side = false): string {
  if (side) {
    const y = (from.top + from.bottom) / 2, endY = (to.top + to.bottom) / 2;
    const bend = Math.max(12, (to.left - from.right) / 2);
    return `M ${from.right} ${y} C ${from.right + bend} ${y} ${to.left - bend} ${endY} ${to.left} ${endY}`;
  }
  const x = from.left + (from.right - from.left) * (row ? (row.index + 1) / (row.count + 1) : .5);
  const y = from.bottom;
  const endX = (to.left + to.right) / 2;
  const endY = to.top;
  const bend = Math.max(0, endY - y) / 2;
  return `M ${x} ${y} C ${x} ${y + bend} ${endX} ${endY - bend} ${endX} ${endY}`;
}

/** Keep versioned/full model identifiers in titles; tree cards only need the family. */
export function dispatchModelName(model: string): string {
  const short = modelShortName(model);
  return short.match(/^gpt-\d+(?:\.\d+)*-(sol|luna|astra)(?:-|$)/i)?.[1] ?? short;
}

/** Stable IDs are scoped to the dispatch: identical thread nicknames never merge runs. */
export function buildDispatchTree(groups: ReturnType<typeof groupDispatches>, now: number,
  expanded: ReadonlySet<string> = new Set()) {
  const allRuns = groups.flatMap((group) => group.runs);
  const hasCycle = (run: DispatchRun) => {
    const seen = new Set([run.runId]);
    for (let parent = dispatchParent(run, allRuns); parent; parent = dispatchParent(parent, allRuns)) {
      if (seen.has(parent.runId)) return true;
      seen.add(parent.runId);
    }
    return false;
  };
  const nested = new Set(allRuns.filter((run) => dispatchParent(run, allRuns) && !hasCycle(run)));
  const nativeSides = allRuns.filter(run => !nested.has(run) && run.tool === "claude" && run.native && run.parent?.agent === "claude");
  const rootGroups = groups.map((group) => {
    const runs = group.runs.filter((run) => !nested.has(run) && !nativeSides.includes(run));
    return { ...group, runs, visible: runs.slice(0, 3), more: Math.max(0, runs.length - 3) };
  }).filter((group) => group.runs.length || !groups.find((original) => original.tool === group.tool)!.runs.length);
  const sidebranches: DispatchTreeNode[] = [];
  const executors: DispatchTreeNode[] = [];
  const levels: DispatchTreeNode[][] = [executors];
  const edges: DispatchTreeEdge[] = [];
  const anchors = new Map<string, { id: string; depth: number }>();
  const agentAnchors = new Map<string, { id: string; depth: number }>();
  const add = (node: DispatchTreeNode, state: DispatchWireState, port?: DispatchTreeEdge["port"]) => {
    if (node.kind === "sidebranch") sidebranches.push(node);
    else (levels[node.depth - 2] ??= []).push(node);
    edges.push({ from: node.parentId, to: node.id, tool: node.tool, state, kind: node.kind, ...(port && { port }) });
  };
  const addSubagents = (run: DispatchRun, id: string, depth: number) => {
    const children = new Map<string, DispatchSubagent[]>();
    for (const agent of run.subagents ?? []) {
      const siblings = children.get(agent.parentThreadId) ?? [];
      siblings.push(agent); children.set(agent.parentThreadId, siblings);
    }
    const roots = run.session ? [run.session]
      : [...new Set((run.subagents ?? []).filter(agent => agent.depth === 1).map(agent => agent.parentThreadId))];
    const seen = new Set(roots);
    const queue = roots.map(threadId => ({ threadId, id, depth }));
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      for (const agent of children.get(parent.threadId) ?? []) {
        if (seen.has(agent.threadId)) continue;
        seen.add(agent.threadId);
        const node: DispatchTreeNode = { id: `subagent:${JSON.stringify([run.runId, agent.threadId])}`,
          parentId: parent.id, depth: parent.depth + 1, tool: run.tool as DispatchTool, kind: "subagent",
          runId: run.runId, subagent: agent, rows: [], more: 0 };
        add(node, subagentWireState(agent, now));
        agentAnchors.set(JSON.stringify([run.tool, agent.threadId]), { id: node.id, depth: node.depth });
        queue.push({ threadId: agent.threadId, id: node.id, depth: node.depth });
      }
    }
  };
  const runState = (run: DispatchRun) => run.status === "running" ? "flow"
    : recentWireEnd(dispatchEnd(run), now) ? "finish" : "idle";
  for (const run of nativeSides) {
    const node: DispatchTreeNode = { id: `run:${JSON.stringify([run.tool, run.runId])}`, parentId: "dispatcher",
      depth: 2, tool: "claude", kind: "sidebranch", run, rows: [], more: 0 };
    add(node, runState(run));
    anchors.set(run.runId, { id: node.id, depth: node.depth });
    addSubagents(run, node.id, node.depth);
  }
  for (const group of rootGroups) {
    const shown = expanded.has(group.tool) ? group.runs : group.visible;
    const single = group.runs.length === 1;
    const executor: DispatchTreeNode = {
      id: `executor:${group.tool}`, parentId: "dispatcher", depth: 2, tool: group.tool,
      kind: "executor", mode: !group.runs.length ? "idle" : single ? "single" : "group",
      run: single ? group.runs[0] : undefined,
      rows: single ? [] : shown.map((run) => ({ id: `row:${JSON.stringify([group.tool, run.runId])}`, run })),
      more: group.more, expanded: expanded.has(group.tool),
    };
    add(executor, group.wireState as DispatchWireState);
    group.runs.forEach((run, index) => {
      const runId = `run:${JSON.stringify([group.tool, run.runId])}`;
      if (!single) add({ id: runId, parentId: executor.rows.find(row => row.run === run)?.id ?? executor.id,
        depth: 3, tool: group.tool, kind: "run", run, rows: [], more: 0 }, runState(run),
        { index, count: group.runs.length });
      const anchor = { id: single ? executor.id : runId, depth: single ? 2 : 3 };
      anchors.set(run.runId, anchor);
      addSubagents(run, anchor.id, anchor.depth);
    });
  }
  // Connect descendants to their actual executor/native child rather than another tool-group root.
  const pending = [...nested];
  for (let pass = 0; pending.length && pass < allRuns.length; pass++) {
    for (let index = pending.length - 1; index >= 0; index--) {
      const run = pending[index]!;
      const parent = dispatchParent(run, allRuns)!;
      const anchor = (run.parent?.sessionId
        ? agentAnchors.get(JSON.stringify([run.parent.agent, run.parent.sessionId])) : undefined) ?? anchors.get(parent.runId);
      if (!anchor) continue;
      const node: DispatchTreeNode = { id: `run:${JSON.stringify([run.tool, run.runId])}`, parentId: anchor.id,
        depth: anchor.depth + 1, tool: run.tool as DispatchTool, kind: "run", run, rows: [], more: 0 };
      add(node, runState(run));
      anchors.set(run.runId, { id: node.id, depth: node.depth });
      addSubagents(run, node.id, node.depth);
      pending.splice(index, 1);
    }
  }
  return { executors, sidebranches, levels, edges };
}

export function dispatchName(run: DispatchRun): string {
  // 没传 --name 时服务端拿执行端名兜底，没信息量；改用派单原文首行（去掉 # 与「工单：」）
  const name = run.name.trim();
  if (name && name !== run.tool) return name;
  const head = (run.promptHead ?? "").split("\n").map((line) => line.replace(/^#+\s*/, "").replace(/^工单[:：]\s*/, "").trim()).find(Boolean);
  return head || name || run.runId.replace(/^\d{8}-\d{6}-(?:codex|kimi|copilot|claude)-/, "") || run.runId;
}

export function dispatchSeconds(run: DispatchRun, now: number): number | null {
  if (run.status === "running") {
    const start = timestamp(run.startedAt);
    return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;
  }
  return run.elapsedS !== null && Number.isFinite(run.elapsedS) ? Math.max(0, Math.floor(run.elapsedS)) : null;
}

export function dispatchTime(seconds: number | null): string {
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor(seconds % 3600 / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}

export function dispatchStatus(status: string): { label: string; className: string } {
  if (status === "running") return { label: t("core.021"), className: "" };
  if (status === "OK") return { label: t("core.022"), className: "finished" };
  if (["TOOL_FAIL", "ACCEPT_FAIL", "TIMEOUT"].includes(status)) return { label: t("core.023"), className: "failed" };
  if (status === "lost") return { label: "lost", className: "failed" };
  return { label: t("core.024"), className: "unknown" };
}

export interface DispatchSessionTitle { id: string; agent?: string; nativeSessionId?: string; title: string; model?: string | null }

export function dispatcherLabel(agent: string): string {
  return ({ claude: "Claude Code", codex: "Codex", kimi: "Kimi", copilot: "Copilot" } as Record<string, string>)[agent] ?? t("core.025");
}

/** Resolve by explicit run ID or matching runtime + native ID, never by task name/cwd/model. */
export function dispatchParent(run: DispatchRun, runs: readonly DispatchRun[]): DispatchRun | undefined {
  const parent = run.parent;
  if (!parent) return undefined;
  return runs.find((item) => item !== run && (parent.runId ? item.runId === parent.runId
    : parent.sessionId && item.tool === parent.agent && (item.session === parent.sessionId
      || item.subagents?.some((child) => child.threadId === parent.sessionId))));
}

/** 同主体会话合并；沿完整记录解析祖先，嵌套派单归属原主体。Copilot 只作执行端。 */
export function dispatchForests(runs: readonly DispatchRun[], _sessions: readonly DispatchSessionTitle[], ancestry: readonly DispatchRun[] = runs) {
  const forests = new Map<string, { id: string; agent: string; title: string; runs: DispatchRun[] }>();
  for (const run of runs) {
    let root = run;
    const seen = new Set([run.runId]);
    for (let parent = dispatchParent(root, ancestry); parent && !seen.has(parent.runId); parent = dispatchParent(root, ancestry)) {
      root = parent; seen.add(parent.runId);
    }
    const source = root.parent;
    const agent = source?.agent;
    if (!agent || !["claude", "codex", "kimi"].includes(agent)) continue;
    const id = agent;
    const forest = forests.get(id) ?? { id, agent, title: dispatcherLabel(agent), runs: [] };
    forest.runs.push(run); forests.set(id, forest);
  }
  return ["claude", "codex", "kimi"].flatMap(agent => {
    const forest = forests.get(agent);
    return forest ? [forest] : [];
  });
}

export function dispatcherModel(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]): string | null {
  const models = new Set<string>();
  for (const run of runs) {
    if (!run.parent) continue;
    const session = sessions.find((item) => (!item.agent || item.agent === run.parent!.agent)
      && (item.id === run.parent!.sessionId || item.nativeSessionId === run.parent!.sessionId));
    const model = session ? session.model : run.parent.model;
    if (model) models.add(modelShortName(model));
  }
  return models.size ? [...models].join(" · ") : null;
}
export function dispatcherSessions(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]) {
  // run.session 是执行端自己的会话；三家派单人身份均在 parent。
  // 同一会话可能同时以工作台 id 和原生 id 出现，按匹配后的 id 去重。
  const sources = new Map<string, { id: string; agent: string; title: string; running: number }>();
  for (const run of runs) {
    const id = run.parent?.sessionId?.trim();
    if (!id) continue;
    const agent = run.parent!.agent;
    const session = sessions.find((item) => (!item.agent || item.agent === agent) && (item.id === id || item.nativeSessionId === id));
    const key = JSON.stringify([agent, session?.id ?? id]);
    const source = sources.get(key) ?? { id: session?.id ?? id, agent,
      title: session?.title || run.parent?.title || t("core.026", { p0: dispatcherLabel(agent), p1: id.slice(0, 8) }), running: 0 };
    if (run.status === "running") source.running++;
    sources.set(key, source);
  }
  return [...sources.values()];
}

export function dispatcherTitle(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]): string {
  return dispatcherSessions(runs, sessions).map((source) => source.title).join("\n") || t("core.025");
}
