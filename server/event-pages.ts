import type { SessionSnapshotState, UnifiedCommand, UnifiedEvent } from "./types.js";

export const EVENT_PAGE_MAX_TURNS = 30;
export const EVENT_PAGE_MAX_JSON_BYTES = 1.5 * 1024 * 1024;

export interface EventPage {
  events: UnifiedEvent[];
  hasMore: boolean;
  firstSeq: number;
}

interface Span { start: number; end: number; open: boolean }
export class InvalidEventPageCursor extends Error {}

/** Only user turn starts outside every tool/gate lifetime are safe page cuts. */
export function selectEventPage(events: UnifiedEvent[], beforeSeq?: number): EventPage {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) {
    throw new InvalidEventPageCursor("beforeSeq 必须是正安全整数");
  }
  const end = beforeSeq === undefined ? events.length : events.findIndex((event) => event.seq >= beforeSeq);
  const limit = end < 0 ? events.length : end;
  if (!limit) return { events: [], hasMore: false, firstSeq: 0 };
  const spans: Span[] = [];
  const tools = new Map<string, Span>();
  const gates = new Map<string, Span>();
  const turns: number[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "user_message" && event.payload.steer !== true) turns.push(index);
    if (event.type === "tool_call_started" || event.type === "permission_request") {
      const tool = event.type === "tool_call_started";
      const map = tool ? tools : gates;
      const id = String(tool ? event.payload.toolCallId ?? event.seq : event.payload.requestId ?? "");
      const span = { start: index, end: index, open: true };
      spans.push(span);
      map.set(id, span);
    } else if (event.type === "tool_call_updated" || event.type === "tool_call_completed" || event.type === "permission_resolved") {
      const tool = event.type !== "permission_resolved";
      const span = (tool ? tools : gates).get(String(tool ? event.payload.toolCallId ?? "" : event.payload.requestId ?? ""));
      if (span) {
        span.end = index;
        if (event.type !== "tool_call_updated") span.open = false;
      }
    }
  }
  // Keep completed tools in the map: later updates still address their original view.
  // process_exited does not remove tools from render-items, so it cannot end a span.
  const blocked = new Int32Array(events.length + 2);
  for (const span of spans) {
    const last = span.open ? events.length - 1 : span.end;
    blocked[span.start + 1]!++;
    blocked[last + 1]!--;
  }
  const turnSet = new Set(turns.slice(1)); // Prelude belongs with the first user turn.
  const starts = [0];
  let active = 0;
  for (let index = 0; index <= limit && index < events.length; index++) {
    active += blocked[index]!;
    const safe = index > 0 && active === 0 && turnSet.has(index);
    if (index === limit) {
      if (!safe || events[index]!.seq !== beforeSeq) {
        throw new InvalidEventPageCursor("beforeSeq 必须为可安全分页的用户回合起点（使用上一响应的 firstSeq）");
      }
    } else if (safe) starts.push(index);
  }
  const bytes = new Float64Array(limit + 1);
  const counts = new Int32Array(limit + 1);
  for (let index = 0; index < limit; index++) {
    const event = events[index]!;
    bytes[index + 1] = bytes[index]! + Buffer.byteLength(JSON.stringify(event)) + 1;
    counts[index + 1] = counts[index]! + (event.type === "user_message" && event.payload.steer !== true ? 1 : 0);
  }
  // Always include the last indivisible segment, even when it exceeds either cap.
  let start = starts.at(-1)!;
  for (let index = starts.length - 2; index >= 0; index--) {
    const candidate = starts[index]!;
    if (counts[limit]! - counts[candidate]! > EVENT_PAGE_MAX_TURNS
      || bytes[limit]! - bytes[candidate]! + 1 > EVENT_PAGE_MAX_JSON_BYTES) break;
    start = candidate;
  }
  const page = events.slice(start, limit);
  return { events: page, hasMore: start > 0, firstSeq: page[0]!.seq };
}

/** Session-wide reducers must see the complete transcript, independently of paging. */
export function snapshotState(events: UnifiedEvent[]): SessionSnapshotState {
  let latestUsage: Record<string, unknown> | undefined;
  let commands: UnifiedCommand[] = [];
  let configSwitching: string | undefined;
  let promptCacheUsageAt: number | null = null;
  let promptCacheTtlMs: number | null = null;
  for (const event of events) {
    if (event.type === "usage_updated") latestUsage = event.payload;
    else if (event.type === "commands_updated") commands = Array.isArray(event.payload.commands) ? event.payload.commands as UnifiedCommand[] : [];
    else if (event.type === "config_update_started") {
      const message = event.payload.message;
      configSwitching = typeof message === "string" && message ? message : "正在切换配置…";
    } else if (event.type === "config_updated" || event.type === "session_error") configSwitching = undefined;
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "usage_updated") continue;
    promptCacheUsageAt ??= Date.parse(event.timestamp);
    if (Number.isNaN(promptCacheUsageAt)) { promptCacheUsageAt = null; break; }
    const usage = record(event.payload.usage);
    const created = record(usage.cache_creation);
    if (Number(created.ephemeral_1h_input_tokens) > 0) { promptCacheTtlMs = 60 * 60_000; break; }
    if (Number(created.ephemeral_5m_input_tokens) > 0) { promptCacheTtlMs = 5 * 60_000; break; }
  }
  return { latestUsage, commands, configSwitching, promptCacheTtlMs, promptCacheUsageAt };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Incremental safe cuts. A late update revokes every cut after its original start. */
