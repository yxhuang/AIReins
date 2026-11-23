import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, sep } from "node:path";
import { NativeConversationReader, nativeReplayPath, type ReplaySession } from "./native-conversation.js";
import { indexTranscriptLines, openTranscriptInput, rewriteArchivedTranscript, sameVersion, transcriptLines } from "./transcript-archive.js";
import { AGENTS, type SessionRecord, type UnifiedEvent } from "./types.js";

const MIN_TOKEN_BYTES = 4096;
const MAX_TOKEN_BYTES = 32 * 1024 ** 2;
const MAX_SOURCE_BYTES = 128 * 1024 ** 2;
const tailMarker = Buffer.from('{"_wbSkippedTail":');
const reader = new NativeConversationReader();
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
type Location = { offset: number; bytes: number; hash: string };
type Reference = Location & { keys: string[] };
type Replay = ReplaySession & { length: number; refs: Reference[] };
type ReplayFile = { fd: number; size: number; relocated?: Map<string, Location> };
export type StoredTranscriptEvent = UnifiedEvent & { _wbNativeReplay?: Replay };

/** Tokens are matched in their exact serialized form, including JSON escapes. */
function indexTokens(line: Buffer, offset: number, locations: Map<string, Location>): void {
  if (line.length < MIN_TOKEN_BYTES || line.at(-1) !== 10) return;
  let start = -1;
  for (let quote = line.indexOf(34); quote !== -1; quote = line.indexOf(34, quote + 1)) {
    if (start !== -1) {
      let back = quote - 1;
      while (line[back] === 92) back--;
      if ((quote - back - 1) % 2) continue;
      const bytes = quote - start + 1;
      if (bytes >= MIN_TOKEN_BYTES && bytes <= MAX_TOKEN_BYTES) {
        const hash = digest(line.subarray(start, quote + 1));
        locations.set(hash, { offset: offset + start, bytes, hash });
      }
      start = -1;
    } else start = quote;
  }
}

function detachPayload(event: StoredTranscriptEvent, locations: ReadonlyMap<string, Location>, uploadPrefix: string): Reference[] {
  const refs: Reference[] = [];
  function visit(value: unknown, keys: string[]): void {
    if (typeof value === "string") {
      if (value.length < MIN_TOKEN_BYTES / 4 || value.length > MAX_TOKEN_BYTES || value.includes(uploadPrefix)) return;
      const buffer = Buffer.from(JSON.stringify(value));
      if (buffer.length < MIN_TOKEN_BYTES || buffer.length > MAX_TOKEN_BYTES) return;
      const position = locations.get(digest(buffer));
      if (!position) return;
      refs.push({ ...position, keys });
      replacePayloadValue(event, keys, "");
    } else if (value && typeof value === "object" && keys.length < 32) {
      for (const [key, next] of Object.entries(value)) visit(next, [...keys, key]);
    }
  }
  // Preserve the local tool wrapper, call identity, original metadata, and every unique field.
  switch (event.type) {
    case "tool_call_completed":
    case "tool_call_updated":
      for (const key of ["result", "content"]) visit(event.payload[key], [key]);
      break;
    case "agent_text_delta":
    case "thought_delta":
      visit(event.payload.text, ["text"]);
      break;
  }
  return refs;
}

function replacePayloadValue(event: UnifiedEvent, keys: string[], value: string): boolean {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32 || keys.some(key => typeof key !== "string")) return false;
  let item = event.payload;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(item, key) || !item[key] || typeof item[key] !== "object") return false;
    item = item[key] as typeof item;
  }
  const key = keys.at(-1)!;
  if (!Object.hasOwn(item, key) || typeof item[key] !== "string") return false;
  item[key] = value;
  return true;
}

