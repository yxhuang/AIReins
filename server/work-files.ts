import { constants, type Stats } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, realpath, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform, type Platform } from "./platform.js";

/** 文本超过它时预览需前端确认（`large`）后才读取：Markdown/文本框渲染数 MiB 会明显卡顿。 */
export const TEXT_CONFIRM_LIMIT = 4 * 1024 * 1024;
export const FILE_LIMIT = 32 * 1024 * 1024;
export class WorkFileError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export interface WorkFileInput { path: string; root: string; }
export interface WorkFileOptions { sessionCwd?: string; platform?: Platform; large?: boolean; }
export interface WorkFile {
  path: string;
  name: string;
  size: number;
  kind: "text" | "markdown" | "csv" | "tsv" | "html" | "image" | "pdf" | "unsupported";
  mimeType: string;
  text?: string;
  version?: string;
  editable: boolean;
  reason?: string;
  /** 超过 TEXT_CONFIRM_LIMIT 且未带 large：不含 text，等用户确认。 */
  large?: boolean;
}
const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
};
const office = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".docm", ".xlsm", ".pptm"]);
const saves = new Map<string, Promise<void>>();

export function normalizeWorkPath(value: unknown, os: Platform = platform): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WorkFileError(400, "path/root 必须是有效绝对路径");
  }
  let input = value;
  const windows = /^([a-z]):[\\/](.*)$/i.exec(input);
  if (windows && os === "wsl") input = `/mnt/${windows[1]!.toLowerCase()}/${windows[2]!.replace(/\\/g, "/")}`;
  if (!isAbsolute(input) || input.split("/").includes("..")) {
    throw new WorkFileError(400, "path/root 必须是绝对路径且不能含 ..");
  }
  return resolve(input);
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameState(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}
function fileVersion(bytes: Buffer, info: Stats): string {
  return createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}\0`).update(bytes).digest("hex");
}
function fsError(error: unknown): never {
  if (error instanceof WorkFileError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") throw new WorkFileError(404, "文件或目录不存在");
  if (code === "EACCES" || code === "EPERM") throw new WorkFileError(403, "没有文件读取或保存权限");
  if (code === "ELOOP") throw new WorkFileError(409, "文件路径已变化，请重新打开");
  throw error;
}
async function resolveFile(input: WorkFileInput, options: WorkFileOptions) {
  const os = options.platform ?? platform;
  const path = normalizeWorkPath(input.path, os);
  const root = normalizeWorkPath(input.root, os);
  if (!within(root, path)) throw new WorkFileError(403, "文件不在当前目录内");
  const roots = [normalizeWorkPath(process.env.HOME || homedir())];
  // Claude Code 的会话临时目录（scratchpad）：SendUserFile 发给用户的文件常在这里。macOS 上 Claude 默认用 /tmp（真实路径 /private/tmp）。
  // 临时父目录人人可写，只认本用户所有、不是软链、组和其他人无权限的目录，防止他人预先放置的软链扩大授权。
  if (process.getuid) {
    const name = `claude-${process.getuid()}`;
    const bases = process.env.CLAUDE_CODE_TMPDIR ? [process.env.CLAUDE_CODE_TMPDIR] : os === "darwin" ? ["/tmp", "/private/tmp"] : [tmpdir()];
    for (const base of bases) {
      const scratch = join(base, name);
      const info = await lstat(scratch).catch(() => null);
      if (info?.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077)) roots.push(scratch);
    }
  }
  try {
    for (const item of os === "wsl" ? await readdir("/mnt", { withFileTypes: true }) : []) {
      if (/^[a-z]$/i.test(item.name) && item.isDirectory()) roots.push(join("/mnt", item.name));
    }
  } catch { /* 非 WSL 系统没有 /mnt 盘根。 */ }
  if (options.sessionCwd) roots.push(normalizeWorkPath(options.sessionCwd));
  const candidates = roots.filter(allowed => within(allowed, root));
  if (!candidates.length) throw new WorkFileError(403, "当前目录不在授权的主目录、Windows盘或会话目录内");
  try {
    const realRoot = await realpath(root);
    let authorized = false;
    for (const allowed of candidates) {
      if (within(await realpath(allowed), realRoot)) { authorized = true; break; }
    }
    if (!authorized) throw new WorkFileError(403, "当前目录符号链接超出授权根目录");
    if (!(await stat(realRoot)).isDirectory()) throw new WorkFileError(400, "root 必须是目录");
    const real = await realpath(path);
    if (!within(realRoot, real)) throw new WorkFileError(403, "文件符号链接超出当前目录");
    return { path, root, real, realRoot };
  } catch (error) { fsError(error); }
}
async function openFile(input: WorkFileInput, options: WorkFileOptions) {
  const target = await resolveFile(input, options);
  let handle: FileHandle | undefined;
  try {
    // NONBLOCK prevents FIFO/device opens from hanging; NOFOLLOW rejects a replaced final link.
    handle = await open(target.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkFileError(400, "只支持普通文件");
    // BSD fdescfs does not expose the backing pathname. Re-authorize the canonical path
    // and match dev/ino against the NOFOLLOW descriptor before reading any bytes.
    const actual = (options.platform ?? platform) === "darwin" ? target.real : await realpath(`/proc/self/fd/${handle.fd}`);
    const checked = await resolveFile(input, options);
    if (actual !== checked.real || target.realRoot !== checked.realRoot || !sameIdentity(info, await stat(checked.real))) {
      throw new WorkFileError(409, "读取时文件路径已变化，请重新打开");
    }
    return { ...target, handle, info };
  } catch (error) {
    await handle?.close();
    fsError(error);
  }
}
async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  while (length <= limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
    if (!bytesRead) return Buffer.concat(chunks, length);
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  throw new WorkFileError(413, `文件超过 ${limit / 1024 / 1024} MiB`);
}
function decodeText(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WorkFileError(415, "仅支持有效 UTF-8 编码（可保留 BOM）"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new WorkFileError(415, "检测到二进制或控制字符，不能作为文本编辑");
  }
  return text;
}
function metadata(path: string, size: number): WorkFile {
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  if (office.has(ext)) return { path, name, size, kind: "unsupported", mimeType: "application/octet-stream", editable: false, reason: "不支持 Office 文档预览和编辑" };
  if (imageTypes[ext]) return { path, name, size, kind: "image", mimeType: imageTypes[ext]!, editable: false };
  if (ext === ".pdf") return { path, name, size, kind: "pdf", mimeType: "application/pdf", editable: false };
  const kind = [".md", ".markdown"].includes(ext) ? "markdown" : ext === ".csv" ? "csv" : ext === ".tsv" ? "tsv" : [".html", ".htm"].includes(ext) ? "html" : "text";
  const mimeType = kind === "html" ? "text/html; charset=utf-8" : kind === "csv" ? "text/csv; charset=utf-8" : kind === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/plain; charset=utf-8";
  return { path, name, size, kind, mimeType, editable: false };
}
export async function getWorkFile(input: WorkFileInput, options: WorkFileOptions = {}): Promise<WorkFile> {
  const file = await openFile(input, options);
  try {
    const result = metadata(file.path, file.info.size);
    if (result.size > FILE_LIMIT) return { ...result, kind: "unsupported", reason: `文件超过 ${FILE_LIMIT / 1024 / 1024} MiB，无法预览或编辑` };
    if (["image", "pdf", "unsupported"].includes(result.kind)) return result;
    if (result.size > TEXT_CONFIRM_LIMIT && !options.large) return { ...result, large: true };
    const bytes = await readBounded(file.handle, FILE_LIMIT);
    if (!sameState(file.info, await file.handle.stat())) throw new WorkFileError(409, "读取时文件已变化，请重新打开");
    try { result.text = decodeText(bytes); }
    catch (error) {
      if (error instanceof WorkFileError && error.status === 415) return { ...result, kind: "unsupported", reason: error.message };
      throw error;
    }
    result.version = fileVersion(bytes, file.info);
    if ((options.platform ?? platform) === "darwin") {
      result.reason = "macOS 实验性支持仅提供预览，暂不支持安全的原子保存";
      return result;
    }
    try { await access(file.real, constants.W_OK); await access(dirname(file.real), constants.W_OK | constants.X_OK); result.editable = true; }
    catch { result.reason = "没有保存权限，仅可预览"; }
    return result;
  } catch (error) { fsError(error); }
  finally { await file.handle.close(); }
}
export async function getWorkContent(input: WorkFileInput, options: WorkFileOptions = {}): Promise<{ file: WorkFile; bytes: Buffer }> {
  const target = await openFile(input, options);
  try {
    if (target.info.size > FILE_LIMIT) throw new WorkFileError(413, "文件超过 32 MiB，无法通过工作台下载或查看");
    const bytes = await readBounded(target.handle, FILE_LIMIT);
    if (!sameState(target.info, await target.handle.stat())) throw new WorkFileError(409, "读取时文件已变化，请重试");
    return { file: metadata(target.path, bytes.length), bytes };
  } catch (error) { fsError(error); }
  finally { await target.handle.close(); }
}
/** Taildrop 发送源：文件直接流式读取；文件夹先在临时目录打成 zip（tailscale file cp 不收目录）。 */
export async function openWorkSendSource(input: WorkFileInput, options: WorkFileOptions = {}): Promise<{ name: string; stream: Readable; cleanup: () => Promise<void> }> {
  const target = await resolveFile(input, options);
  let info: Stats;
  try { info = await stat(target.real); } catch (error) { fsError(error); }
  if (!info.isDirectory()) {
    const file = await openFile(input, options);
    const stream = file.handle.createReadStream();
    return { name: basename(file.path), stream, cleanup: async () => { stream.destroy(); } };
  }
  if ((options.platform ?? platform) === "darwin") throw new WorkFileError(400, "macOS 实验性支持暂不提供文件夹发送");
  const name = basename(target.path);
  if (!name) throw new WorkFileError(400, "不能发送根目录");
  const temporary = await mkdtemp(join(tmpdir(), "wb-taildrop-"));
  const archive = join(temporary, `${name}.zip`);
  let directory: FileHandle | undefined;
  let zipping = false;
  try {
    // 与 openFile 同样锚定 fd：检查后祖先目录被换成链接也只会打包已检查的那个目录。
    directory = await open(target.real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const checked = await resolveFile(input, options);
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== checked.real) throw new WorkFileError(409, "读取时文件夹路径已变化，请重试");
    // -y 把符号链接存成链接本身，不跟随到授权根目录之外；条目不带顶层目录，解压时按 zip 名建文件夹。
    zipping = true;
    await promisify(execFile)("zip", ["-r", "-y", "-q", archive, "."], { cwd: `/proc/${process.pid}/fd/${directory.fd}`, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    zipping = false;
    const handle = await open(archive, constants.O_RDONLY);
    const stream = handle.createReadStream();
    return { name: `${name}.zip`, stream, cleanup: async () => { stream.destroy(); await rm(temporary, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (!zipping) fsError(error);
    const failure = error as Omit<NodeJS.ErrnoException, "code"> & { code?: string | number; killed?: boolean; stderr?: string };
    if (failure.code === 12) throw new WorkFileError(400, "文件夹为空，没有可发送的内容");
    throw new WorkFileError(500, failure.code === "ENOENT" ? "服务器未安装 zip，无法发送文件夹" : failure.killed ? "打包文件夹超时（10 分钟）" : `打包文件夹失败：${failure.stderr?.trim() || failure.message}`);
  } finally { await directory?.close(); }
}
export async function saveWorkFile(input: WorkFileInput & { version: string; text: string }, options: WorkFileOptions = {}): Promise<WorkFile> {
  if ((options.platform ?? platform) === "darwin") throw new WorkFileError(400, "macOS 实验性支持暂不提供文件编辑");
  if (typeof input.version !== "string" || !/^[a-f0-9]{64}$/.test(input.version) || typeof input.text !== "string") {
    throw new WorkFileError(400, "保存必须提供有效 version 和 text");
  }
  if (Buffer.byteLength(input.text, "utf8") > FILE_LIMIT) throw new WorkFileError(413, "保存文本超过 32 MiB");
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.toString("utf8") !== input.text) throw new WorkFileError(415, "文本含无效 Unicode，不能保存为 UTF-8");
  decodeText(bytes);
  const initial = await openFile(input, options);
  const key = `${initial.info.dev}:${initial.info.ino}`;
  await initial.handle.close();
  const previous = saves.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>(done => { unlock = done; });
  saves.set(key, current);
  await previous;
  try { return await saveLocked(input, options, bytes); }
  finally { unlock(); if (saves.get(key) === current) saves.delete(key); }
}
async function saveLocked(input: WorkFileInput & { version: string; text: string }, options: WorkFileOptions, bytes: Buffer): Promise<WorkFile> {
  const file = await openFile(input, options);
  let directory: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    const meta = metadata(file.path, file.info.size);
    if (["image", "pdf", "unsupported"].includes(meta.kind)) throw new WorkFileError(415, "此格式不支持编辑");
    if (file.info.size > FILE_LIMIT) throw new WorkFileError(413, "原文件超过 32 MiB，不能编辑");
    const original = await readBounded(file.handle, FILE_LIMIT);
    decodeText(original);
    if (!sameState(file.info, await file.handle.stat()) || fileVersion(original, file.info) !== input.version) throw new WorkFileError(409, "磁盘文件已修改，请重新加载后再保存");
    await access(file.real, constants.W_OK);
    const parent = dirname(file.real);
    directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const anchor = `/proc/self/fd/${directory.fd}`;
    if (await realpath(anchor) !== parent) throw new WorkFileError(409, "保存目录已变化");
    const temporaryName = join(anchor, `.workbench-save-${randomUUID()}`);
    const temp = await open(temporaryName, "wx", file.info.mode & 0o7777);
    temporary = temporaryName;
    try { await temp.writeFile(bytes); await temp.chmod(file.info.mode & 0o7777); await temp.sync(); }
    finally { await temp.close(); }
    const checked = await resolveFile(input, options);
    const latest = await readBounded(file.handle, FILE_LIMIT);
    if (checked.real !== file.real || checked.realRoot !== file.realRoot || await realpath(anchor) !== parent ||
        !sameState(file.info, await stat(join(anchor, basename(file.real)))) ||
        !sameState(file.info, await file.handle.stat()) || fileVersion(latest, file.info) !== input.version) {
      throw new WorkFileError(409, "保存前磁盘文件或路径已修改，请重新加载");
    }
    // The parent fd anchors both names. External writers still have a small check→rename window.
    await rename(temporary, join(anchor, basename(file.real)));
    temporary = undefined;
    const info = await stat(join(anchor, basename(file.real)));
    return { ...meta, size: bytes.length, text: input.text, version: fileVersion(bytes, info), editable: true };
  } catch (error) { return fsError(error); }
  finally {
    // Only remove the unique temporary name that this request created, while its parent fd is open.
    if (temporary) await unlink(temporary).catch(() => undefined);
    await directory?.close();
    await file.handle.close();
  }
}
