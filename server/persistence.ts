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
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { log } from "./logger.js";
import type { SessionGroup, SessionRecord, UnifiedEvent } from "./types.js";

export const workbenchHome = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");
export const registryPath = join(workbenchHome, "sessions.json");
export const sessionGroupsPath = join(workbenchHome, "session-groups.json");
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

export function loadSessionGroups(): SessionGroup[] {
  ensureStorage();
  if (!existsSync(sessionGroupsPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(sessionGroupsPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((group) => !group || typeof group !== "object"
    || typeof group.id !== "string" || typeof group.name !== "string" || typeof group.createdAt !== "string")) {
    throw new Error(`${sessionGroupsPath} 必须是分组 JSON 数组`);
  }
  return parsed as SessionGroup[];
}

export function saveSessionGroups(groups: SessionGroup[]): void {
  ensureStorage();
  const temporary = `${sessionGroupsPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(groups, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, sessionGroupsPath);
}

/**
 * 启动时清理（对标 Claude 的 cleanupPeriodDays）：最后活动早于 retentionDays 天的会话移出登记表；
 * 不在登记表里的 transcript 与 uploads/<id>（含 UI 里移除过的会话）一并删除。只删 wb 自己的副本，
 * 不碰 CLI 的原生会话。retentionDays=0 只清残留、不过期。
 */
export function pruneStorage(retentionDays: number, now = Date.now()): { expired: number; removedFiles: number } {
  const sessions = loadRegistry();
  const cutoff = now - retentionDays * 86_400_000;
  // 时间戳解析不了的一律保留，宁可少删
  const kept = retentionDays > 0
    ? sessions.filter((session) => session.pinned || session.groupId || !(Date.parse(session.lastActivityAt) < cutoff))
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
    try { text = readFileSync(session.transcriptPath, "utf8"); } catch (error) {
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

/** UI 移除会话时删掉 wb 自己的副本（transcript + 附件）；CLI 原生会话不受影响。 */
export function deleteSessionFiles(record: SessionRecord, kept: SessionRecord[]): void {
  rmSync(record.transcriptPath, { force: true });
  if (existsSync(join(workbenchHome, "uploads", record.id))) removeUploadDirs([record.id], kept);
}

export function transcriptPathFor(sessionId: string): string {
  return join(transcriptsDir, `${sessionId}.ndjson`);
}

export function appendTranscript(path: string, event: UnifiedEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!transcriptHealth.has(path)) readTranscriptState(path);
  const health = transcriptHealth.get(path)!;
  if (health.readOnly) throw new Error(`transcript 损坏，禁止追加：${path}`);
  // 只追加：用带字节校验的标记隔离原残行，重启后仍能区分它与真正的中间损坏。
  const repair = health.tail ? `\n${JSON.stringify({ _wbSkippedTail: health.tail })}\n` : "";
  try { appendFileSync(path, `${repair}${JSON.stringify(event)}\n`, { mode: 0o600 }); } catch (error) {
    // 写入可能只完成一部分；下次必须从真实字节重判，不能复用旧尾段边界。
    transcriptHealth.delete(path);
    throw error;
  }
  health.tail = undefined;
}

interface TailBoundary { offset: number; bytes: number; sha256: string }
const transcriptHealth = new Map<string, { readOnly: boolean; tail?: TailBoundary }>();
const tailMarkerPrefix = Buffer.from('{"_wbSkippedTail":');
const tailBoundary = (bytes: Buffer, offset: number): TailBoundary => ({ offset, bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") });

function transcriptEvent(parsed: any): UnifiedEvent {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.seq !== "number"
    || typeof parsed.type !== "string" || !parsed.payload || typeof parsed.payload !== "object") throw new Error("无效事件对象");
  return parsed as UnifiedEvent;
}

export function readTranscriptState(path: string): { events: UnifiedEvent[]; damaged: boolean; incompleteTail: boolean } {
  let content: Buffer;
  try { content = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      transcriptHealth.set(path, { readOnly: true });
      throw error;
    }
    transcriptHealth.set(path, { readOnly: false });
    return { events: [], damaged: false, incompleteTail: false };
  }
  const events: UnifiedEvent[] = [];
  let offset = 0, lineNumber = 0;
  let damaged = false;
  let tail: TailBoundary | undefined;
  let previous: { bytes: Buffer; offset: number } | undefined;
  for (; offset < content.length;) {
    lineNumber++;
    const end = content.indexOf(10, offset);
    if (end === -1) {
      tail = tailBoundary(content.subarray(offset), offset);
      log("warn", "transcript incomplete tail skipped", { file: path, line: lineNumber });
      break;
    }
    const bytes = content.subarray(offset, end);
    const line = bytes.toString("utf8");
    // 即使原尾段恰好是完整 JSON，也按启动时的跳过语义保持隔离。
    let isolatedTail = false;
    const nextEnd = content.indexOf(10, end + 1);
    if (nextEnd !== -1 && content.subarray(end + 1, end + 1 + tailMarkerPrefix.length).equals(tailMarkerPrefix)) {
      try {
        const marker = JSON.parse(content.subarray(end + 1, nextEnd).toString("utf8"))._wbSkippedTail;
        if (marker) {
          const boundary = tailBoundary(bytes, offset);
          isolatedTail = marker.offset === boundary.offset && marker.bytes === boundary.bytes && marker.sha256 === boundary.sha256;
        }
      } catch { /* 下一行不是恢复标记 */ }
    }
    try {
      if (!isolatedTail && line.trim()) {
        const parsed = JSON.parse(line);
        const marker = parsed?._wbSkippedTail;
        if (marker) {
          const boundary = previous && tailBoundary(previous.bytes, previous.offset);
          if (!boundary || marker.offset !== boundary.offset || marker.bytes !== boundary.bytes || marker.sha256 !== boundary.sha256) {
            throw new Error("尾行隔离标记不匹配");
          }
        } else {
          events.push(transcriptEvent(parsed));
        }
      }
    } catch (error) {
      damaged = true;
      log("error", "transcript invalid line", { file: path, line: lineNumber, message: String(error) });
    }
    previous = { bytes, offset };
    offset = end + 1;
  }
  transcriptHealth.set(path, { readOnly: damaged, tail });
  return { events, damaged, incompleteTail: Boolean(tail) };
}

export function readTranscript(path: string): UnifiedEvent[] {
  return readTranscriptState(path).events;
}

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

/** 启动恢复前执行；只处理登记为 Claude 的 wb 副本，Codex/Kimi 即使有同名字段也保留。 */
export function compactClaudeTranscripts(sessions: SessionRecord[]): { files: number; rewrittenFiles: number; removedLines: number; removedBytes: number } {
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