export async function reclaimNativePayloads(session: SessionRecord, workbenchHome: string, mayReplace: () => boolean): Promise<number> {
  const nativePath = nativeReplayPath(reader, session);
  if (!nativePath) return 0;
  const before = lstatSync(nativePath);
  if (!before.isFile() || before.size > MAX_SOURCE_BYTES || before.size < MIN_TOKEN_BYTES) return 0;
  const input = openTranscriptInput(nativePath);
  const locations = new Map<string, Location>();
  try {
    if (input.archived || !await indexTranscriptLines(input, (line, offset) => indexTokens(line, offset, locations), mayReplace)) return 0;
  } finally { input.close(); }
  if (!locations.size || !sameVersion(before, nativePath)) return 0;
  const source: ReplaySession = { agent: session.agent, nativeSessionId: session.nativeSessionId, nativeTranscriptPath: nativePath };
  const uploadPrefix = `${join(workbenchHome, "uploads")}${sep}`;
  let unsafeLine = false;
  return rewriteArchivedTranscript(session.transcriptPath, line => {
    if (line.at(-1) !== 10 || line.subarray(0, tailMarker.length).equals(tailMarker)) unsafeLine = true;
    if (unsafeLine || line.length < MIN_TOKEN_BYTES) return undefined;
    let event: StoredTranscriptEvent;
    try { event = JSON.parse(line.toString("utf8")) as StoredTranscriptEvent; } catch { return undefined; }
    if (!event?.payload || event._wbNativeReplay) return undefined;
    const refs = detachPayload(event, locations, uploadPrefix);
    if (!refs.length) return undefined;
    event._wbNativeReplay = { ...source, length: line.length, refs };
    return Buffer.from(`${JSON.stringify(event)}\n`);
  }, () => !unsafeLine && mayReplace() && sameVersion(before, nativePath));
}

/** Resolves only the requested payload slices. A missing source leaves the local event visible. */
export class NativePayloadReplay {
  private readonly handles = new Map<string, ReplayFile | undefined>();

  close(): void {
    for (const file of this.handles.values()) if (file) closeSync(file.fd);
    this.handles.clear();
  }

  restore(event: StoredTranscriptEvent): UnifiedEvent {
    const replay = event._wbNativeReplay;
    if (!replay) return event;
    delete event._wbNativeReplay;
    const file = this.fileFor(replay);
    if (!file || !Array.isArray(replay.refs)) {
      event.nativePayloadUnavailable = true;
      return event;
    }
    for (const ref of replay.refs) {
      const value = ref?.hash ? this.read(file, ref) ?? this.relocate(file, ref.hash) : undefined;
      if (value === undefined || !replacePayloadValue(event, ref.keys, value)) event.nativePayloadUnavailable = true;
    }
    return event;
  }

  private fileFor(replay: ReplaySession): ReplayFile | undefined {
    if (!AGENTS.includes(replay.agent) || typeof replay.nativeSessionId !== "string"
      || (replay.nativeTranscriptPath !== undefined && typeof replay.nativeTranscriptPath !== "string")) return undefined;
    const key = `${replay.agent}:${replay.nativeSessionId}`;
    if (!this.handles.has(key)) {
      let fd: number | undefined;
      try {
        const path = nativeReplayPath(reader, replay);
        if (path) {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (stat.isFile()) {
            this.handles.set(key, { fd, size: stat.size });
            return this.handles.get(key);
          }
        }
      } catch { /* The provider may be temporarily offline. */ }
      if (fd !== undefined) closeSync(fd);
      this.handles.set(key, undefined);
    }
    return this.handles.get(key);
  }

  private relocate(file: ReplayFile, hash: string): string | undefined {
    if (file.size > MAX_SOURCE_BYTES) return undefined;
    if (!file.relocated) {
      file.relocated = new Map();
      try {
        for (const { bytes, offset } of transcriptLines(file.fd)) indexTokens(bytes, offset, file.relocated);
      } catch { return undefined; }
    }
    const location = file.relocated.get(hash);
    return location && this.read(file, location);
  }

  private read(file: ReplayFile, ref: Location): string | undefined {
    if (!ref || !Number.isSafeInteger(ref.offset) || !Number.isSafeInteger(ref.bytes)
      || ref.offset < 0 || ref.bytes < MIN_TOKEN_BYTES || ref.bytes > MAX_TOKEN_BYTES || ref.offset + ref.bytes > file.size) return undefined;
    try {
      const bytes = Buffer.allocUnsafe(ref.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(file.fd, bytes, offset, bytes.length - offset, ref.offset + offset);
        if (!count) return undefined;
        offset += count;
      }
      if (digest(bytes) !== ref.hash) return undefined;
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
