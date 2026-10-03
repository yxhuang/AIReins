import { readFileSync } from "node:fs";
import type { SessionRecord, WorkerProcessIdentity } from "./types.js";

const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Wall-clock boot time in milliseconds; no uptime estimate or filesystem timestamp fallback. */
export function readSystemBootTime(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const lines = readFileSync("/proc/stat", "utf8").split(/\r?\n/)
      .filter((line) => /^btime(?:\s|$)/.test(line));
    if (lines.length !== 1) return undefined;
    const match = /^btime[ \t]+(\d+)$/.exec(lines[0]!);
    if (!match) return undefined;
    const milliseconds = Number(match[1]) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= Date.now()
      ? milliseconds : undefined;
  } catch { return undefined; }
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

function bootId(): string {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!BOOT_ID.test(value)) throw new Error("Invalid Linux boot identity");
  return value.toLowerCase();
}

/** Linux start time is stable across exec(), unlike executable names and argv. */
export function captureWorkerIdentity(pid?: number): WorkerProcessIdentity | undefined {
  if (process.platform !== "linux" || !validPid(pid)) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parentheses; fields after its final ')' begin with state.
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^\d+$/.test(startTime)) return undefined;
    const group = Number(fields[2]);
    return { bootId: bootId(), startTime, ...(group === pid ? { processGroupId: group } : {}) };
  } catch { return undefined; }
}

function liveness(pid: number): "gone" | "alive" | "unknown" {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}

/** Positive proof only: EPERM, an unknown identity, and a surviving process group block recovery. */
export function oldWorkerGone(record: Pick<SessionRecord, "processId" | "processIdentity">): boolean {
  const pid = record.processId;
  if (!validPid(pid)) return false;
  const identity = record.processIdentity;
  if (identity !== undefined) {
    if (!identity || process.platform !== "linux" || typeof identity.bootId !== "string"
      || !BOOT_ID.test(identity.bootId) || typeof identity.startTime !== "string"
      || !/^\d+$/.test(identity.startTime)
      || (identity.processGroupId !== undefined && identity.processGroupId !== pid)) return false;
    try {
      // After a reboot every member of the old worker's process tree is gone, even if PID was reused.
      if (bootId() !== identity.bootId.toLowerCase()) return true;
    } catch { return false; }
  }
  const state = liveness(pid);
  if (state === "unknown") return false;
  if (state === "gone") return !identity?.processGroupId || liveness(-identity.processGroupId) === "gone";
  if (!identity?.processGroupId) return false;
  const current = captureWorkerIdentity(pid);
  // PID reuse alone does not exclude launcher descendants. Also require the owned group to be gone.
  return Boolean(current && current.bootId === identity.bootId.toLowerCase() && current.startTime !== identity.startTime
    && liveness(-identity.processGroupId) === "gone");
}
