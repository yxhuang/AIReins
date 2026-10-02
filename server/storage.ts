import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { removeUploadDirs, uploadDirReferences, workbenchHome } from "./persistence.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionRecord } from "./types.js";

export interface StorageCategory { bytes: number; files: number; sessions: number }
export interface StorageStats {
  totalBytes: number;
  categories: Record<"transcripts" | "uploads" | "logs" | "other", StorageCategory>;
  cleanable: {
    bytes: number;
    rotatedLogs: { bytes: number; files: number };
    orphans: { bytes: number; files: number; uploadDirs: number };
    ended: { bytes: number; files: number; sessions: number };
  };
}
export interface StorageCleanResult {
  freedBytes: number;
  removed: { rotatedLogs: number; orphanFiles: number; orphanUploadDirs: number; endedSessions: number };
  storage: StorageStats;
}
export class StorageInputError extends Error {}
export function validateStorageCleanInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof (input as Record<string, unknown>).includeEnded !== "boolean") {
    throw new StorageInputError("includeEnded 必须是布尔值");
  }
  return (input as { includeEnded: boolean }).includeEnded;
}

interface FileEntry { path: string; rel: string; bytes: number; regular: boolean }
interface Inventory { files: FileEntry[]; dirs: string[] }
interface Plan { logs: FileEntry[]; transcripts: FileEntry[]; uploadIds: string[]; files: FileEntry[] }

