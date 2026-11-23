import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { removeUploadDirs, transcriptPathFor, uploadDirReferences, workbenchHome } from "./persistence.js";
import { scanNativePresence } from "./native-presence.js";
import { reclaimNativePayloads } from "./native-payload-replay.js";
import { DEFAULT_STORAGE_BUDGET_BYTES, storageCleanupTarget } from "./prefs.js";
import { archiveTranscript } from "./transcript-archive.js";
import { log } from "./logger.js";
import type { SessionManager } from "./session-manager.js";
import { AGENTS, type SessionRecord } from "./types.js";

export interface StorageCategory { bytes: number; files: number; sessions: number }
export interface StorageStats {
  totalBytes: number;
  automatic: { budgetBytes: number; targetBytes: number };
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

interface FileEntry { path: string; rel: string; bytes: number; regular: boolean; version: string }
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
      result.files.push({ path, rel, bytes: stat.size, regular: stat.isFile(), version: storageVersion(stat) });
    }
  }
  for (const path of paths) visit(path);
  return result;
}
const sum = (files: FileEntry[]) => files.reduce((total, file) => total + file.bytes, 0);
const inDir = (file: FileEntry, dir: string) => file.rel.startsWith(`${dir}${sep}`);
function storageVersion(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function planFor(scan: Inventory, sessions: SessionRecord[], references = uploadDirReferences(sessions)): Plan {
  const ids = new Set(sessions.map((session) => session.id));
  const transcriptPaths = new Set(sessions.map((session) => resolve(session.transcriptPath)));
  const logs = scan.files.filter((file) => file.regular && /^server\.log\.[^/]+$/.test(file.rel));
  const transcripts = scan.files.filter((file) => file.regular
    && file.rel.startsWith(`transcripts${sep}`)
    && !file.rel.slice("transcripts/".length).includes(sep) && file.rel.endsWith(".ndjson")
    && !ids.has(file.rel.slice("transcripts/".length, -7)) && !transcriptPaths.has(file.path));
  const referenced = new Set(sessions.flatMap((session) => [...(references.get(session.id) ?? [])]));
  const uploadIds = scan.dirs.filter((dir) => dir.startsWith(`uploads${sep}`)
    && !dir.slice("uploads/".length).includes(sep))
    .map((dir) => dir.slice("uploads/".length))
    .filter((id) => !ids.has(id) && !referenced.has(id));
  const files = [...logs, ...transcripts,
    ...scan.files.filter((file) => uploadIds.some((id) => inDir(file, join("uploads", id))))];
  return { logs, transcripts, uploadIds, files };
}

export function getStorageStats(manager: SessionManager, budgetBytes = DEFAULT_STORAGE_BUDGET_BYTES): StorageStats {
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
  const references = uploadDirReferences(sessions);
  const plan = planFor(scan, sessions, references);
  const ended = sessions.filter((session) => manager.isEndedSessionRemovable(session.id));
  const endedIds = new Set(ended.map((session) => session.id));
  const withEnded = planFor(scan, sessions.filter((session) => !endedIds.has(session.id)), references);
  const defaultPaths = new Set(plan.files.map((file) => file.path));
  const endedPaths = new Set(ended.map((session) => resolve(session.transcriptPath)));
  const withEndedPaths = new Set(withEnded.files.map((file) => file.path));
  const extraFiles = scan.files.filter((file) => !defaultPaths.has(file.path)
    && (withEndedPaths.has(file.path) || endedPaths.has(file.path)));
  const orphanFiles = plan.files.filter((file) => !plan.logs.includes(file));
  return {
    totalBytes: sum(scan.files), categories,
    automatic: { budgetBytes, targetBytes: storageCleanupTarget(budgetBytes) },
    cleanable: {
      bytes: sum(plan.files), rotatedLogs: { bytes: sum(plan.logs), files: plan.logs.length },
      orphans: { bytes: sum(orphanFiles), files: orphanFiles.length, uploadDirs: plan.uploadIds.length },
      ended: { bytes: sum(extraFiles), files: extraFiles.length, sessions: ended.length },
    },
  };
}

// 并发清理串行执行，各请求采用自己的 includeEnded 和执行时的内存状态。
let cleaning: Promise<unknown> = Promise.resolve();
function serializeCleanup<T>(run: () => Promise<T>): Promise<T> {
  const operation = cleaning.then(run);
  cleaning = operation.catch(() => {});
  return operation;
}
export function cleanStorage(manager: SessionManager, includeEnded: boolean, budgetBytes = DEFAULT_STORAGE_BUDGET_BYTES): Promise<StorageCleanResult> {
  return serializeCleanup(() => performClean(manager, includeEnded, budgetBytes));
}

export function createStorageMaintenance(manager: SessionManager, options: {
  budgetBytes: number;
  targetBytes?: number;
  activeDispatches(sessions: readonly SessionRecord[]): Promise<ReadonlyMap<string, number>>;
  stopping?(): boolean;
}): () => Promise<void> {
  const presencePath = join(workbenchHome, "native-presence.json");
  const missingLastTime = new Set<string>();
  const incompressible = new Map<string, string>();
  const checkedNative = new Map<string, string>();
  let previous: Promise<void> | undefined;
  async function maintain(): Promise<void> {
    if (options.stopping?.()) return;
    const budgetBytes = options.budgetBytes;
    const targetBytes = options.targetBytes ?? storageCleanupTarget(budgetBytes);
    const sessions = manager.list();
    let stored: Record<string, string> = {};
    let previousBytes = "";
    try {
      previousBytes = readFileSync(presencePath, "utf8");
      const parsed: unknown = JSON.parse(previousBytes);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, string>;
    } catch { /* A missing or corrupt observation file cannot authorize deletions. */ }
    const observations: Record<string, string> = {};
    const present = new Set<string>();
    const candidates: SessionRecord[] = [];
    const missing = new Set<string>();
    for (const agent of AGENTS) {
      const linked = sessions.filter(session => session.agent === agent && /^[\w-]{1,128}$/.test(session.nativeSessionId ?? ""));
      if (!linked.length) continue;
      const native = await scanNativePresence(agent, linked);
      for (const session of linked) {
        const id = session.nativeSessionId!;
        const key = `${agent}:${id}`;
        const seen = stored[key];
        if (native?.ids.has(id)) {
          observations[key] = native.store;
          present.add(session.id);
        }
        else if (typeof seen === "string") {
          observations[key] = seen;
          if (native?.store === seen) {
            missing.add(key);
            if (missingLastTime.has(key)) candidates.push(session);
          }
        }
      }
    }
    if (options.stopping?.()) return;
    missingLastTime.clear();
    for (const key of missing) missingLastTime.add(key);
    const nextBytes = JSON.stringify(observations);
    if (Object.keys(observations).length || previousBytes) {
      if (nextBytes !== previousBytes) {
        const temporary = `${presencePath}.tmp`;
        writeFileSync(temporary, nextBytes, { mode: 0o600 });
        renameSync(temporary, presencePath);
      }
    }

    const scan = inventory();
    let used = sum(scan.files);
    const ownedStorage = new Map(scan.files.filter(file => file.regular && inDir(file, "transcripts")).map(file => [file.path, file]));
    for (const path of incompressible.keys()) if (!ownedStorage.has(path)) incompressible.delete(path);
    for (const path of checkedNative.keys()) if (!ownedStorage.has(path)) checkedNative.delete(path);
    function eligible(session: SessionRecord): boolean {
      return !options.stopping?.() && /^[\w-]{1,128}$/.test(session.id)
        && resolve(session.transcriptPath) === resolve(transcriptPathFor(session.id))
        && manager.canMaintainSessionStorage(session.id);
    }
    const removable = candidates.filter(eligible);
    const packable = used > budgetBytes ? sessions.filter(session => {
      const file = ownedStorage.get(resolve(session.transcriptPath));
      return file && file.bytes >= 1024 && eligible(session) && (incompressible.get(file.path) !== file.version
        || (present.has(session.id) && checkedNative.get(file.path) !== file.version));
    }).reverse() : [];
    if (!removable.length && !packable.length) return;
    const dispatches = await options.activeDispatches([...new Set([...removable, ...packable])]);
    let removed = 0;
    for (const session of removable) {
      if (!eligible(session) || dispatches.get(session.id)) continue;
      if (manager.get(session.id)?.nativeSessionId !== session.nativeSessionId) continue;
      if (await manager.removeMissingNativeSession(session.id)) removed++;
    }
    let archived = 0;
    let reclaimed = 0;
    let freedBytes = 0;
    if (removed) {
      const remaining = sum(inventory().files);
      freedBytes = Math.max(0, used - remaining);
      used = remaining;
    }
    if (used > targetBytes) for (const session of packable) {
      if (used <= targetBytes || options.stopping?.()) break;
      if (!present.has(session.id) || !eligible(session) || dispatches.get(session.id)) continue;
      const path = session.transcriptPath;
      const file = ownedStorage.get(resolve(path))!;
      if (checkedNative.get(file.path) === file.version) continue;
      const stillEligible = () => eligible(session) && manager.get(session.id)?.nativeSessionId === session.nativeSessionId;
      try {
        const freed = await reclaimNativePayloads(session, workbenchHome, stillEligible);
        if (freed) {
          const version = storageVersion(lstatSync(path));
          reclaimed++;
          used -= freed;
          freedBytes += freed;
          incompressible.set(file.path, version);
          checkedNative.set(file.path, version);
        } else if (stillEligible()) checkedNative.set(file.path, file.version);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const session of packable) {
      if (used <= targetBytes || options.stopping?.()) break;
      if (!eligible(session) || dispatches.get(session.id)) continue;
      const path = session.transcriptPath;
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const signature = storageVersion(stat);
      if (!stat.isFile() || incompressible.get(path) === signature) continue;
      let freed: number;
      try { freed = await archiveTranscript(path, () => eligible(session)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (freed) {
        archived++;
        freedBytes += freed;
        used -= freed;
        if (eligible(session)) {
          const version = storageVersion(lstatSync(path));
          incompressible.set(path, version);
          if (checkedNative.get(resolve(path)) === signature) checkedNative.set(resolve(path), version);
        }
      } else if (eligible(session)) incompressible.set(path, signature);
    }
    if (removed || archived || reclaimed) log("info", "session storage maintained", { removed, archived, reclaimed, freedBytes, budgetBytes, targetBytes });
  }
  return () => {
    if (previous) return previous;
    previous = serializeCleanup(maintain).finally(() => { previous = undefined; });
    return previous;
  };
}

async function performClean(manager: SessionManager, includeEnded: boolean, budgetBytes: number): Promise<StorageCleanResult> {
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
  return { ...result, storage: getStorageStats(manager, budgetBytes) };
}
