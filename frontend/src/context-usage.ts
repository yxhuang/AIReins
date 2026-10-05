import type { AgentKind } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function valid(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 仅接受当前上下文读数，不使用累计 token 或硬编码模型容量。 */
export function contextPercent(agent: AgentKind, payload: unknown): number | null {
  const data = record(payload);
  let used: unknown, size: unknown;
  if (agent === "claude") {
    if (valid(data.percentage)) return Math.min(100, data.percentage);
    used = data.totalTokens;
    size = data.maxTokens;
  } else if (agent === "codex") {
    const usage = record(data.usage);
    used = record(usage.last).totalTokens;
    size = usage.modelContextWindow;
  } else {
    used = data.used;
    size = data.size;
  }
  return valid(used) && valid(size) && size > 0 ? Math.min(100, used / size * 100) : null;
}
