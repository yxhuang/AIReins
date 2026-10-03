import type { SessionRecord, UnifiedEvent } from "./types.js";

/** Only a new worker lifecycle can supersede an earlier terminal event. */
export function hasTerminalWorkerEvidence(events: UnifiedEvent[]): boolean {
  let ended = false;
  for (const event of events) {
    if (event.type === "session_created"
      || (event.type === "config_updated" && event.payload.workerRestarted === true)) {
      ended = false;
    } else if (event.type === "process_exited"
      || (event.type === "session_error"
        && !(event.payload.severity === "warning" && event.payload.nonBlocking === true))) {
      // Unknown errors stay conservative; an explicitly nonblocking warning does not end a worker.
      ended = true;
    }
  }
  return ended;
}

/** A reboot after every known activity proves that even a legacy worker without a PID is gone. */
export function rebootProvesWorkerGone(
  record: Pick<SessionRecord, "lastActivityAt">,
  events: UnifiedEvent[],
  bootTime: number | undefined,
): boolean {
  if (typeof bootTime !== "number" || !Number.isSafeInteger(bootTime) || bootTime <= 0
    || bootTime > Date.now() || !events.length) return false;
  let latest = 0;
  for (const value of [record.lastActivityAt, ...events.map((event) => event.timestamp)]) {
    // Ambiguous timezone-less or damaged timestamps cannot establish a boot boundary.
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
    latest = Math.max(latest, timestamp);
  }
  return bootTime > latest;
}
