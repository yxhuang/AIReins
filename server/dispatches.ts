import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const RUN_ID = /^(\d{8})-(\d{6})-(codex|kimi|copilot)-(.*)$/u;
const CHUNK_SIZE = 64 * 1024;
const STATUSES = new Set(["running", "OK", "TOOL_FAIL", "ACCEPT_FAIL", "TIMEOUT"]);

export interface Dispatch {
  runId: string;
  tool: string;
  name: string;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsedS: number | null;
  exit: number | null;
  files: number | null;
  session: string | null;
  parent: { agent: string; sessionId: string | null; entrypoint: string | null; runId?: string } | null;
  promptHead: string | null;
}

export interface DispatchDetail extends Dispatch {
  prompt: string | null;
  promptTruncated: boolean;
  summary: string | null;
  final: string | null;
  accept: string | null;
}

export interface DispatchLog {
  text: string;
  nextOffset: number;
  size: number;
  eof: boolean;
  reset?: true;
}

export class DispatchQueryError extends Error {}

export interface DispatchSession { runId: string; name: string }

let sessionMapCache: { root: string; expiresAt: number; value: Promise<Map<string, DispatchSession>> } | undefined;

/** Metadata only: never read prompts/logs, and do not apply the dispatch list's 200-row cap. */
export async function dispatchSessionMap(root = rootDirectory()): Promise<Map<string, DispatchSession>> {
  if (sessionMapCache?.root === root && sessionMapCache.expiresAt > Date.now()) return sessionMapCache.value;
  const value = (async () => {
    const result = new Map<string, DispatchSession>();
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { return result; }
    const names = entries.filter((entry) => entry.isDirectory() && validId(entry.name)).map((entry) => entry.name).sort().reverse();
    for (const runId of names) {
      try {
        const directory = await resolveRun(runId, root);
        if (!directory) continue;
        const run = await readJson(directory, "run.json");
        if (run && run.schema !== 1) continue;
        const data = run ?? await readJson(directory, "meta.json");
        const session = stringValue(data?.session);
        if (session && !result.has(session)) result.set(session, {
          runId, name: stringValue(data?.name) ?? RUN_ID.exec(runId)![4]!,
        });
      } catch { /* One broken directory must not hide other dispatch sessions. */ }
    }
    return result;
  })();
  sessionMapCache = { root, expiresAt: Date.now() + 30_000, value };
  return value;
}

function rootDirectory(): string {
  return process.env.WB_DELEGATE_DIR || join(homedir(), ".cache", "delegate");
}

function validId(runId: string): boolean {
  return RUN_ID.test(runId) && !runId.includes("/") && !runId.includes("\\") && !runId.includes("..");
}

/** Both the requested and resolved directory must be immediate children of the root. */
async function resolveRun(runId: string, root: string): Promise<string | null> {
  if (!validId(runId)) return null;
  try {
    const canonicalRoot = await realpath(root);
    const directory = await realpath(join(canonicalRoot, runId));
    if (dirname(directory) !== canonicalRoot || !(await stat(directory)).isDirectory()) return null;
    return directory;
  } catch {
    return null;
  }
}