export class EventPageIndex {
  readonly events: UnifiedEvent[] = [];
  private seqs: number[] = [];
  private spanIdBytes = 0;
  private stateBytes = 0;
  constructor(private retainEvents = true) {}
  // Charge 256B/event for numeric arrays (including persistence offsets), map
  // objects and array spare capacity; charge retained strings/state at 8x JSON.
  get accountedBytes(): number { return 1024 + this.seqs.length * 256 + this.spanIdBytes * 8 + this.stateBytes * 8; }
  private starts = [0];
  private bytes = [0];
  private counts = [0];
  private tools = new Map<string, { start: number; open: boolean }>();
  private gates = new Map<string, { start: number; open: boolean }>();
  private active = 0;
  private seqCeilings: number[] = [];
  private usageTtl: number | null = null;
  readonly state: SessionSnapshotState = { latestUsage: undefined, commands: [], configSwitching: undefined, promptCacheTtlMs: null, promptCacheUsageAt: null };

  append(event: UnifiedEvent): void {
    const index = this.seqs.length;
    const user = event.type === "user_message" && event.payload.steer !== true;
    if (user && this.counts[index]! > 0 && this.active === 0) this.starts.push(index);
    if (event.type === "tool_call_started" || event.type === "permission_request") {
      const tool = event.type === "tool_call_started";
      const id = String(tool ? event.payload.toolCallId ?? event.seq : event.payload.requestId ?? "");
      const map = tool ? this.tools : this.gates;
      if (!map.has(id)) this.spanIdBytes += Buffer.byteLength(id);
      map.set(id, { start: index, open: true });
      this.active++;
    } else if (event.type === "tool_call_updated" || event.type === "tool_call_completed" || event.type === "permission_resolved") {
      const tool = event.type !== "permission_resolved";
      const span = (tool ? this.tools : this.gates).get(String(tool ? event.payload.toolCallId ?? "" : event.payload.requestId ?? ""));
      if (span) {
        // Starts never survive a crossing span; removed starts cost only once.
        this.starts.length = upperBound(this.starts, span.start);
        if (event.type !== "tool_call_updated" && span.open) { span.open = false; this.active--; }
      }
    }
    this.seqCeilings.push(Math.max(this.seqCeilings.at(-1) ?? -Infinity, event.seq));
    this.seqs.push(event.seq);
    if (this.retainEvents) this.events.push(event);
    this.bytes.push(this.bytes[index]! + Buffer.byteLength(JSON.stringify(event)) + 1);
    this.counts.push(this.counts[index]! + Number(user));
    if (event.type === "usage_updated") {
      this.state.latestUsage = event.payload;
      const at = Date.parse(event.timestamp);
      this.state.promptCacheUsageAt = Number.isNaN(at) ? null : at;
      const created = record(record(event.payload.usage).cache_creation);
      if (Number(created.ephemeral_1h_input_tokens) > 0) this.usageTtl = 60 * 60_000;
      else if (Number(created.ephemeral_5m_input_tokens) > 0) this.usageTtl = 5 * 60_000;
      this.state.promptCacheTtlMs = Number.isNaN(at) ? null : this.usageTtl;
    } else if (event.type === "commands_updated") this.state.commands = Array.isArray(event.payload.commands) ? event.payload.commands as UnifiedCommand[] : [];
    else if (event.type === "config_update_started") this.state.configSwitching = typeof event.payload.message === "string" && event.payload.message ? event.payload.message : "正在切换配置…";
    else if (event.type === "config_updated" || event.type === "session_error") this.state.configSwitching = undefined;
    if (["usage_updated", "commands_updated", "config_update_started", "config_updated", "session_error"].includes(event.type)) this.stateBytes = Buffer.byteLength(JSON.stringify(this.state));
  }

  page(beforeSeq?: number): EventPage {
    const { start, limit } = this.range(beforeSeq);
    return { events: this.events.slice(start, limit), hasMore: start > 0, firstSeq: start < limit ? this.seqs[start]! : 0 };
  }

  range(beforeSeq?: number): { start: number; limit: number } {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) throw new InvalidEventPageCursor("beforeSeq 必须是正安全整数");
    let limit = this.seqs.length;
    if (beforeSeq !== undefined) {
      // Prefix maxima preserve the original first-match cursor semantics even
      // for duplicate/out-of-order seq, without a linear search.
      let lo = 0, hi = limit;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.seqCeilings[mid]! < beforeSeq) lo = mid + 1; else hi = mid; }
      limit = lo;
    }
    if (!limit) return { start: 0, limit: 0 };
    const last = upperBound(this.starts, limit - 1) - 1;
    if (limit < this.seqs.length && (this.seqs[limit]! !== beforeSeq || this.starts[upperBound(this.starts, limit) - 1] !== limit)) {
      throw new InvalidEventPageCursor("beforeSeq 必须为可安全分页的用户回合起点（使用上一响应的 firstSeq）");
    }
    let lo = 0, hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, candidate = this.starts[mid]!;
      if (this.counts[limit]! - this.counts[candidate]! > EVENT_PAGE_MAX_TURNS || this.bytes[limit]! - this.bytes[candidate]! + 1 > EVENT_PAGE_MAX_JSON_BYTES) lo = mid + 1;
      else hi = mid;
    }
    const start = this.starts[lo]!;
    return { start, limit };
  }
}

function upperBound(values: number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! <= value) lo = mid + 1; else hi = mid; }
  return lo;
}
