import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { mergeHistoryMessages, parseHistoryMessages, type HistoryMessage } from "./history.js";
import { boundExternalMessages, NativeConversationReader } from "./native-conversation.js";
import type { AgentKind, SessionRecord } from "./types.js";

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
  parent: { agent: string; sessionId: string | null; entrypoint: string | null; model: string | null; runId?: string } | null;
  promptHead: string | null;
  subagents?: CodexSubagent[];
}

export interface CodexSubagent {
  threadId: string;
  nickname: string;
  role: string | null;
  depth: number;
  parentThreadId: string;
  status: "running" | "finished" | "unknown";
  startedAt: string | null;
  lastActivityAt: string;
  activity?: string;
}

interface SubagentSnapshot {
  agent: CodexSubagent;
  lifecycle: "active" | "finished" | "unknown";
  mtimeMs: number;
}

/** Only session_meta's first line (<=64 KiB) and the last 64 KiB; never parse the body. */
export async function readCodexSubagent(path: string): Promise<SubagentSnapshot | null> {
  const file = await openFile(dirname(path), basename(path));
  if (!file) return null;
  try {
    const { size, mtimeMs } = await file.stat();
    let head = Buffer.alloc(0);
    while (head.length < CHUNK_SIZE && head.length < size && !head.includes(10)) {
      const chunk = await readBytes(file, head.length, Math.min(4096, CHUNK_SIZE - head.length, size - head.length));
      if (!chunk.length) break; // A writer may truncate the file after stat.
      head = Buffer.concat([head, chunk]);
    }
    const newline = head.indexOf(10);
    if (newline < 0) return null; // Partial/oversized metadata is not a usable session.
    const row = JSON.parse(head.subarray(0, newline).toString("utf8"));
    if (row.type !== "session_meta") return null;
    const meta = row.payload;
    const spawn = meta?.source?.subagent?.thread_spawn;
    const parentThreadId = stringValue(meta?.parent_thread_id) ?? stringValue(spawn?.parent_thread_id);
    const threadId = stringValue(meta?.id);
    if ((!spawn && meta?.thread_source !== "subagent") || !parentThreadId || !threadId) return null;
    const offset = Math.max(0, size - CHUNK_SIZE);
    const lines = (await readBytes(file, offset, size - offset)).toString("utf8").split("\n");
    if (offset) lines.shift();
    if (lines.at(-1) !== "") lines.pop(); // An appending writer can leave an incomplete last line.
    let lifecycle: SubagentSnapshot["lifecycle"] = "unknown";
    let lastActivityAt = stringValue(meta.timestamp) ?? new Date(mtimeMs).toISOString();
    let activity: string | undefined;
    // Real 0.159.2 Carver rollout: task_started -> item_completed/token_count -> task_complete.
    // item_completed alone is NOT a turn completion. A later task_started reopens the agent.
    // final_answer is a fallback when task_complete has not yet been flushed; stale active
    // files (>5 minutes without a write) are unknown, never guessed finished from mtime.
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (Number.isFinite(Date.parse(event.timestamp))) lastActivityAt = event.timestamp;
        const payload = event.payload;
        if (event.type === "event_msg") {
          if (["task_complete", "turn_aborted"].includes(payload?.type)) lifecycle = "finished";
          else if (payload?.type === "task_started" || payload?.type === "user_message") {
            lifecycle = "active"; activity = undefined;
          } else if (payload?.type === "agent_message" || payload?.type === "agent_reasoning") {
            if (lifecycle !== "finished") lifecycle = "active";
            activity = stringValue(payload.message) ?? activity;
          } else if (payload?.type === "item_completed" && lifecycle === "unknown") lifecycle = "active";
        } else if (event.type === "response_item") {
          if (payload?.type === "message" && payload.role === "assistant") {
            if (payload.phase === "final_answer" || payload.phase === "final") lifecycle = "finished";
            else {
              lifecycle = "active";
              activity = payload.content?.find((part: { text?: string }) => typeof part.text === "string")?.text ?? activity;
            }
          } else if (["function_call", "custom_tool_call", "reasoning"].includes(payload?.type)) {
            lifecycle = "active";
            if (payload.name) activity = `调用 ${payload.name}`;
          }
        }
      } catch { /* Malformed/boundary lines do not hide the other agents. */ }
    }
    return { lifecycle, mtimeMs, agent: {
      threadId, parentThreadId,
      nickname: stringValue(meta.agent_nickname) ?? stringValue(spawn?.agent_nickname) ?? threadId.slice(0, 8),
      role: stringValue(meta.agent_role) ?? stringValue(spawn?.agent_role),
      depth: numberValue(spawn?.depth) ?? 1, status: "unknown",
      startedAt: stringValue(meta.timestamp) ?? stringValue(row.timestamp), lastActivityAt,
      ...(activity ? { activity: activity.replace(/\s+/gu, " ").trim().slice(0, 160) } : {}),
    } };
  } finally { await file.close(); }
}

