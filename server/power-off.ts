import type { SessionRecord } from "./types.js";

export interface PowerOffStatus {
  state: "idle" | "waiting" | "scheduled";
  busy: number;
  error?: string;
}

/** 比重启的 restartBusyCount 多算 starting：发送前重建 worker、新建会话时短暂处于该状态，不能被当成已完成。 */
export function busySessionCount(sessions: Pick<SessionRecord, "status" | "backgroundTasks">[]): number {
  return sessions.filter((session) => session.status === "running" || session.status === "starting"
    || (session.backgroundTasks?.length ?? 0) > 0).length;
}

/**
 * 关机：空闲即执行，否则轮询到全部会话空闲再执行；run([]) 排定关机，run(["abort"]) 取消。
 * ponytail: 等待状态只在内存，WB 重启即丢失；需要跨重启再落盘。
 */
export function createPowerOff({ busy, run, pollMs = 5000 }: {
  busy: () => number;
  run: (args: string[]) => Promise<unknown>;
  pollMs?: number;
}) {
  let state: PowerOffStatus["state"] = "idle";
  let error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  // 所有操作排队串行：取消一定等前一个排定命令落地再 abort，并发的取消/重新请求看到的都是落定后的状态。
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => undefined);
    return next;
  };
  const stopWaiting = () => { clearInterval(timer); timer = undefined; };
  const status = (): PowerOffStatus => ({ state, busy: busy(), ...(error ? { error } : {}) });
  const fire = async () => {
    stopWaiting();
    state = "scheduled";
    try { await run([]); } catch (reason) {
      state = "idle";
      error = reason instanceof Error ? reason.message : String(reason);
    }
  };
  return {
    status,
    request: () => serial(async (): Promise<PowerOffStatus> => {
      if (state !== "idle") return status();
      error = undefined;
      if (busy() === 0) await fire();
      else {
        state = "waiting";
        timer = setInterval(() => {
          if (busy() === 0) void serial(async () => { if (state === "waiting") await fire(); });
        }, pollMs);
      }
      return status();
    }),
    cancel: () => serial(async (): Promise<PowerOffStatus> => {
      stopWaiting();
      const wasScheduled = state === "scheduled";
      state = "idle";
      error = undefined;
      if (wasScheduled) {
        try { await run(["abort"]); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
      }
      return status();
    }),
  };
}
