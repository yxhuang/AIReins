import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

const SNAPSHOT_MAX_BYTES = 500 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 20_000;
const SPACE_NUMERATOR = 11;
const SPACE_DENOMINATOR = 10;

interface SnapshotScanResult {
  totalBytes: number;
  fileCount: number;
  exceeds: boolean;
}

export interface SnapshotPreflightResult {
  isGit: boolean;
  needed: boolean;
  exceeds: boolean;
  existing: boolean;
  freeSpaceOk: boolean;
  snapshotPath: string | null;
}

interface SnapshotOptions {
  snapshotRoot?: string;
  maxBytes?: number;
  maxFiles?: number;
  getFreeBytes?: (snapshotRoot: string) => Promise<number>;
  copyDirectory?: (source: string, destination: string) => Promise<void>;
  renamePath?: (source: string, destination: string) => Promise<void>;
}

export class SnapshotCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCwdError";
  }
}

class SnapshotLimitError extends Error {
  constructor(readonly scan: SnapshotScanResult) {
    super(`目录超过自动快照上限（${SNAPSHOT_MAX_BYTES} 字节或 ${SNAPSHOT_MAX_FILES} 个文件）`);
    this.name = "SnapshotLimitError";
  }
}

export class SnapshotSpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly freeBytes: number) {
    super(`快照目标盘空间不足：需要至少 ${requiredBytes} 字节，可用 ${freeBytes} 字节`);
    this.name = "SnapshotSpaceError";
  }
}

export class SnapshotPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotPathError";
  }
}

const inFlightSnapshots = new Map<string, Promise<string | null>>();

function defaultSnapshotRoot(): string {
  return join(homedir(), ".workbench", "snapshots");
}

export function snapshotPathFor(cwd: string, snapshotRoot = defaultSnapshotRoot()): string {
  const absoluteCwd = resolve(cwd);
  const sourceName = basename(absoluteCwd) || "root";
  const readableName = sourceName
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "directory";
  const pathHash = createHash("sha256").update(absoluteCwd).digest("hex").slice(0, 12);
  return join(resolve(snapshotRoot), `${readableName}-${pathHash}`);
}

