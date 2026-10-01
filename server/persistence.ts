import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionRecord, UnifiedEvent } from "./types.js";

export const workbenchHome = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");
export const registryPath = join(workbenchHome, "sessions.json");
export const transcriptsDir = join(workbenchHome, "transcripts");

export function ensureStorage(): void {
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
    ? sessions.filter((session) => !(Date.parse(session.lastActivityAt) < cutoff))
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
function removeUploadDirs(ids: string[], kept: SessionRecord[]): number {
  if (ids.length === 0) return 0;
  const uploadsDir = join(workbenchHome, "uploads");
  const referenced = kept.map((session) => {
    try { return readFileSync(session.transcriptPath, "utf8"); } catch { return ""; }
  }).join("\n");
  let removed = 0;
  for (const id of ids) {
    if (referenced.includes(join(uploadsDir, id))) continue;
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
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readTranscript(path: string): UnifiedEvent[] {
  if (!existsSync(path)) return [];
  const events: UnifiedEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as UnifiedEvent);
    } catch (error) {
      throw new Error(`transcript 存在无效 NDJSON 行：${path}: ${String(error)}`);
    }
  }
  return events;
}
