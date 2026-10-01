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
  subagents?: DispatchSubagent[];
}

export interface DispatchSubagent {
  threadId: string; nickname: string; role: string | null; depth: number; parentThreadId: string;
  status: "running" | "finished" | "unknown";
  startedAt: string | null; lastActivityAt: string; activity?: string;
}

export const DISPATCH_TOOLS = ["codex", "kimi", "copilot"] as const;
export type DispatchTool = typeof DISPATCH_TOOLS[number];
export const RECENT_DISPATCH_MS = 30 * 60 * 1000;

function timestamp(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

/** 缺失结束时间的 lost从首次观察到非运行态开始计窗口。 */
export function dispatchEnd(run: DispatchRun, observedEnds: ReadonlyMap<string, number>): number {
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
      wireState: items.some((run) => run.status === "running") ? "flow" : items.length ? "finish" : "idle",
    };
  });
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
  return { label: "未知", className: "" };
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
export function dispatcherTitle(runs: readonly DispatchRun[], sessions: readonly DispatchSessionTitle[]): string {
  // run.session 是执行端自己的会话；派单人在 parent（只认 Claude 派出的）
  const ids = [...new Set(runs.map((run) => run.parent?.agent === "claude" ? run.parent.sessionId?.trim() : null).filter((id): id is string => Boolean(id)))];
  // 同一会话可能同时以工作台 id 和原生 id 出现，按匹配后的 id 去重。
  const sources = new Map<string, string>();
  for (const id of ids) {
    const session = sessions.find((item) => item.id === id || item.nativeSessionId === id);
    sources.set(session?.id ?? id, session?.title || `Claude Code 会话 · ${id.slice(0, 8)}`);
  }
  if (sources.size > 1) return `${sources.size} 个会话在派单`;
  return sources.values().next().value ?? "Claude Code 会话";
}
