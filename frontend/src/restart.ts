import type { SessionRecord } from "./types";

/** 与托盘 Exit-Workbench 相同：同一会话同时 running / 有后台任务只计一次。 */
export function restartBusyCount(sessions: Pick<SessionRecord, "status" | "backgroundTasks">[]): number {
  return sessions.filter((session) => session.status === "running" || (session.backgroundTasks?.length ?? 0) > 0).length;
}

interface ConnectionSource {
  wsState: string;
  subscribe(listener: () => void): () => void;
}

/** 先订阅再发 POST，覆盖断线早于 202 被处理的竞态；旧 open 不能算恢复。 */
export function restartAndReconnect(
  source: ConnectionSource,
  request: () => Promise<unknown>,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let disconnected = false;
    let accepted = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (source.wsState !== "open") disconnected = true;
      if (accepted && disconnected && source.wsState === "open") finish();
    };
    const abort = () => finish(new Error("重启等待已取消"));
    const unsubscribe = source.subscribe(check);
    const timer = setTimeout(() => finish(new Error("60 秒内未恢复连接")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    request().then(() => {
      accepted = true;
      check();
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
