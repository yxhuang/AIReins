import type { DispatchRun } from "./dispatch-flow";
import type { DispatchOverview } from "./types";

interface PollingEnvironment {
  visible(): boolean;
  every(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
  onVisibility(callback: () => void): () => void;
}

export function sessionDispatchInterval(busy: boolean, linkCount: number): number {
  return busy || linkCount > 0 ? 3000 : 30000;
}

/** 会话派单链接：可动态退避，隐藏页无定时器，重新可见立即查询。 */
export function startSessionDispatchPolling(
  env: PollingEnvironment,
  fetchRuns: (signal: AbortSignal) => Promise<{ dispatches: DispatchRun[] }>,
  onRuns: (runs: DispatchRun[]) => void,
  busy: () => boolean,
  initialLinkCount = 0,
): () => void {
  let timer: unknown;
  let request: AbortController | null = null;
  let stopped = false;
  let links = initialLinkCount;
  let interval = 0;
  const schedule = () => {
    const next = sessionDispatchInterval(busy(), links);
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

/** 全局派单每三秒刷新，隐藏/卸载时中止在途请求。 */
export function startDispatchPolling(
  env: PollingEnvironment,
  fetchOverview: (signal: AbortSignal) => Promise<DispatchOverview>,
  onOverview: (overview: DispatchOverview) => void,
  onError: (message: string) => void,
): () => void {
  let request: AbortController | null = null;
  let pollTimer: unknown;
  let stopped = false;
  const poll = async () => {
    if (stopped || !env.visible() || request) return;
    const current = new AbortController();
    request = current;
    try {
      const overview = await fetchOverview(AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]));
      if (request === current && !stopped && env.visible()) {
        onOverview(overview);
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
    pollTimer = undefined;
    request?.abort();
    request = null;
  };
  const visibility = () => {
    pause();
    if (stopped || !env.visible()) return;
    void poll();
    pollTimer = env.every(() => { void poll(); }, 3000);
  };
  const unsubscribe = env.onVisibility(visibility);
  visibility();
  return () => { stopped = true; pause(); unsubscribe(); };
}