/** Parsed snapshots cache by path + mtime + size; caller's shared 2s scan owns enumeration. */
export function createCodexSubagentReader(read = readCodexSubagent) {
  const cache = new Map<string, { fingerprint: string; value: Promise<SubagentSnapshot | null> }>();
  return async (runs: Dispatch[], root: string, now = Date.now()): Promise<void> => {
    const codex = runs.filter((run) => run.tool === "codex");
    if (!codex.length) return;
    for (const run of codex) run.subagents = [];
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(root); } catch { return; }
    const dates = new Set<string>();
    for (const run of codex) {
      if (!run.session) continue;
      // Include local and UTC start dates: native folder names and metadata timestamps
      // differ across midnight. Only +/-1 day, never a recursive history-directory scan.
      for (const day of [run.startedAt?.slice(0, 10), run.startedAt ? new Date(run.startedAt).toJSON()?.slice(0, 10) : null]) {
        if (!day) continue;
        const start = Date.parse(`${day}T00:00:00Z`);
        if (!Number.isFinite(start)) continue;
        for (const delta of [-1, 0, 1]) dates.add(new Date(start + delta * 86400_000).toISOString().slice(0, 10).replaceAll("-", "/"));
      }
    }
    const agents = new Map<string, CodexSubagent>();
    for (const day of dates) {
      const directory = join(canonicalRoot, day);
      try {
        if (await realpath(directory) !== directory) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^rollout-.*\.jsonl$/u.test(entry.name)) continue;
          try {
            const path = join(directory, entry.name);
            const info = await stat(path);
            const fingerprint = `${info.mtimeMs}:${info.size}`;
            let snapshot = cache.get(path);
            if (!snapshot || snapshot.fingerprint !== fingerprint) {
              snapshot = { fingerprint, value: read(path) };
              cache.delete(path);
              if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
              cache.set(path, snapshot);
            }
            const value = await snapshot.value;
            if (value) agents.set(value.agent.threadId, { ...value.agent,
              status: value.lifecycle === "finished" ? "finished"
                : value.lifecycle === "active" && now - value.mtimeMs <= 300_000 ? "running" : "unknown",
            });
          } catch { /* Inaccessible/invalid rollout is isolated. */ }
        }
      } catch { /* Missing adjacent date directory. */ }
    }
    for (const run of codex) {
      let parents = new Set(run.session ? [run.session] : []);
      const seen = new Set(parents);
      for (let depth = 1; depth <= 2; depth++) {
        const children = [...agents.values()].filter((agent) => parents.has(agent.parentThreadId) && !seen.has(agent.threadId))
          .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.threadId.localeCompare(b.threadId));
        parents = new Set(children.map((agent) => agent.threadId));
        for (const agent of children) { seen.add(agent.threadId); run.subagents!.push({ ...agent, depth }); }
      }
    }
  };
}

const attachCodexSubagents = createCodexSubagentReader();

export interface DispatchDetail extends Dispatch {
  prompt: string | null;
  promptTruncated: boolean;
  summary: string | null;
  final: string | null;
  accept: string | null;
  acceptResult: string | null;
  resume: string | null;
  credits: number | null;
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

const parentModelCache = new Map<string, { expiresAt: number; value: Promise<string | null> }>();

/** 最多读末尾 1 MiB；最后一条 assistant 缺 model 时返回 null，不借更早的模型冒充。 */
export async function readClaudeTranscriptModel(path: string): Promise<string | null> {
  try {
    const input = await readText(dirname(path), basename(path), 1024 * 1024, true);
    if (!input) return null;
    const lines = input.text.split("\n");
    if (input.truncated) lines.shift(); // 窗口起点可能落在 JSON 行中间。
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const row = JSON.parse(lines[index]!);
        if (row?.type === "assistant") return typeof row.message?.model === "string" && row.message.model ? row.message.model : null;
      } catch { /* 跳过损坏行或尚未写完的尾行。 */ }
    }
  } catch { /* 不存在或不可读的原生 transcript 不影响派单列表。 */ }
  return null;
}

/** 缓存命中和空结果 30 秒；同一会话的并发读取复用 Promise，最多保留 256 项。 */
export async function readClaudeParentModel(sessionId: string | null, projectsRoot = join(homedir(), ".claude", "projects")): Promise<string | null> {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const key = `${projectsRoot}/${sessionId}`;
  const cached = parentModelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const model = await readClaudeTranscriptModel(join(projectsRoot, entry.name, `${sessionId}.jsonl`));
        if (model) return model;
      }
    } catch { /* 原生目录不存在。 */ }
    return null;
  })();
  parentModelCache.delete(key);
  if (parentModelCache.size >= 256) parentModelCache.delete(parentModelCache.keys().next().value!);
  parentModelCache.set(key, { expiresAt: Date.now() + 30_000, value });
  return value;
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