/** Only fixed filenames are used; reject symlinked files as well as directory escapes. */
async function openFile(directory: string, filename: string): Promise<FileHandle | null> {
  const path = join(directory, filename);
  let file: FileHandle | undefined;
  try {
    if (await realpath(path) !== path) throw new Error("派单文件不是目录内的普通文件");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw new Error("派单文件不是普通文件");
    return file;
  } catch (error) {
    await file?.close();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readBytes(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, offset + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function utf8Prefix(buffer: Buffer): string {
  // Do not flush: a character split at the byte cap belongs to the next read.
  return new StringDecoder("utf8").write(buffer);
}

async function readText(directory: string, filename: string, limit?: number, tail = false): Promise<{ text: string; truncated: boolean } | null> {
  const file = await openFile(directory, filename);
  if (!file) return null;
  try {
    const { size } = await file.stat();
    const length = Math.min(size, limit ?? size);
    const buffer = await readBytes(file, tail ? size - length : 0, length);
    if (tail && size > length) {
      let start = 0;
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
      return { text: buffer.subarray(start).toString("utf8"), truncated: true };
    }
    return { text: size > length ? utf8Prefix(buffer) : buffer.toString("utf8"), truncated: size > length };
  } finally {
    await file.close();
  }
}

async function readJson(directory: string, filename: string): Promise<Record<string, unknown> | null> {
  const input = await readText(directory, filename, CHUNK_SIZE);
  if (!input) return null;
  if (input.truncated) throw new Error("派单元数据过大");
  const value: unknown = JSON.parse(input.text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("派单元数据不是对象");
  return value as Record<string, unknown>;
}

async function promptHead(directory: string): Promise<string | null> {
  const file = await openFile(directory, "prompt.txt");
  if (!file) return null;
  try {
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    let head = "";
    let count = 0;
    for (;;) {
      const buffer = await readBytes(file, offset, CHUNK_SIZE);
      offset += buffer.length;
      const text = buffer.length ? decoder.write(buffer) : decoder.end();
      for (const character of text) {
        if (character === "\n") {
          if (head.trim()) return head.trim();
          head = "";
          count = 0;
        } else if (head || character.trim()) {
          head += character;
          if (++count === 160) return head.trim();
        }
      }
      if (!buffer.length) return head.trim() || null;
    }
  } finally {
    await file.close();
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "?" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function startFromId(runId: string): string | null {
  const match = RUN_ID.exec(runId)!;
  const date = match[1]!;
  const time = match[2]!;
  const value = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

async function readDispatch(runId: string, directory: string): Promise<Dispatch> {
  const match = RUN_ID.exec(runId)!;
  const result: Dispatch = {
    runId, tool: match[3]!, name: match[4]!, cwd: null, model: null, effort: null,
    status: "unknown", startedAt: startFromId(runId), endedAt: null, elapsedS: null,
    exit: null, files: null, session: null, parent: null, promptHead: null,
  };
  try {
    const run = await readJson(directory, "run.json");
    if (run && run.schema !== 1) throw new Error("不支持的派单 schema");
    const data = run ?? await readJson(directory, "meta.json");
    if (data) {
      result.name = stringValue(data.name) ?? result.name;
      result.cwd = stringValue(data.cwd);
      result.model = stringValue(data.model);
      result.effort = stringValue(data.effort);
      result.status = typeof data.status === "string" && STATUSES.has(data.status) ? data.status : "unknown";
      result.startedAt = stringValue(data.startedAt) ?? result.startedAt;
      result.endedAt = stringValue(data.endedAt);
      result.elapsedS = numberValue(data.elapsed_s);
      result.exit = numberValue(data.exit);
      result.files = numberValue(data.files);
      result.session = stringValue(data.session);
      const parent = data.parent;
      if (parent && typeof parent === "object" && !Array.isArray(parent)) {
        const input = parent as Record<string, unknown>;
        const agent = stringValue(input.agent);
        if (agent) result.parent = {
          agent, sessionId: stringValue(input.sessionId), entrypoint: stringValue(input.entrypoint),
          ...(typeof input.runId === "string" ? { runId: input.runId } : {}),
        };
      }
      if (run && result.status === "running" && !result.endedAt) {
        const pid = numberValue(run.pid);
        if (!pid || !Number.isSafeInteger(pid) || pid <= 0) result.status = "unknown";
        else {
          try { process.kill(pid, 0); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ESRCH") result.status = "lost";
            else if (code !== "EPERM") result.status = "unknown";
          }
        }
      }
    }
  } catch {
    result.status = "unknown";
  }
  try {
    if (result.tool === "codex" && !result.session) {
      const stderr = await readText(directory, "stderr.log", 8 * 1024);
      result.session = stderr?.text.match(/^\s*session id:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*$/imu)?.[1] ?? null;
    }
  } catch {
    result.status = "unknown";
  }
  try { result.promptHead = await promptHead(directory); }
  catch { result.status = "unknown"; }
  return result;
}

export async function listDispatches(limit: string | number | null = null, root = rootDirectory()): Promise<Dispatch[]> {
  const raw = limit === null ? 50 : Number(limit);
  const count = Number.isFinite(raw) && raw >= 1 ? Math.min(200, Math.floor(raw)) : 50;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const names = entries.filter((entry) => validId(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name).sort().reverse();
  const dispatches: Dispatch[] = [];
  for (const runId of names) {
    const directory = await resolveRun(runId, root);
    if (!directory) continue;
    dispatches.push(await readDispatch(runId, directory));
    if (dispatches.length === count) break;
  }
  return dispatches;
}

export async function getDispatch(runId: string, root = rootDirectory()): Promise<DispatchDetail | null> {
  const directory = await resolveRun(runId, root);
  if (!directory) return null;
  const dispatch = await readDispatch(runId, directory);
  const readOptional = async (filename: string, limit?: number, tail = false) => {
    try { return await readText(directory, filename, limit, tail); }
    catch { dispatch.status = "unknown"; return null; }
  };
  const prompt = await readOptional("prompt.txt", CHUNK_SIZE);
  const summary = await readOptional("summary.txt");
  const final = await readOptional("last.txt", 8 * 1024, true);
  const accept = await readOptional("accept.log", 4 * 1024, true);
  return {
    ...dispatch, prompt: prompt?.text ?? null, promptTruncated: prompt?.truncated ?? false,
    summary: summary?.text ?? null, final: final?.text ?? null, accept: accept?.text ?? null,
  };
}

export async function getDispatchLog(
  runId: string, stream = "stdout", offset: string | number | null = null, root = rootDirectory(),
): Promise<DispatchLog | null> {
  const directory = await resolveRun(runId, root);
  if (!directory) return null;
  if (stream !== "stdout" && stream !== "stderr") throw new DispatchQueryError("stream 必须是 stdout 或 stderr");
  const position = offset === null ? null : Number(offset);
  if (position !== null && (!Number.isSafeInteger(position) || position < 0 || offset === "")) {
    throw new DispatchQueryError("offset 必须是非负安全整数（字节）");
  }
  let file;
  try { file = await openFile(directory, `${stream}.log`); }
  catch { return null; }
  if (!file) return { text: "", nextOffset: 0, size: 0, eof: true, ...(position !== null && position > 0 ? { reset: true } : {}) };
  try {
    const { size } = await file.stat();
    const reset = position !== null && position > size;
    let start = reset ? 0 : position ?? Math.max(0, size - 16 * 1024);
    const length = Math.min(position === null ? 16 * 1024 : CHUNK_SIZE, size - start);
    const buffer = await readBytes(file, start, length);
    let first = 0;
    if (position === null && start > 0 && (await readBytes(file, start - 1, 1))[0] !== 10) {
      const newline = buffer.indexOf(10);
      first = newline === -1 ? 0 : newline + 1;
      if (first >= buffer.length) { // 尾部 16KB 全落在一条长行里：从字符边界起给出这段，而不是空
        first = 0;
        while (first < buffer.length && (buffer[first]! & 0xc0) === 0x80) first++;
      }
    } else if (position !== null) {
      while (first < buffer.length && (buffer[first]! & 0xc0) === 0x80) first++;
    }
    let last = buffer.lastIndexOf(10) + 1;
    if (last <= first && buffer.length === length && start + length < size) {
      // 整块读满仍无换行（codex stderr 实测有 1MB 的单行）：按 UTF-8 字符边界切出，否则 offset 永远推不动
      if (position === null) while (first < buffer.length && (buffer[first]! & 0xc0) === 0x80) first++;
      last = utf8Boundary(buffer, first);
    } else if (last < first) first = 0; // No complete line: keep the caller's offset for the next read.
    start += first;
    const complete = buffer.subarray(first, Math.max(first, last));
    const nextOffset = start + complete.length;
    return { text: complete.toString("utf8"), nextOffset, size, eof: nextOffset >= size, ...(reset ? { reset: true } : {}) };
  } finally {
    await file.close();
  }
}

/** buffer 末尾若停在多字节字符中间，退回到该字符起点；返回可安全解码的结束位置。 */
function utf8Boundary(buffer: Buffer, from: number): number {
  let lead = buffer.length - 1;
  while (lead > from && (buffer[lead]! & 0xc0) === 0x80) lead--;
  const byte = buffer[lead] ?? 0;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + width > buffer.length ? lead : buffer.length;
}