/** 不跟随符号链接；只忽略遍历中已经消失的路径，权限/IO 错误交给接口报告。 */
function inventory(paths = [resolve(workbenchHome)]): Inventory {
  const result: Inventory = { files: [], dirs: [] };
  const root = resolve(workbenchHome);
  function visit(path: string): void {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const rel = relative(root, path);
    if (stat.isDirectory()) {
      if (rel) result.dirs.push(rel);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (rel) {
      result.files.push({ path, rel, bytes: stat.size, regular: stat.isFile() });
    }
  }
  for (const path of paths) visit(path);
  return result;
}
const sum = (files: FileEntry[]) => files.reduce((total, file) => total + file.bytes, 0);
const inDir = (file: FileEntry, dir: string) => file.rel.startsWith(`${dir}${sep}`);

function planFor(scan: Inventory, sessions: SessionRecord[]): Plan {
  const ids = new Set(sessions.map((session) => session.id));
  const transcriptPaths = new Set(sessions.map((session) => resolve(session.transcriptPath)));
  const logs = scan.files.filter((file) => file.regular && /^server\.log\.[^/]+$/.test(file.rel));
  const transcripts = scan.files.filter((file) => file.regular
    && file.rel.startsWith(`transcripts${sep}`)
    && !file.rel.slice("transcripts/".length).includes(sep) && file.rel.endsWith(".ndjson")
    && !ids.has(file.rel.slice("transcripts/".length, -7)) && !transcriptPaths.has(file.path));
  const referenced = uploadDirReferences(sessions);
  const uploadIds = scan.dirs.filter((dir) => dir.startsWith(`uploads${sep}`)
    && !dir.slice("uploads/".length).includes(sep))
    .map((dir) => dir.slice("uploads/".length))
    .filter((id) => !ids.has(id) && !referenced.includes(join(workbenchHome, "uploads", id)));
  const files = [...logs, ...transcripts,
    ...scan.files.filter((file) => uploadIds.some((id) => inDir(file, join("uploads", id))))];
  return { logs, transcripts, uploadIds, files };
}

export function getStorageStats(manager: SessionManager): StorageStats {
  const scan = inventory();
  const sessions = manager.list();
  const category = (): StorageCategory => ({ bytes: 0, files: 0, sessions: 0 });
  const categories = { transcripts: category(), uploads: category(), logs: category(), other: category() };
  for (const file of scan.files) {
    const kind = inDir(file, "transcripts") ? "transcripts" : inDir(file, "uploads") ? "uploads"
      : !file.rel.includes(sep) && file.rel.startsWith("server.log") ? "logs" : "other";
    categories[kind].bytes += file.bytes;
    categories[kind].files++;
    if (kind === "transcripts" && /^transcripts\/[^/]+\.ndjson$/.test(file.rel)) categories.transcripts.sessions++;
  }
  categories.uploads.sessions = scan.dirs.filter((dir) => /^uploads\/[^/]+$/.test(dir)).length;
  const plan = planFor(scan, sessions);
  const ended = sessions.filter((session) => manager.isEndedSessionRemovable(session.id));
  const endedIds = new Set(ended.map((session) => session.id));
  const withEnded = planFor(scan, sessions.filter((session) => !endedIds.has(session.id)));
  const defaultPaths = new Set(plan.files.map((file) => file.path));
  const endedPaths = new Set(ended.map((session) => resolve(session.transcriptPath)));
  const withEndedPaths = new Set(withEnded.files.map((file) => file.path));
  const extraFiles = scan.files.filter((file) => !defaultPaths.has(file.path)
    && (withEndedPaths.has(file.path) || endedPaths.has(file.path)));
  const orphanFiles = plan.files.filter((file) => !plan.logs.includes(file));
  return {
    totalBytes: sum(scan.files), categories,
    cleanable: {
      bytes: sum(plan.files), rotatedLogs: { bytes: sum(plan.logs), files: plan.logs.length },
      orphans: { bytes: sum(orphanFiles), files: orphanFiles.length, uploadDirs: plan.uploadIds.length },
      ended: { bytes: sum(extraFiles), files: extraFiles.length, sessions: ended.length },
    },
  };
}

// 并发清理串行执行，各请求采用自己的 includeEnded 和执行时的内存状态。
let cleaning: Promise<unknown> = Promise.resolve();
export function cleanStorage(manager: SessionManager, includeEnded: boolean): Promise<StorageCleanResult> {
  const operation = cleaning.then(() => performClean(manager, includeEnded));
  cleaning = operation.catch(() => {});
  return operation;
}

async function performClean(manager: SessionManager, includeEnded: boolean): Promise<StorageCleanResult> {
  const result = { freedBytes: 0, removed: { rotatedLogs: 0, orphanFiles: 0, orphanUploadDirs: 0, endedSessions: 0 } };
  function deleteFile(path: string): number | undefined {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return undefined;
      unlinkSync(path);
      return stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  function cleanOrphansAndLogs(): void {
    const scan = inventory();
    const kept = manager.list();
    const plan = planFor(scan, kept);
    // 本次具体删除清单由当前内存会话、引用保护及顶层日志副本共同限定。
    for (const file of plan.logs) {
      const deletedBytes = deleteFile(file.path);
      if (deletedBytes !== undefined) {
        result.freedBytes += deletedBytes;
        result.removed.rotatedLogs++;
      }
    }
    for (const file of plan.transcripts) {
      const deletedBytes = deleteFile(file.path);
      if (deletedBytes !== undefined) {
        result.freedBytes += deletedBytes;
        result.removed.orphanFiles++;
      }
    }
    for (const id of plan.uploadIds) {
      const path = resolve(workbenchHome, "uploads", id);
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory()) continue;
      const files = inventory([path]).files;
      const removed = removeUploadDirs([id], kept);
      if (removed) {
        result.freedBytes += sum(files);
        result.removed.orphanFiles += files.length;
        result.removed.orphanUploadDirs += removed;
      }
    }
  }
  cleanOrphansAndLogs();
  if (includeEnded) {
    for (const session of manager.list()) {
      if (!manager.isEndedSessionRemovable(session.id)) continue;
      const paths = [resolve(session.transcriptPath), resolve(workbenchHome, "uploads", session.id)];
      const before = inventory(paths).files;
      // 调用前再次判状态；remove 与 UI 使用相同路径，不启动或直接操作 CLI。
      if (!manager.isEndedSessionRemovable(session.id)) continue;
      if (await manager.remove(session.id)) {
        const remaining = new Set(inventory(paths).files.map((file) => file.path));
        result.freedBytes += sum(before.filter((file) => !remaining.has(file.path)));
        result.removed.endedSessions++;
      }
    }
    // 删除结束会话后，它独占引用的附件也可能成为孤儿；继续采用相同保护规则。
    cleanOrphansAndLogs();
  }
  return { ...result, storage: getStorageStats(manager) };
}