async function readDispatch(runId: string, directory: string, includePrompt = true): Promise<Dispatch> {
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
          model: agent === "claude" ? await readClaudeParentModel(stringValue(input.sessionId)) : null,
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
  try { if (includePrompt) result.promptHead = await promptHead(directory); }
  catch { result.status = "unknown"; }
  return result;
}

export async function listDispatches(limit: string | number | null = null, root = rootDirectory()): Promise<Dispatch[]> {
  const raw = limit === null ? 50 : Number(limit);
  const count = Number.isFinite(raw) && raw >= 1 ? Math.min(200, Math.floor(raw)) : 50;
  const dispatches = (await allDispatches(root)).sort((a, b) => a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0).slice(0, count);
  await Promise.all(dispatches.map(async (run) => {
    const directory = await resolveRun(run.runId, root);
    try { if (directory) run.promptHead = await promptHead(directory); } catch { run.status = "unknown"; }
  }));
  return dispatches;
}

export async function getDispatch(runId: string, root = rootDirectory()): Promise<DispatchDetail | null> {
  const directory = await resolveRun(runId, root);
  if (!directory) return null;
  const dispatch = (await allDispatches(root)).find((run) => run.runId === runId);
  if (!dispatch) return null;
  try { dispatch.promptHead = await promptHead(directory); } catch { dispatch.status = "unknown"; }
  const readOptional = async (filename: string, limit?: number, tail = false) => {
    try { return await readText(directory, filename, limit, tail); }
    catch { dispatch.status = "unknown"; return null; }
  };
  const prompt = await readOptional("prompt.txt", CHUNK_SIZE);
  const summary = await readOptional("summary.txt");
  const final = await readOptional("last.txt", 8 * 1024, true);
  const accept = await readOptional("accept.log", 4 * 1024, true);
  let usage: Record<string, unknown> | null = null;
  let metadata: Record<string, unknown> | null = null;
  try { usage = await readJson(directory, "usage.json"); } catch { /* Optional usage. */ }
  try { metadata = await readJson(directory, "run.json"); } catch { /* Legacy directory. */ }
  return {
    ...dispatch, prompt: prompt?.text ?? null, promptTruncated: prompt?.truncated ?? false,
    summary: summary?.text ?? null, final: final?.text ?? null, accept: accept?.text ?? null,
    acceptResult: summary?.text.match(/^ACCEPT\s+(.+)$/m)?.[1]?.trim() ?? null,
    resume: summary?.text.match(/^RESUME\s+(.+)$/m)?.[1]?.trim() ?? stringValue(metadata?.resume),
    credits: numberValue(usage?.totalNanoAiu) !== null ? numberValue(usage?.totalNanoAiu)! / 1e9
      : numberValue(summary?.text.match(/^STATUS\b.*?\bcredits\s+([\d.]+)/m)?.[1] ? Number(summary.text.match(/\bcredits\s+([\d.]+)/)?.[1]) : null),
  };
}

/** No list cap: history and parent links must include older-started, still-running jobs. */
async function scanDispatches(root: string): Promise<Dispatch[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const result: Dispatch[] = [];
  for (const entry of entries) {
    if (!validId(entry.name)) continue;
    const directory = await resolveRun(entry.name, root);
    if (directory) result.push(await readDispatch(entry.name, directory, false));
  }
  await attachCodexSubagents(result, process.env.WORKBENCH_CODEX_HISTORY_DIR || join(homedir(), ".codex", "sessions"));
  return result;
}

/** 每个 root 共享一次在途扫描；TTL 从扫描完成起算，失败不缓存。 */
export function createDispatchScanCache(scan: (root: string) => Promise<Dispatch[]>, now = Date.now) {
  const cache = new Map<string, { expires: number; pending: Promise<Dispatch[]> }>();
  return async (root: string): Promise<Dispatch[]> => {
    let entry = cache.get(root);
    if (!entry || entry.expires <= now()) {
      entry = { expires: Infinity, pending: Promise.resolve().then(() => scan(root)) };
      cache.set(root, entry);
      const current = entry;
      try {
        await current.pending;
        current.expires = now() + 2000;
      } catch (error) {
        if (cache.get(root) === current) cache.delete(root);
        throw error;
      }
    }
    // 调用方补 prompt 或详情错误状态时不得污染共享扫描结果。
    return (await entry.pending).map((run) => ({ ...run, ...(run.parent ? { parent: { ...run.parent } } : {}),
      ...(run.subagents ? { subagents: run.subagents.map((agent) => ({ ...agent })) } : {}),
    }));
  };
}

