import type { DispatchRun } from "./dispatch-flow";

interface PollingEnvironment {
  visible(): boolean;
  now(): number;
  every(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
  onVisibility(callback: () => void): () => void;
}

export function sessionDispatchInterval(backgroundCount: number, linkCount: number): number {
  return backgroundCount > 0 || linkCount > 0 ? 3000 : 30000;
}

/** 会话派单链接：可动态退避，隐藏页无定时器，重新可见立即查询。 */
export function startSessionDispatchPolling(
  env: PollingEnvironment,
  fetchRuns: (signal: AbortSignal) => Promise<{ dispatches: DispatchRun[] }>,
  onRuns: (runs: DispatchRun[]) => void,
  backgroundCount: () => number,
  initialLinkCount = 0,
): () => void {
  let timer: unknown;
  let request: AbortController | null = null;
  let stopped = false;
  let links = initialLinkCount;
  let interval = 0;
  const schedule = () => {
    const next = sessionDispatchInterval(backgroundCount(), links);
    if (timer !== undefined && next === interval) return;
    if (timer !== undefined) env.cancel(timer);
    interval = next;
    timer = env.every(() => { void poll(); }, next);
  };
  const poll = async () => {
    if (stopped || !env.visible() || request) return;
    const current = new AbortController();
    request = current;
    try {
      const { dispatches } = await fetchRuns(AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]));
      if (request !== current || stopped || !env.visible()) return;
      links = dispatches.length;
      onRuns(dispatches);
    } catch { /* 只读链接错误不打断会话。 */ }
    finally {
      if (request === current) {
        request = null;
        if (!stopped && env.visible()) schedule();
      }
    }
  };
  const visibility = () => {
    if (timer !== undefined) env.cancel(timer);
    timer = undefined;
    request?.abort(); request = null;
    if (stopped || !env.visible()) return;
    schedule();
    void poll();
  };
  const unsubscribe = env.onVisibility(visibility);
  visibility();
  return () => { stopped = true; visibility(); unsubscribe(); };
}

/** 每三秒尝试刷新，慢请求不重叠；隐藏/卸载中止在途请求并丢弃迟到结果。 */
export function startDispatchPolling(
  env: PollingEnvironment,
  fetchRuns: (signal: AbortSignal) => Promise<{ dispatches: DispatchRun[] }>,
  onRuns: (runs: DispatchRun[]) => void,
  onError: (message: string) => void,
  onTick: (now: number) => void,
): () => void {
  let request: AbortController | null = null;
  let pollTimer: unknown;
  let tickTimer: unknown;
  let stopped = false;
  const poll = async () => {
    if (stopped || !env.visible() || request) return;
    const current = new AbortController();
    request = current;
    try {
      const { dispatches } = await fetchRuns(AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]));
      if (request === current && !stopped && env.visible()) {
        onRuns(dispatches);
        onError("");
      }
    } catch (error) {
      if (request === current && !stopped && env.visible()) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === current) request = null;
    }
  };
  const pause = () => {
    if (pollTimer !== undefined) env.cancel(pollTimer);
    if (tickTimer !== undefined) env.cancel(tickTimer);
    pollTimer = tickTimer = undefined;
    request?.abort();
    request = null;
  };
  const visibility = () => {
    pause();
    if (stopped || !env.visible()) return;
    onTick(env.now());
    void poll();
    pollTimer = env.every(() => { void poll(); }, 3000);
    tickTimer = env.every(() => onTick(env.now()), 1000);
  };
  const unsubscribe = env.onVisibility(visibility);
  visibility();
  return () => { stopped = true; pause(); unsubscribe(); };
}
