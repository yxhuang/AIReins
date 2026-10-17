import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  fstatSync,
  fchmodSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { EventPageIndex } from "./event-pages.js";
import { normalizeProjectPath } from "../shared/project-path.js";
import { sessionTitle } from "../shared/session-title.js";
import { log } from "./logger.js";
import type { SessionRecord, UnifiedEvent } from "./types.js";

export const workbenchHome = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");
export const registryPath = join(workbenchHome, "sessions.json");
export const projectOrderPath = join(workbenchHome, "project-order.json");
const transcriptsDir = join(workbenchHome, "transcripts");

function ensureStorage(): void {
  mkdirSync(transcriptsDir, { recursive: true });
}

export function loadRegistry(): SessionRecord[] {
  ensureStorage();
  if (!existsSync(registryPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${registryPath} 必须是 JSON 数组`);
  return parsed as SessionRecord[];
}

export function saveRegistry(sessions: SessionRecord[]): void {
  ensureStorage();
  const temporary = `${registryPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPath);
}

export const PROJECT_ORDER_LIMIT = 500;

export function loadProjectOrder(sessions: SessionRecord[]): string[] {
  ensureStorage();
  if (!existsSync(projectOrderPath)) {
    const latest = new Map<string, string>();
    for (const session of sessions) {
      const path = normalizeProjectPath(session.cwd);
      if (!latest.has(path) || session.createdAt > latest.get(path)!) latest.set(path, session.createdAt);
    }
    const paths = [...latest].sort((a, b) => b[1].localeCompare(a[1])).map(([path]) => path).slice(0, PROJECT_ORDER_LIMIT);
    saveProjectOrder(paths);
    return paths;
  }
  const parsed: unknown = JSON.parse(readFileSync(projectOrderPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.some(path => typeof path !== "string" || !path.startsWith("/") || path.length > 4096 || path.includes("\0"))) {
    throw new Error(`${projectOrderPath} 必须是绝对路径 JSON 数组`);
  }
  return [...new Set(parsed.map(normalizeProjectPath))].slice(0, PROJECT_ORDER_LIMIT);
}

export function saveProjectOrder(paths: string[]): void {
  ensureStorage();
  const temporary = `${projectOrderPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(paths.slice(0, PROJECT_ORDER_LIMIT), null, 2)}\n`, { mode: 0o600 });
  // 既有 tmp 文件也要收紧权限，避免被旧权限继承。
  const fd = openSync(temporary, "r+");
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  renameSync(temporary, projectOrderPath);
}

/**
 * 启动时清理（对标 Claude 的 cleanupPeriodDays）：最后活动早于 retentionDays 天的会话移出登记表；
 * 不在登记表里的 transcript 与 uploads/<id>（含 UI 里移除过的会话）一并删除。只删 AIReins 自己的副本，
 * 不碰 CLI 的原生会话。retentionDays=0 只清残留、不过期。
 */
export function pruneStorage(retentionDays: number, now = Date.now()): { expired: number; removedFiles: number } {
  flushTranscripts();
  const sessions = loadRegistry();
  const cutoff = now - retentionDays * 86_400_000;
  // 时间戳解析不了的一律保留，宁可少删
  const kept = retentionDays > 0
    ? sessions.filter((session) => session.pinned || (session as SessionRecord & { groupId?: string }).groupId || !(Date.parse(session.lastActivityAt) < cutoff))
    : sessions;
  if (kept.length !== sessions.length) saveRegistry(kept);
  const keep = new Set(kept.map((session) => session.id));
  let removedFiles = 0;
  for (const name of readdirSync(transcriptsDir)) {
    if (!name.endsWith(".ndjson") || keep.has(name.slice(0, -".ndjson".length))) continue;
    rmSync(join(transcriptsDir, name), { force: true });
    removedFiles += 1;
  }
  const uploadsDir = join(workbenchHome, "uploads");
  const orphanUploads = existsSync(uploadsDir) ? readdirSync(uploadsDir).filter((name) => !keep.has(name)) : [];
  removedFiles += removeUploadDirs(orphanUploads, kept);
  return { expired: sessions.length - kept.length, removedFiles };
}

/**
 * 删除 uploads/<id> 目录。引用路径可以指向别的会话的附件，所以仍被 kept 中某会话 transcript
 * 提到的目录保留。返回实际删除的目录数。
 */
export function uploadDirReferences(kept: SessionRecord[]): Map<string, Set<string>> {
  const uploadsDir = join(workbenchHome, "uploads");
  const ids = existsSync(uploadsDir) ? readdirSync(uploadsDir) : [];
  const byPath = new Map<string, Set<string>>();
  return new Map(kept.map((session) => {
    const cached = byPath.get(session.transcriptPath);
    if (cached) return [session.id, cached];
    let text: string;
    try { flushTranscripts(session.transcriptPath); text = readFileSync(session.transcriptPath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      text = "";
    }
    const references = new Set(ids.filter((id) => text.includes(join(uploadsDir, id))));
    byPath.set(session.transcriptPath, references);
    return [session.id, references];
  }));
}

export function removeUploadDirs(ids: string[], kept: SessionRecord[]): number {
  if (ids.length === 0) return 0;
  const uploadsDir = join(workbenchHome, "uploads");
  let references: Map<string, Set<string>>;
  try { references = uploadDirReferences(kept); } catch (error) {
    log("error", "upload deletion abandoned: transcript unreadable", { message: String(error) });
    return 0;
  }
  const referenced = new Set([...references.values()].flatMap((ids) => [...ids]));
  let removed = 0;
  for (const id of ids) {
    if (referenced.has(id)) continue;
    rmSync(join(uploadsDir, id), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** UI 移除会话时删掉 AIReins 自己的副本（transcript + 附件）；CLI 原生会话不受影响。 */
export function deleteSessionFiles(record: SessionRecord, kept: SessionRecord[]): void {
  flushTranscripts(record.transcriptPath);
  transcriptCache.delete(record.transcriptPath);
  transcriptHealth.delete(record.transcriptPath);
  transcriptTick.delete(record.transcriptPath);
  idleTranscripts.delete(record.transcriptPath);
  transcriptWriteFailures.delete(record.transcriptPath);
  rmSync(record.transcriptPath, { force: true });
  if (existsSync(join(workbenchHome, "uploads", record.id))) removeUploadDirs([record.id], kept);
}

export function transcriptPathFor(sessionId: string): string {
  return join(transcriptsDir, `${sessionId}.ndjson`);
}

// The first append is synchronous (including tail repair and write errors); the rest
// of the same tick share one append. No queued events survive a failed write.
const pendingTranscripts = new Map<string, { lines: string[]; timer: ReturnType<typeof setImmediate>; onError?: (error: unknown) => void }>();
const transcriptTick = new Set<string>();
// A failed deferred batch may have lost already-published events. Keep this file
// read-only for the rest of this process, even if its surviving bytes parse cleanly.
const transcriptWriteFailures = new Set<string>();

export function flushTranscripts(path?: string): void {
  const paths = path === undefined ? [...pendingTranscripts.keys()] : [path];
  for (const file of paths) {
    const pending = pendingTranscripts.get(file);
    if (!pending) continue;
    clearImmediate(pending.timer);
    pendingTranscripts.delete(file);
    try { writeTranscriptBatch(file, pending.lines); } catch (error) {
      transcriptWriteFailures.add(file);
      transcriptHealth.set(file, { readOnly: true });
      try { pending.onError?.(error); } catch (notificationError) {
        log("error", "transcript failure notification failed", { file, message: String(notificationError) });
      }
      throw error;
    }
  }
}

function writeTranscriptBatch(path: string, lines: string[]): void {
  assertTranscriptWritable(path);
  const health = transcriptHealth.get(path)!;
  const before = health.signature!;
  const repair = health.tail ? `\n${JSON.stringify({ _wbSkippedTail: health.tail })}\n` : "";
  try {
    let cached = transcriptCache.get(path);
    // Health and paging caches can be revalidated independently by full reads.
    if (cached && cached.signature !== before) { transcriptCache.delete(path); cached = undefined; }
    const oldSize = before === "missing" ? 0 : Number(before.split(":")[1]);
    const batch = Buffer.from(repair + lines.join(""));
    appendFileSync(path, batch, { mode: 0o600 });
    const after = transcriptSignature(path);
    const fields = after.split(":");
    let consistent = after !== "missing" && Number(fields[1]) === oldSize + batch.length
      && (before === "missing" || fields[0] === before.split(":")[0]);
    // Size alone misses a same-size rewrite after append. Verify only the bytes
    // just written, then check that the version stayed stable during that read.
    if (consistent) {
      const fd = openSync(path, "r");
      try {
        const actual = Buffer.allocUnsafe(batch.length);
        let read = 0;
        while (read < actual.length) {
          const count = readSync(fd, actual, read, actual.length - read, oldSize + read);
          if (!count) break;
          read += count;
        }
        consistent = read === batch.length && actual.equals(batch) && after === transcriptSignature(path);
      } finally { closeSync(fd); }
    }
    if (!consistent) {
      transcriptHealth.delete(path);
      transcriptCache.delete(path);
      return; // Own append succeeded; the external version must be rejudged.
    }
    health.tail = undefined;
    health.signature = after;
    if (cached) {
      let offset = oldSize + Buffer.byteLength(repair);
      for (const line of lines) {
        const length = Buffer.byteLength(line);
        indexTranscriptEvent(cached, JSON.parse(line) as UnifiedEvent, offset, length);
        offset += length;
      }
      cached.signature = after;
      if (cacheBytes(cached) > TRANSCRIPT_CACHE_MAX_BYTES) transcriptCache.delete(path);
      trimTranscriptCache();
    }
  } catch (error) {
    // A partially written batch must be revalidated from the actual bytes.
    transcriptHealth.delete(path);
    transcriptCache.delete(path);
    throw error;
  }
}

export function appendTranscript(path: string, event: UnifiedEvent, onError?: (error: unknown) => void): void {
  if (!transcriptHealth.has(path)) {
    mkdirSync(dirname(path), { recursive: true });
    readTranscriptState(path);
  }
  assertTranscriptWritable(path);
  const line = `${JSON.stringify(event)}\n`;
  const pending = pendingTranscripts.get(path);
  if (pending) { pending.lines.push(line); pending.onError ??= onError; }
  else if (!transcriptTick.has(path)) {
    writeTranscriptBatch(path, [line]);
    transcriptTick.add(path);
    setImmediate(() => transcriptTick.delete(path));
  } else {
    pendingTranscripts.set(path, { lines: [line], onError, timer: setImmediate(() => {
      try { flushTranscripts(path); } catch (error) {
        log("error", "transcript batch append failed; marked read-only", { file: path, message: String(error) });
      }
    }) });
  }
}

// Synchronous exit hook also covers explicit process.exit and shutdown timeouts.
process.once("exit", () => {
  for (const path of pendingTranscripts.keys()) {
    try { flushTranscripts(path); } catch (error) {
      log("error", "transcript exit flush failed; marked read-only", { file: path, message: String(error) });
      process.exitCode = 1;
    }
  }
});

export function assertTranscriptWritable(path: string): void {
  const signature = transcriptSignature(path);
  if (transcriptHealth.get(path)?.signature !== signature) {
    transcriptCache.delete(path);
    readTranscriptState(path);
    if (transcriptHealth.get(path)?.signature !== transcriptSignature(path)) throw new Error(`transcript 读取期间变化，禁止追加：${path}`);
  }
  const health = transcriptHealth.get(path)!;
  if (health.readOnly) throw new Error(`transcript 损坏或只读，禁止追加：${path}`);
}

interface CachedTranscript {
  signature: string; index: EventPageIndex; offsets: number[]; lengths: number[];
  hasFirstUser: boolean; title: string; titleBytes: number;
}
const transcriptCache = new Map<string, CachedTranscript>();
const idleTranscripts = new Set<string>();
const TRANSCRIPT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const cacheBytes = (cache: CachedTranscript) => cache.index.accountedBytes + cache.titleBytes * 8;
export function transcriptCacheStats() {
  return { entries: transcriptCache.size, accountedBytes: [...transcriptCache.values()].reduce((sum, cache) => sum + cacheBytes(cache), 0), maxBytes: TRANSCRIPT_CACHE_MAX_BYTES };
}
export function setTranscriptCacheIdle(path: string, idle: boolean): void {
  if (idle) idleTranscripts.add(path); else idleTranscripts.delete(path);
}
export function releaseTranscriptCache(path: string): void { transcriptCache.delete(path); }
function trimTranscriptCache(): void {
  let bytes = transcriptCacheStats().accountedBytes;
  while (bytes > TRANSCRIPT_CACHE_MAX_BYTES) {
    const path = [...transcriptCache.keys()].find(path => idleTranscripts.has(path)) ?? transcriptCache.keys().next().value!;
    bytes -= cacheBytes(transcriptCache.get(path)!);
    transcriptCache.delete(path);
  }
}
function transcriptSignature(path: string): string {
  try { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; transcriptHealth.set(path, { readOnly: true }); throw error; }
}
function indexTranscriptEvent(cache: CachedTranscript, event: UnifiedEvent, offset: number, length: number): void {
  cache.index.append(event);
  cache.offsets.push(offset);
  cache.lengths.push(length);
  if (!cache.hasFirstUser && event.type === "user_message") {
    cache.hasFirstUser = true;
    cache.title = sessionTitle({}, [event]);
    cache.titleBytes = Buffer.byteLength(cache.title);
  }
}
function cachedTranscript(path: string): CachedTranscript {
  flushTranscripts(path);
  let cache = transcriptCache.get(path);
  if (cache?.signature === transcriptSignature(path)) {
    transcriptCache.delete(path); transcriptCache.set(path, cache); // LRU touch
    return cache;
  }
  transcriptCache.delete(path);
  for (let attempt = 0; attempt < 2; attempt++) {
    cache = { signature: "", index: new EventPageIndex(false), offsets: [], lengths: [], hasFirstUser: false, title: sessionTitle({}), titleBytes: 32 };
    const scanned = scanTranscript(path, (event, offset, length) => indexTranscriptEvent(cache!, event, offset, length));
    if (!scanned.stable) continue;
    cache.signature = scanned.signature;
    if (cacheBytes(cache) <= TRANSCRIPT_CACHE_MAX_BYTES) transcriptCache.set(path, cache);
    trimTranscriptCache();
    return cache;
  }
  throw new Error(`transcript 读取期间变化：${path}`);
}
function transcriptPage(path: string, beforeSeq?: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = cachedTranscript(path);
    const { start, limit } = cached.index.range(beforeSeq);
    const events: UnifiedEvent[] = [];
    let fd: number | undefined;
    try {
      if (start < limit) fd = openSync(path, "r");
      for (let i = start; i < limit; i++) {
        const bytes = Buffer.allocUnsafe(cached.lengths[i]!);
        let read = 0;
        while (read < bytes.length) {
          const count = readSync(fd!, bytes, read, bytes.length - read, cached.offsets[i]! + read);
          if (!count) throw new Error("transcript 分页读取不完整");
          read += count;
        }
        events.push(transcriptEvent(JSON.parse(bytes.toString("utf8"))));
      }
      if (cached.signature === transcriptSignature(path)) return { cached, page: { events, hasMore: start > 0, firstSeq: events[0]?.seq ?? 0 } };
    } catch (error) {
      if (cached.signature === transcriptSignature(path)) throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
    transcriptCache.delete(path);
  }
  throw new Error(`transcript 分页读取期间变化：${path}`);
}
export function readTranscriptPage(path: string, beforeSeq?: number) { return transcriptPage(path, beforeSeq).page; }
export function readTranscriptTail(path: string) {
  const { cached, page } = transcriptPage(path);
  return { ...page, state: structuredClone(cached.index.state), title: cached.title, titleIsFallback: !cached.hasFirstUser };
}
export function readTranscriptDerived(path: string) {
  const cached = cachedTranscript(path);
  return { state: structuredClone(cached.index.state), title: cached.title };
}

interface TailBoundary { offset: number; bytes: number; sha256: string }
const transcriptHealth = new Map<string, { readOnly: boolean; tail?: TailBoundary; signature?: string }>();
const tailMarkerPrefix = Buffer.from('{"_wbSkippedTail":');
const tailBoundary = (bytes: Buffer, offset: number): TailBoundary => ({ offset, bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") });

function transcriptEvent(parsed: any): UnifiedEvent {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.seq !== "number"
    || typeof parsed.type !== "string" || !parsed.payload || typeof parsed.payload !== "object") throw new Error("无效事件对象");
  return parsed as UnifiedEvent;
}

function scanTranscript(path: string, onEvent: (event: UnifiedEvent, offset: number, length: number) => void) {
  const signature = transcriptSignature(path);
  if (transcriptCache.get(path)?.signature !== signature) transcriptCache.delete(path);
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { transcriptHealth.set(path, { readOnly: true, signature }); throw error; }
    const stable = signature === transcriptSignature(path);
    if (stable) transcriptHealth.set(path, { readOnly: transcriptWriteFailures.has(path), signature });
    return { damaged: transcriptWriteFailures.has(path), incompleteTail: false, signature, stable };
  }
  let lineNumber = 0;
  let damaged = transcriptWriteFailures.has(path);
  let tail: TailBoundary | undefined;
  let previous: { bytes: Buffer; offset: number } | undefined;
  try {
    const lines = transcriptLines(fd);
    let current = lines.next();
    while (!current.done) {
      lineNumber++;
      const raw = current.value;
      if (raw.bytes.at(-1) !== 10) {
        tail = tailBoundary(raw.bytes, raw.offset);
        log("warn", "transcript incomplete tail skipped", { file: path, line: lineNumber });
        break;
      }
      const bytes = raw.bytes.subarray(0, -1);
      const next = lines.next();
      let isolatedTail = false;
      if (!next.done && next.value.bytes.at(-1) === 10 && next.value.bytes.subarray(0, tailMarkerPrefix.length).equals(tailMarkerPrefix)) {
        try {
          const marker = JSON.parse(next.value.bytes.toString("utf8"))._wbSkippedTail;
          const boundary = tailBoundary(bytes, raw.offset);
          isolatedTail = marker?.offset === boundary.offset && marker.bytes === boundary.bytes && marker.sha256 === boundary.sha256;
        } catch { /* 下一行不是恢复标记 */ }
      }
      try {
        const line = bytes.toString("utf8");
        if (!isolatedTail && line.trim()) {
          const parsed = JSON.parse(line);
          const marker = parsed?._wbSkippedTail;
          if (marker) {
            const boundary = previous && tailBoundary(previous.bytes, previous.offset);
            if (!boundary || marker.offset !== boundary.offset || marker.bytes !== boundary.bytes || marker.sha256 !== boundary.sha256) throw new Error("尾行隔离标记不匹配");
          } else onEvent(transcriptEvent(parsed), raw.offset, raw.bytes.length);
        }
      } catch (error) {
        damaged = true;
        log("error", "transcript invalid line", { file: path, line: lineNumber, message: String(error) });
      }
      previous = { bytes, offset: raw.offset };
      current = next;
    }
  } catch (error) {
    transcriptHealth.set(path, { readOnly: true, signature });
    transcriptCache.delete(path);
    throw error;
  } finally { closeSync(fd); }
  const stable = signature === transcriptSignature(path);
  if (stable) transcriptHealth.set(path, { readOnly: damaged, tail, signature });
  else { transcriptHealth.delete(path); transcriptCache.delete(path); }
  return { damaged, incompleteTail: Boolean(tail), signature, stable };
}

export function readTranscriptState(path: string): { events: UnifiedEvent[]; damaged: boolean; incompleteTail: boolean } {
  flushTranscripts(path);
  // Full recovery reads remain transient; startup does not create paging caches.
  const events: UnifiedEvent[] = [];
  const { damaged, incompleteTail } = scanTranscript(path, event => events.push(event));
  return { events, damaged, incompleteTail };
}

export function readTranscript(path: string): UnifiedEvent[] { return readTranscriptState(path).events; }

/** 有界分块读取，保留原始行字节（含换行），不把整个 transcript 留在内存中。 */
function* transcriptLines(fd: number): Generator<{ bytes: Buffer; offset: number }> {
  let parts: Buffer[] = [];
  let position = 0;
  let offset = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const size = readSync(fd, chunk, 0, chunk.length, position);
    if (!size) break;
    position += size;
    const bytes = chunk.subarray(0, size);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      const segment = bytes.subarray(start, end + 1);
      const line = parts.length ? Buffer.concat([...parts, segment]) : segment;
      parts = [];
      yield { bytes: line, offset };
      offset += line.length;
      start = end + 1;
    }
    if (start < bytes.length) parts.push(bytes.subarray(start));
  }
  if (parts.length) yield { bytes: Buffer.concat(parts), offset };
}

function legacyPartial(bytes: Buffer): boolean | undefined {
  const text = bytes.toString("utf8");
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text);
  if (parsed?._wbSkippedTail) throw new Error("含尾行恢复标记的文件禁止压缩改写");
  const event = transcriptEvent(parsed);
  return event.type === "tool_call_updated" && event.payload !== null
    && typeof event.payload === "object" && Object.hasOwn(event.payload, "partialInput")
    && event.payload.inputComplete !== true;
}

/** 启动恢复前执行；只处理登记为 Claude 的 AIReins 副本，Codex/Kimi 即使有同名字段也保留。 */
export function compactClaudeTranscripts(sessions: SessionRecord[]): { files: number; rewrittenFiles: number; removedLines: number; removedBytes: number } {
  flushTranscripts();
  const result = { files: 0, rewrittenFiles: 0, removedLines: 0, removedBytes: 0 };
  const claudeIds = new Set(sessions.filter((session) => session.agent === "claude").map((session) => session.id));
  for (const name of readdirSync(transcriptsDir)) {
    if (!name.endsWith(".ndjson") || !claudeIds.has(name.slice(0, -7))) continue;
    const path = join(transcriptsDir, name);
    let fd: number | undefined;
    let output: number | undefined;
    try {
      fd = openSync(path, "r");
      result.files++;
      let lines = 0;
      let bytes = 0;
      let lastOffset = -1;
      let lastRemovedBytes = 0;
      let lineNumber = 0;
      let invalid = false;
      for (const line of transcriptLines(fd)) {
        lineNumber++;
        if (line.bytes.at(-1) !== 10) {
          log("warn", "transcript compaction skipped incomplete tail", { file: path, line: lineNumber });
          invalid = true;
          break;
        }
        let removable;
        try { removable = legacyPartial(line.bytes); } catch (error) {
          log("error", "transcript compaction skipped invalid line", { file: path, line: lineNumber, message: String(error) });
          invalid = true;
          break;
        }
        if (removable === undefined) continue;
        lastOffset = line.offset;
        lastRemovedBytes = removable ? line.bytes.length : 0;
        if (lastRemovedBytes) { lines++; bytes += lastRemovedBytes; }
      }
      if (invalid) continue;
      // 末尾有效行是恢复 seq 的依据；即使它也是旧 partialInput，也必须保留。
      if (lastRemovedBytes) { lines--; bytes -= lastRemovedBytes; }
      if (!lines) continue; // 幂等：无可删行时不创建临时文件、不触碰 inode/mtime。
      const temporary = `${path}.compact.tmp`;
      output = openSync(temporary, "w", fstatSync(fd).mode & 0o777);
      fchmodSync(output, fstatSync(fd).mode & 0o777);
      for (const line of transcriptLines(fd)) {
        if (line.offset !== lastOffset && legacyPartial(line.bytes)) continue;
        let written = 0;
        while (written < line.bytes.length) written += writeSync(output, line.bytes, written, line.bytes.length - written);
      }
      fsyncSync(output);
      closeSync(output);
      output = undefined;
      renameSync(temporary, path);
      transcriptCache.delete(path);
      transcriptHealth.delete(path);
      result.rewrittenFiles++;
      result.removedLines += lines;
      result.removedBytes += bytes;
    } catch (error) {
      log("error", "transcript compaction failed", { file: path, message: String(error) });
    } finally {
      if (output !== undefined) closeSync(output);
      if (fd !== undefined) closeSync(fd);
    }
  }
  return result;
}