async function isGitRepository(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  while (true) {
    if (await isGitMarker(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function isGitMarker(markerPath: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await stat(markerPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (metadata.isDirectory()) return await pathExists(join(markerPath, "HEAD"));
  if (!metadata.isFile()) return false;
  try {
    return /^gitdir:\s*\S+/m.test(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function scanDirectory(
  cwd: string,
  limits: Pick<SnapshotOptions, "maxBytes" | "maxFiles"> = {},
): Promise<SnapshotScanResult> {
  const maxBytes = limits.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? SNAPSHOT_MAX_FILES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    throw new Error("快照扫描阈值必须是非负安全整数");
  }

  let totalBytes = 0;
  let fileCount = 0;
  const pendingDirectories = [resolve(cwd)];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const entryPath = join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      fileCount += 1;
      totalBytes += metadata.size;
      if (totalBytes > maxBytes || fileCount > maxFiles) {
        return { totalBytes, fileCount, exceeds: true };
      }
    }
  }
  return { totalBytes, fileCount, exceeds: false };
}

export async function preflightSnapshot(
  cwd: string,
  options: SnapshotOptions = {},
): Promise<SnapshotPreflightResult> {
  const absoluteCwd = await validateSnapshotCwd(cwd);
  if (await isGitRepository(absoluteCwd)) {
    return {
      isGit: true,
      needed: false,
      exceeds: false,
      existing: false,
      freeSpaceOk: false,
      snapshotPath: null,
    };
  }

  const snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot());
  const targetPath = snapshotPathFor(absoluteCwd, snapshotRoot);
  const scan = await scanDirectory(absoluteCwd, options);
  const existing = await pathExists(targetPath);
  const freeSpaceOk = scan.exceeds
    ? false
    : (await (options.getFreeBytes ?? getFilesystemFreeBytes)(snapshotRoot)) >= requiredFreeBytes(scan.totalBytes);
  return {
    isGit: false,
    needed: true,
    exceeds: scan.exceeds,
    existing,
    freeSpaceOk,
    snapshotPath: targetPath,
  };
}

export async function createSnapshotIfNeeded(
  cwd: string,
  options: SnapshotOptions = {},
): Promise<string | null> {
  const absoluteCwd = await validateSnapshotCwd(cwd);
  const active = inFlightSnapshots.get(absoluteCwd);
  if (active) return await active;

  const snapshot = createSnapshot(absoluteCwd, options);
  inFlightSnapshots.set(absoluteCwd, snapshot);
  try {
    return await snapshot;
  } finally {
    if (inFlightSnapshots.get(absoluteCwd) === snapshot) inFlightSnapshots.delete(absoluteCwd);
  }
}

export async function assertSafeSnapshotDeletion(
  targetPath: string,
  snapshotRoot = defaultSnapshotRoot(),
): Promise<void> {
  const lexicalRoot = resolve(snapshotRoot);
  const lexicalTarget = resolve(targetPath);
  if (lexicalTarget === lexicalRoot || dirname(lexicalTarget) !== lexicalRoot) {
    throw new SnapshotPathError(`拒绝删除快照根目录或非直属目录：${targetPath}`);
  }

  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
  } catch (error) {
    throw new SnapshotPathError(`无法解析待删除快照路径：${errorMessage(error)}`);
  }
  const targetRelativeToRoot = relative(realRoot, realTarget);
  if (!targetRelativeToRoot || targetRelativeToRoot.startsWith("..") || isAbsolute(targetRelativeToRoot)) {
    throw new SnapshotPathError(`拒绝删除快照根目录之外的路径：${targetPath}`);
  }
  const metadata = await lstat(lexicalTarget);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SnapshotPathError(`拒绝删除非真实目录：${targetPath}`);
  }
}

async function createSnapshot(absoluteCwd: string, options: SnapshotOptions): Promise<string | null> {
  if (await isGitRepository(absoluteCwd)) return null;

  const scan = await scanDirectory(absoluteCwd, options);
  if (scan.exceeds) throw new SnapshotLimitError(scan);

  const snapshotRoot = resolve(options.snapshotRoot ?? defaultSnapshotRoot());
  const targetPath = snapshotPathFor(absoluteCwd, snapshotRoot);
  const temporaryPath = `${targetPath}.tmp`;
  const oldPath = `${targetPath}.old`;
  const freeBytes = await (options.getFreeBytes ?? getFilesystemFreeBytes)(snapshotRoot);
  const requiredBytes = requiredFreeBytes(scan.totalBytes);
  if (freeBytes < requiredBytes) throw new SnapshotSpaceError(requiredBytes, freeBytes);

  await mkdir(snapshotRoot, { recursive: true });
  await recoverInterruptedReplacement(targetPath, temporaryPath, oldPath, snapshotRoot, options);

  const copyDirectory = options.copyDirectory ?? copyDirectoryFully;
  try {
    await copyDirectory(absoluteCwd, temporaryPath);
  } catch (error) {
    await removeSnapshotDirectoryIfPresent(temporaryPath, snapshotRoot);
    throw error;
  }

  const renamePath = options.renamePath ?? rename;
  let oldMoved = false;
  let replacementInstalled = false;
  try {
    if (await pathExists(targetPath)) {
      await assertSafeSnapshotDeletion(targetPath, snapshotRoot);
      await renamePath(targetPath, oldPath);
      oldMoved = true;
    }
    await renamePath(temporaryPath, targetPath);
    replacementInstalled = true;
    if (oldMoved) await removeSnapshotDirectoryIfPresent(oldPath, snapshotRoot);
    return targetPath;
  } catch (error) {
    if (oldMoved && !replacementInstalled && !await pathExists(targetPath) && await pathExists(oldPath)) {
      await renamePath(oldPath, targetPath);
    }
    await removeSnapshotDirectoryIfPresent(temporaryPath, snapshotRoot);
    throw error;
  }
}

async function recoverInterruptedReplacement(
  targetPath: string,
  temporaryPath: string,
  oldPath: string,
  snapshotRoot: string,
  options: SnapshotOptions,
): Promise<void> {
  const renamePath = options.renamePath ?? rename;
  if (await pathExists(oldPath)) {
    if (await pathExists(targetPath)) {
      await removeSnapshotDirectoryIfPresent(oldPath, snapshotRoot);
    } else {
      await assertSafeSnapshotDeletion(oldPath, snapshotRoot);
      await renamePath(oldPath, targetPath);
    }
  }
  await removeSnapshotDirectoryIfPresent(temporaryPath, snapshotRoot);
}

async function removeSnapshotDirectoryIfPresent(targetPath: string, snapshotRoot: string): Promise<void> {
  if (!await pathExists(targetPath)) return;
  await assertSafeSnapshotDeletion(targetPath, snapshotRoot);
  await rm(targetPath, { recursive: true, force: false });
}

async function copyDirectoryFully(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  });
}

async function validateSnapshotCwd(cwd: string): Promise<string> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new SnapshotCwdError("cwd 必须是绝对路径");
  }
  const absoluteCwd = resolve(cwd);
  let metadata;
  try {
    metadata = await stat(absoluteCwd);
  } catch (error) {
    throw new SnapshotCwdError(`cwd 不存在或无法访问：${errorMessage(error)}`);
  }
  if (!metadata.isDirectory()) throw new SnapshotCwdError("cwd 必须是目录");
  return absoluteCwd;
}

async function getFilesystemFreeBytes(snapshotRoot: string): Promise<number> {
  let candidate = resolve(snapshotRoot);
  while (!await pathExists(candidate)) {
    const parent = parse(candidate).root === candidate ? candidate : dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const filesystem = await statfs(candidate);
  return filesystem.bavail * filesystem.bsize;
}

function requiredFreeBytes(totalBytes: number): number {
  return Math.ceil(totalBytes * SPACE_NUMERATOR / SPACE_DENOMINATOR);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (
    (error as NodeJS.ErrnoException).code === "ENOENT"
    || (error as NodeJS.ErrnoException).code === "ENOTDIR"
  ));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
