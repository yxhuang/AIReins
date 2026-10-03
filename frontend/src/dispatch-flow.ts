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
  parent: { agent: string; sessionId: string | null; entrypoint: string | null; model?: string | null; runId?: string } | null;
  promptHead?: string | null;
  agentType?: string | null;
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

/** 缺失结束时间的 lost从首次观察到非运行态开始计窗口。 */
function dispatchEnd(run: DispatchRun, observedEnds: ReadonlyMap<string, number>): number {
  const end = timestamp(run.endedAt);
  if (Number.isFinite(end)) return end;
  const start = timestamp(run.startedAt);
  if (Number.isFinite(start) && run.elapsedS !== null && Number.isFinite(run.elapsedS)) {
    return start + Math.max(0, run.elapsedS) * 1000;
  }
  return observedEnds.get(run.runId) ?? NaN;
}

export function groupDispatches(runs: readonly DispatchRun[], now: number, observedEnds: ReadonlyMap<string, number> = new Map()) {
  return DISPATCH_TOOLS.map((tool) => {
    const items = runs.filter((run) => {
      if (run.tool !== tool) return false;
      if (run.status === "running") return true;
      const end = dispatchEnd(run, observedEnds);
      return Number.isFinite(end) && now - end >= 0 && now - end <= RECENT_DISPATCH_MS;
    }).sort((a, b) => Number(b.status === "running") - Number(a.status === "running")
      || (timestamp(b.startedAt) || 0) - (timestamp(a.startedAt) || 0));
    return {
      tool, runs: items, visible: items.slice(0, 3), more: Math.max(0, items.length - 3),
      wireState: items.some((run) => run.status === "running") ? "flow"
        : items.some((run) => recentWireEnd(dispatchEnd(run, observedEnds), now)) ? "finish" : "idle",
    };
  }).filter((group) => group.tool !== "claude" || group.runs.length > 0);
}

export interface DispatchTreeRow { id: string; run: DispatchRun }
export interface DispatchTreeNode {
  id: string;
  parentId: string;
  depth: number;
  tool: DispatchTool;
  kind: "executor" | "run" | "subagent";
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
  kind: "executor" | "run" | "subagent";
  /** Group-mode run wires: ordered port on the executor card bottom (folded runs keep theirs). */
  port?: { index: number; count: number };
}

interface DispatchBounds { left: number; right: number; top: number; bottom: number }

/** One independent curve per edge; summary rows select ordered ports on the card bottom. */
export function dispatchWirePath(from: DispatchBounds, to: DispatchBounds, row?: { index: number; count: number }): string {
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
  expanded: ReadonlySet<string> = new Set(), observedEnds: ReadonlyMap<string, number> = new Map()) {
  const executors: DispatchTreeNode[] = [];
  const levels: DispatchTreeNode[][] = [executors];
  const edges: DispatchTreeEdge[] = [];
  const add = (node: DispatchTreeNode, state: DispatchWireState, port?: DispatchTreeEdge["port"]) => {
    (levels[node.depth - 2] ??= []).push(node);
    edges.push({ from: node.parentId, to: node.id, tool: node.tool, state, kind: node.kind, ...(port && { port }) });
  };
  for (const group of groups) {
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
    // 第二层摘要超过 3 行只折叠摘要行；第三层及以下始终完整，折叠行的块从执行端卡片底部连出。
    group.runs.forEach((run, index) => {
      const runId = `run:${JSON.stringify([group.tool, run.runId])}`;
      if (!single) add({ id: runId, parentId: executor.rows.find(row => row.run === run)?.id ?? executor.id,
        depth: 3, tool: group.tool, kind: "run", run, rows: [], more: 0 },
        run.status === "running" ? "flow" : recentWireEnd(dispatchEnd(run, observedEnds), now) ? "finish" : "idle",
        { index, count: group.runs.length });
      const rootId = single ? executor.id : runId;
      const rootDepth = single ? 2 : 3;
      const children = new Map<string, DispatchSubagent[]>();
      for (const agent of run.subagents ?? []) {
        const parent = agent.parentThreadId;
        const siblings = children.get(parent) ?? [];
        siblings.push(agent); children.set(parent, siblings);
      }
      // Without a native session, only explicit first-depth records provide a root hint.
      const roots = run.session ? [run.session]
        : [...new Set((run.subagents ?? []).filter(agent => agent.depth === 1).map(agent => agent.parentThreadId))];
      const seen = new Set(roots);
      const queue = roots.map(threadId => ({ threadId, id: rootId, depth: rootDepth }));
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index]!;
        for (const agent of children.get(parent.threadId) ?? []) {
          if (seen.has(agent.threadId)) continue;
          seen.add(agent.threadId);
          const node: DispatchTreeNode = { id: `subagent:${JSON.stringify([run.runId, agent.threadId])}`,
            parentId: parent.id, depth: parent.depth + 1, tool: group.tool, kind: "subagent",
            runId: run.runId, subagent: agent, rows: [], more: 0 };
          add(node, subagentWireState(agent, now));
          queue.push({ threadId: agent.threadId, id: node.id, depth: node.depth });
        }
      }
    });
  }
  return { executors, levels, edges };
}

export function dispatchName(run: DispatchRun): string {
  // 没传 --name 时服务端拿执行端名兜底，没信息量；改用派单原文首行（去掉 # 与「工单：」）
  const name = run.name.trim();
  if (name && name !== run.tool) return name;
  const head = (run.promptHead ?? "").split("\n").map((line) => line.replace(/^#+\s*/, "").replace(/^工单[:：]\s*/, "").trim()).find(Boolean);
  return head || name || run.runId.replace(/^\d{8}-\d{6}-(?:codex|kimi|copilot)-/, "") || run.runId;
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
  if (status === "running") return { label: "运行中", className: "" };
  if (status === "OK") return { label: "刚完成 ✓", className: "finished" };
  if (["TOOL_FAIL", "ACCEPT_FAIL", "TIMEOUT"].includes(status)) return { label: "失败 ✗", className: "failed" };
  if (status === "lost") return { label: "lost", className: "failed" };
  return { label: "未知", className: "unknown" };
}

export interface DispatchSessionTitle { id: string; nativeSessionId?: string; title: string; model?: string | null }

export function dispatcherModel(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]): string | null {
  const models = new Set<string>();
  for (const run of runs) {
    if (run.parent?.agent !== "claude") continue;
    const session = sessions.find((item) => item.nativeSessionId === run.parent!.sessionId);
    const model = session ? session.model : run.parent.model;
    if (model) models.add(modelShortName(model));
  }
  return models.size ? [...models].join(" · ") : null;
}
export function dispatcherSessions(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]) {
  // run.session 是执行端自己的会话；派单人在 parent（只认 Claude 派出的）
  // 同一会话可能同时以工作台 id 和原生 id 出现，按匹配后的 id 去重。
  const sources = new Map<string, { id: string; title: string; running: number }>();
  for (const run of runs) {
    const id = run.parent?.agent === "claude" ? run.parent.sessionId?.trim() : null;
    if (!id) continue;
    const session = sessions.find((item) => item.id === id || item.nativeSessionId === id);
    const key = session?.id ?? id;
    const source = sources.get(key) ?? { id: key, title: session?.title || `Claude Code 会话 · ${id.slice(0, 8)}`, running: 0 };
    if (run.status === "running") source.running++;
    sources.set(key, source);
  }
  return [...sources.values()];
}

export function dispatcherTitle(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]): string {
  return dispatcherSessions(runs, sessions).map((source) => source.title).join("\n") || "Claude Code 会话";
}