const allDispatches = createDispatchScanCache(scanDispatches, () => Date.now());

export async function listParentDispatches(parent: string, root = rootDirectory()): Promise<Dispatch[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parent)) throw new DispatchQueryError("parent 必须是原生会话 ID");
  return (await allDispatches(root)).filter((run) => run.status === "running"
    && run.parent?.agent === "claude" && run.parent.sessionId === parent);
}

function endedTime(run: Dispatch): number {
  const explicit = Date.parse(run.endedAt ?? "");
  if (Number.isFinite(explicit)) return explicit;
  const start = Date.parse(run.startedAt ?? "");
  return Number.isFinite(start) && run.elapsedS !== null ? start + run.elapsedS * 1000 : NaN;
}

export async function listDispatchHistory(offset: string | null, root = rootDirectory(), now = Date.now()) {
  const position = offset === null ? 0 : Number(offset);
  if (offset === "" || !Number.isSafeInteger(position) || position < 0) throw new DispatchQueryError("offset 必须是非负安全整数");
  const runs = (await allDispatches(root)).filter((run) => run.status !== "running"
    && Number.isFinite(endedTime(run)) && endedTime(run) <= now && endedTime(run) >= now - 7 * 86400_000)
    .sort((a, b) => endedTime(b) - endedTime(a) || b.runId.localeCompare(a.runId));
  const page = runs.slice(position, position + 20);
  await Promise.all(page.map(async (run) => {
    const directory = await resolveRun(run.runId, root);
    try { if (directory) run.promptHead = await promptHead(directory); } catch { /* Optional title preview. */ }
  }));
  return { dispatches: page, total: runs.length,
    nextOffset: position + 20 < runs.length ? position + 20 : null };
}

export interface DispatchMessages {
  source: "native" | "stdout";
  agent?: AgentKind;
  messages: HistoryMessage[];
  replaceFrom: number;
  cursor: string | null;
  truncated: boolean;
}

const messageSnapshots = new Map<string, { cursor: string; messages: HistoryMessage[] }>();
let nativeReader: NativeConversationReader | undefined;

/** Existing native path validation + history normalization; wire deltas also replace updated tool results. */
export async function getDispatchMessages(runId: string, cursor: string | null, root = rootDirectory(), reader?: NativeConversationReader): Promise<DispatchMessages | null> {
  const directory = await resolveRun(runId, root);
  if (!directory) return null;
  const run = await readDispatch(runId, directory, false);
  const fallback: DispatchMessages = { source: "stdout", messages: [], replaceFrom: 0, cursor: null, truncated: false };
  if (!run.session || !["codex", "kimi"].includes(run.tool)) return fallback;
  const agent = run.tool as AgentKind;
  try {
    const mark = await (reader ?? (nativeReader ??= new NativeConversationReader())).capture({ agent, nativeSessionId: run.session } as SessionRecord);
    if (!mark) return fallback;
    const file = await open(mark.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    let start: number;
    try {
      const size = (await file.stat()).size;
      start = Math.max(0, size - 4 * 1024 * 1024);
      text = (await readBytes(file, start, size - start)).toString("utf8");
    } finally { await file.close(); }
    // I/O framing only: all native record interpretation stays in history.ts.
    const lines: { text: string; startOffset: number }[] = [];
    let position = start;
    for (const [index, line] of text.split("\n").entries()) {
      if (!(start > 0 && index === 0)) lines.push({ text: line, startOffset: position });
      position += Buffer.byteLength(line) + 1;
    }
    const normalized = mergeHistoryMessages(parseHistoryMessages(agent, lines));
    const bounded = boundExternalMessages(run.session, normalized.slice(-400).map(({ startOffset: _offset, ...message }) => message));
    const messages = bounded.messages;
    const nextCursor = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    const key = `${directory}:${run.session}`;
    const previous = messageSnapshots.get(key);
    let replaceFrom = 0;
    if (cursor === nextCursor) replaceFrom = messages.length;
    else if (cursor && previous?.cursor === cursor) {
      while (replaceFrom < messages.length && replaceFrom < previous.messages.length
        && JSON.stringify(messages[replaceFrom]) === JSON.stringify(previous.messages[replaceFrom])) replaceFrom++;
    }
    messageSnapshots.delete(key);
    if (messageSnapshots.size >= 32) messageSnapshots.delete(messageSnapshots.keys().next().value!);
    messageSnapshots.set(key, { cursor: nextCursor, messages });
    return { source: "native", agent, messages: messages.slice(replaceFrom), replaceFrom, cursor: nextCursor,
      truncated: start > 0 || normalized.length > 400 || bounded.truncated };
  } catch { return fallback; }
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
