import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionRecord } from "./types.js";

export function powerOffEnabled(command?: string): boolean {
  if (!command || !isAbsolute(command)) return false;
  try {
    accessSync(command, constants.X_OK);
    return statSync(command).isFile();
  } catch { return false; }
}

export interface PowerOffStatus {
  state: "idle" | "waiting" | "scheduled";
  busy: number;
  /** scheduled 且命令已落地时：距 Windows 关机的剩余毫秒（客户端据此倒计时，不依赖两端时钟一致）。 */
  remainingMs?: number;
  error?: string;
}

/** 比重启的 restartBusyCount 多算 starting：发送前重建 worker、新建会话时短暂处于该状态，不能被当成已完成。 */
export function busySessionCount(sessions: Pick<SessionRecord, "status" | "backgroundTasks" | "activeDispatchCount">[]): number {
  return sessions.filter((session) => session.status === "running" || session.status === "starting"
    || (session.backgroundTasks?.length ?? 0) > 0 || (session.activeDispatchCount ?? 0) > 0).length;
}

/**
 * 关机：空闲即执行，否则轮询到全部会话空闲再执行；run([]) 排定关机（delayMs 后生效），run(["abort"]) 取消。
 * 过了生效时刻 graceMs 还活着，说明关机没发生（如在 Windows 侧被取消），回到 idle 并带错误。
 * ponytail: 等待状态只在内存，AIReins 重启即丢失；需要跨重启再落盘。
 */
export function createPowerOff({ busy, checkBusy, prepare, run, pollMs = 5000, delayMs = 60_000, graceMs = 60_000, now = Date.now }: {
  busy: () => number;
  /** 实际排定关机前的新鲜异步检查（可绕过缓存）；失败时保守按繁忙处理不放行。 */
  checkBusy?: () => Promise<number>;
  /** 排定系统关机前的异步准备（如释放空闲 worker 并刷盘）；失败不阻断关机，期间取消或新忙会话会中止本次排定。 */
  prepare?: (isCancelled: () => boolean) => Promise<void>;
  run: (args: string[]) => Promise<unknown>;
  pollMs?: number;
  delayMs?: number;
  graceMs?: number;
  now?: () => number;
}) {
  let state: PowerOffStatus["state"] = "idle";
  let error: string | undefined;
  let deadline: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let preparation: AbortController | undefined;
  // 所有操作排队串行：取消一定等前一个排定命令落地再 abort，并发的取消/重新请求看到的都是落定后的状态。
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => undefined);
    return next;
  };
  const stopWaiting = () => { clearInterval(timer); timer = undefined; };
  const liveBusy = async (): Promise<number> => {
    if (!checkBusy) return busy();
    try { return await checkBusy(); }
    catch { return Math.max(1, busy()); }
  };
  const status = (): PowerOffStatus => {
    if (state === "scheduled" && deadline !== undefined && now() > deadline + graceMs) {
      state = "idle";
      deadline = undefined;
      error = "已过关机时刻仍未关机，可能已在 Windows 侧取消";
    }
    const remainingMs = state === "scheduled" && deadline !== undefined ? Math.max(0, deadline - now()) : undefined;
    return { state, busy: busy(), ...(remainingMs !== undefined ? { remainingMs } : {}), ...(error ? { error } : {}) };
  };
  const startWaiting = () => {
    state = "waiting";
    if (timer) return;
    timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void serial(async () => {
        try {
          if (state === "waiting" && await liveBusy() === 0) await fire();
        } finally { polling = false; }
      });
    }, pollMs);
  };
  const fire = async () => {
    stopWaiting();
    if (prepare) {
      state = "waiting";
      preparation = new AbortController();
      const { signal } = preparation;
      try {
        try { await prepare(() => signal.aborted); } catch { /* Preparation is best effort. */ }
        if (signal.aborted) { state = "idle"; return; }
        const busyAfterPrepare = await liveBusy();
        if (signal.aborted) { state = "idle"; return; }
        if (busyAfterPrepare > 0 || busy() > 0) { startWaiting(); return; }
      } finally {
        preparation = undefined;
      }
    }
    state = "scheduled";
    deadline = undefined;
    try {
      await run([]);
      deadline = now() + delayMs;
    } catch (reason) {
      state = "idle";
      error = reason instanceof Error ? reason.message : String(reason);
    }
  };
  return {
    status,
    request: () => serial(async (): Promise<PowerOffStatus> => {
      if (state !== "idle") return status();
      error = undefined;
      if (await liveBusy() === 0) await fire();
      else startWaiting();
      return status();
    }),
    cancel: () => {
      preparation?.abort();
      return serial(async (): Promise<PowerOffStatus> => {
        stopWaiting();
        const wasScheduled = state === "scheduled";
        state = "idle";
        deadline = undefined;
        error = undefined;
        if (wasScheduled) {
          try { await run(["abort"]); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
        }
        return status();
      });
    },
  };
}
