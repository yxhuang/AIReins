import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { HistoryIndex, mergeHistoryMessages, parseHistoryMessages, type HistoryMessage } from "./history.js";
import { boundExternalMessages, NativeConversationReader } from "./native-conversation.js";
import type { AgentKind, SessionRecord } from "./types.js";

const RUN_ID = /^(\d{8})-(\d{6})-(codex|kimi|copilot|claude)-(.*)$/u;
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
  parent: { agent: string; sessionId: string | null; entrypoint: string | null; model: string | null; title?: string | null; runId?: string } | null;
  promptHead: string | null;
  subagents?: CodexSubagent[];
  agentType?: string | null;
  /** Native child records have no delegate prompt/log files and are display-only. */
  native?: boolean;
}

interface CodexSubagent {
  threadId: string;
  nickname: string;
  role: string | null;
  depth: number;
  parentThreadId: string;
  status: "running" | "finished" | "unknown";
  startedAt: string | null;
  lastActivityAt: string;
  activity?: string;
  model?: string | null;
  effort?: string | null;
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
    let model: string | null = null;
    let effort: string | null = null;
    // Real 0.159.2 Carver rollout: task_started -> item_completed/token_count -> task_complete.
    // item_completed alone is NOT a turn completion. A later task_started reopens the agent.
    // final_answer is a fallback when task_complete has not yet been flushed; stale active
    // files (>5 minutes without a write) are unknown, never guessed finished from mtime.
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (Number.isFinite(Date.parse(event.timestamp))) lastActivityAt = event.timestamp;
        const payload = event.payload;
        if (event.type === "turn_context") {
          model = stringValue(payload?.model) ?? model;
          effort = stringValue(payload?.effort) ?? stringValue(payload?.reasoning_effort) ?? effort;
        }
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
      model, effort,
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
      for (const day of [run.startedAt?.slice(0, 10), run.startedAt ? new Date(run.startedAt).toJSON()?.slice(0, 10) : null,
        new Date(now).toISOString().slice(0, 10)]) {
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
      for (let depth = 1; parents.size; depth++) {
        const children = [...agents.values()].filter((agent) => parents.has(agent.parentThreadId) && !seen.has(agent.threadId))
          .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.threadId.localeCompare(b.threadId));
        parents = new Set(children.map((agent) => agent.threadId));
        for (const agent of children) { seen.add(agent.threadId); run.subagents!.push({ ...agent, depth }); }
      }
    }
  };
}

const attachCodexSubagents = createCodexSubagentReader();

const CLAUDE_WINDOW_MS = 30 * 60_000;
const CLAUDE_READ_BYTES = 1024 * 1024;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

interface ClaudeSubagentSnapshot {
  agent: {
    agentId: string;
    parentSessionId: string;
    cwd: string | null;
    model: string | null;
    agentType: string | null;
    name: string;
    promptHead: string | null;
    startedAt: string | null;
    lastActivityAt: string;
  };
  lifecycle: "active" | "finished" | "failed" | "unknown";
  mtimeMs: number;
}

function claudeMessageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  return text || null;
}

/** Bounded head/tail reads; incomplete JSONL writes are never treated as a final answer. */
async function claudeRows(path: string) {
  const file = await openFile(dirname(path), basename(path));
  if (!file) return null;
  try {
    const info = await file.stat();
    const headBytes = await readBytes(file, 0, Math.min(info.size, CLAUDE_READ_BYTES));
    const parse = (bytes: Buffer, partialHead = false) => {
      const lines = bytes.toString("utf8").split("\n");
      if (partialHead) lines.shift();
      lines.pop(); // Consume only newline-terminated records, including the head boundary.
      const rows: Record<string, any>[] = [];
      for (const line of lines) {
        try { const row = JSON.parse(line); if (row && typeof row === "object") rows.push(row); }
        catch { /* Bad lines are local to the record. */ }
      }
      return rows;
    };
    const head = parse(headBytes);
    const tailOffset = Math.max(0, info.size - CLAUDE_READ_BYTES);
    const tail = tailOffset ? parse(await readBytes(file, tailOffset, info.size - tailOffset), true) : head;
    return { head, tail, mtimeMs: info.mtimeMs };
  } finally { await file.close(); }
}

export async function readClaudeSubagent(path: string): Promise<ClaudeSubagentSnapshot | null> {
  try {
    const rows = await claudeRows(path);
    const first = rows?.head[0];
    if (!rows || first?.isSidechain !== true || !NATIVE_ID.test(first.agentId ?? "") || !NATIVE_ID.test(first.sessionId ?? "")
      || basename(path) !== `agent-${first.agentId}.jsonl`) return null;
    let metadata: Record<string, unknown> | null = null;
    try { metadata = await readJson(dirname(path), basename(path).replace(/\.jsonl$/u, ".meta.json")); }
    catch { /* Optional metadata is not authoritative for lifecycle/model. */ }
    const user = rows.head.find((row) => row.type === "user");
    const prompt = claudeMessageText(user?.message?.content);
    const promptHead = prompt?.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 160) ?? null;
    let model: string | null = null;
    let lifecycle: ClaudeSubagentSnapshot["lifecycle"] = "unknown";
    let lastActivityAt = stringValue(first.timestamp) ?? new Date(rows.mtimeMs).toISOString();
    for (const row of [...rows.head, ...(rows.tail === rows.head ? [] : rows.tail)]) {
      if (Number.isFinite(Date.parse(row.timestamp))) lastActivityAt = row.timestamp;
      if (row.type === "assistant") {
        model = stringValue(row.message?.model) ?? model;
        if (row.isApiErrorMessage === true) lifecycle = "failed";
        else if (["end_turn", "stop_sequence"].includes(row.message?.stop_reason)) lifecycle = "finished";
        else lifecycle = "active";
      } else if (row.type === "user") lifecycle = "active";
    }
    return { lifecycle, mtimeMs: rows.mtimeMs, agent: {
      agentId: first.agentId, parentSessionId: first.sessionId, cwd: stringValue(first.cwd),
      model: model?.replace(/^claude-/u, "").replace(/-(\d{8})$/u, "").replace(/(\d)-(\d)(?=-|$)/u, "$1.$2") ?? null,
      agentType: stringValue(metadata?.agentType), name: stringValue(metadata?.description) ?? promptHead ?? first.agentId,
      promptHead, startedAt: stringValue(first.timestamp), lastActivityAt,
    } };
  } catch { return null; }
}

export interface ClaudeParentSession { cwd: string | null; nativeSessionId?: string }
export type ClaudeSessionProvider = () => readonly ClaudeParentSession[] | Promise<readonly ClaudeParentSession[]>;
export interface DispatchParentSession extends ClaudeParentSession {
  id?: string;
  agent?: AgentKind;
  model?: string | null;
  createdAt?: string;
}
export type DispatchSessionProvider = () => readonly DispatchParentSession[] | Promise<readonly DispatchParentSession[]>;

/** Only registered/delegate parent IDs; snapshots cache JSONL/meta path/mtime/size. */
export function createClaudeSubagentReader(read = readClaudeSubagent,
  listDirectory = (path: string) => readdir(path, { withFileTypes: true })) {
  const cache = new Map<string, { fingerprint: string; value: Promise<ClaudeSubagentSnapshot | null> }>();
  const parentCache = new Map<string, { fingerprint: string; value: Promise<{ cwd: string | null; model: string | null; entrypoint: string | null } | null> }>();
  const locations = new Map<string, { expires: number; directories: string[] }>();
  return async (runs: Dispatch[], projectsRoot: string, now = Date.now(), sessions: readonly ClaudeParentSession[] = []): Promise<Dispatch[]> => {
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(projectsRoot); } catch { return []; }
    const candidates = new Map<string, string | null>();
    for (const session of sessions) {
      if (session.nativeSessionId && NATIVE_ID.test(session.nativeSessionId)) {
        const cwd = stringValue(session.cwd);
        if (cwd || !candidates.has(session.nativeSessionId)) candidates.set(session.nativeSessionId, cwd);
      }
    }
    for (const run of runs) {
      const id = run.parent?.agent === "claude" ? run.parent.sessionId : null;
      if (id && NATIVE_ID.test(id) && !candidates.has(id)) candidates.set(id, null);
      if (run.tool === "claude" && run.session && NATIVE_ID.test(run.session)) {
        if (!candidates.has(run.session)) candidates.set(run.session, stringValue(run.cwd));
      }
    }
    // A delegate executor's cwd need not equal its Claude parent's cwd. For an ID-only
    // parent, inspect just <project>/<id>.jsonl; never list other projects' contents.
    let projectNames: Promise<Awaited<ReturnType<typeof listDirectory>>> | undefined;
    const locate = async (id: string): Promise<string[]> => {
      const key = `${canonicalRoot}/${id}`;
      const existing = locations.get(key);
      if (existing && existing.expires > now) return existing.directories;
      const directories: string[] = [];
      projectNames ??= listDirectory(canonicalRoot);
      for (const project of await projectNames) {
        if (!project.isDirectory()) continue;
        const directory = join(canonicalRoot, project.name);
        try { if ((await stat(join(directory, `${id}.jsonl`))).isFile()) directories.push(directory); }
        catch { /* Only this candidate filename is checked. */ }
      }
      locations.delete(key);
      if (locations.size >= 256) locations.delete(locations.keys().next().value!);
      locations.set(key, { expires: now + 30_000, directories });
      return directories;
    };
    const output = new Map<string, Dispatch>();
    for (const [parentSessionId, expectedCwd] of candidates) {
      let directories: string[];
      try { directories = expectedCwd ? [join(canonicalRoot, expectedCwd.replace(/[^A-Za-z0-9]/gu, "-"))] : await locate(parentSessionId); }
      catch { continue; }
      for (const directory of directories) {
        const sessionDirectory = join(directory, parentSessionId);
        const childDirectory = join(sessionDirectory, "subagents");
        const parentPath = join(directory, `${parentSessionId}.jsonl`);
        try {
          if (await realpath(directory) !== directory || await realpath(sessionDirectory) !== sessionDirectory
            || await realpath(childDirectory) !== childDirectory || await realpath(parentPath) !== parentPath) continue;
          // Child appends do not update parent directory mtime; inspect candidate children.
          const children = [];
          for (const child of await listDirectory(childDirectory)) {
            if (!child.isFile() || !/^agent-[A-Za-z0-9_-]+\.jsonl$/u.test(child.name)) continue;
            const path = join(childDirectory, child.name);
            try {
              const info = await stat(path);
              if (info.mtimeMs >= now - CLAUDE_WINDOW_MS) children.push({ path, info });
            } catch { /* A native writer may replace the file. */ }
          }
          if (!children.length) continue;
          const parentInfo = await stat(parentPath);
          const parentFingerprint = `${parentInfo.mtimeMs}:${parentInfo.size}`;
          let parentSnapshot = parentCache.get(parentPath);
          if (!parentSnapshot || parentSnapshot.fingerprint !== parentFingerprint) {
            const value = (async () => {
              const rows = await claudeRows(parentPath);
              const identity = rows?.head.find((row) => row.sessionId === parentSessionId && row.isSidechain !== true && stringValue(row.cwd));
              const cwd = stringValue(identity?.cwd);
              if (!identity || !cwd || cwd.replace(/[^A-Za-z0-9]/gu, "-") !== basename(directory)) return null;
              return { cwd, model: await readClaudeTranscriptModel(parentPath), entrypoint: stringValue(identity.entrypoint) };
            })();
            parentSnapshot = { fingerprint: parentFingerprint, value };
            parentCache.delete(parentPath);
            if (parentCache.size >= 256) parentCache.delete(parentCache.keys().next().value!);
            parentCache.set(parentPath, parentSnapshot);
          }
          const parent = await parentSnapshot.value;
          if (!parent || !parent.cwd || (expectedCwd && parent.cwd !== expectedCwd)) continue;
          const cwd = parent.cwd;
          for (const { path, info } of children) {
            try {
              let metaFingerprint = "missing";
              try { const meta = await stat(path.replace(/\.jsonl$/u, ".meta.json")); metaFingerprint = `${meta.mtimeMs}:${meta.size}`; } catch { /* Optional. */ }
              const fingerprint = `${info.mtimeMs}:${info.size}:${metaFingerprint}`;
              let snapshot = cache.get(path);
              if (!snapshot || snapshot.fingerprint !== fingerprint) {
                snapshot = { fingerprint, value: read(path) };
                cache.delete(path);
                if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
                cache.set(path, snapshot);
              }
              const value = await snapshot.value;
              if (!value || value.agent.parentSessionId !== parentSessionId || value.agent.cwd !== cwd) continue;
              const agent = value.agent;
              const last = Date.parse(agent.lastActivityAt);
              if (!Number.isFinite(last) || last > now || last < now - CLAUDE_WINDOW_MS) continue;
              const status = value.lifecycle === "finished" ? "OK" : value.lifecycle === "failed" ? "TOOL_FAIL"
                : value.lifecycle === "active" && now - value.mtimeMs <= 300_000 ? "running" : "unknown";
              const runId = `claude-agent-${parentSessionId}-${agent.agentId}`;
              const delegatedParent = runs.filter((run) => run.tool === "claude" && run.session === parentSessionId)
                .sort((a, b) => Number(b.status === "running") - Number(a.status === "running")
                  || (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.runId.localeCompare(a.runId))[0];
              const started = Date.parse(agent.startedAt ?? "");
              output.set(runId, {
                runId, tool: "claude", name: agent.name, cwd, model: agent.model, effort: null, agentType: agent.agentType, native: true,
                status, startedAt: agent.startedAt, endedAt: status === "OK" || status === "TOOL_FAIL" ? agent.lastActivityAt : null,
                elapsedS: Number.isFinite(started) ? Math.max(0, ((status === "running" ? now : last) - started) / 1000) : null,
                exit: null, files: null, session: agent.agentId, promptHead: agent.promptHead,
                parent: { agent: "claude", sessionId: parentSessionId, entrypoint: parent.entrypoint, model: parent.model,
                  ...(delegatedParent ? { runId: delegatedParent.runId } : {}) },
              });
            } catch { /* Isolate inaccessible or concurrent writes. */ }
          }
        } catch { /* No readable candidate native parent/subagents directory. */ }
      }
    }
    return [...output.values()];
  };
}

const readClaudeSubagents = createClaudeSubagentReader();

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
const parentTitleCache = new Map<string, { expiresAt: number; value: Promise<string | null> }>();

/** Resolve only the requested native ID, then reuse history's bounded head/title parser. */
async function readNativeParentTitle(agent: string, sessionId: string | null): Promise<string | null> {
  if (!sessionId || !NATIVE_ID.test(sessionId) || !["codex", "kimi"].includes(agent)) return null;
  const roots = {
    codex: process.env.WORKBENCH_CODEX_HISTORY_DIR || join(homedir(), ".codex", "sessions"),
    kimi: process.env.WORKBENCH_KIMI_HISTORY_DIR || join(homedir(), ".kimi-code", "sessions"),
  };
  const kind = agent as "codex" | "kimi";
  const key = `${roots[kind]}/${kind}/${sessionId}`;
  const cached = parentTitleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = (async () => {
    try {
      const transcript = new NativeConversationReader(roots).transcriptPath({ agent: kind, nativeSessionId: sessionId } as SessionRecord);
      if (!transcript) return null;
      const path = kind === "kimi" ? join(dirname(dirname(dirname(transcript))), "state.json") : transcript;
      const metadata = await new HistoryIndex({ roots }).sessionMetadata(kind, path);
      return metadata?.nativeSessionId === sessionId && metadata.title !== "无标题会话" ? metadata.title : null;
    } catch { return null; }
  })();
  parentTitleCache.delete(key);
  if (parentTitleCache.size >= 256) parentTitleCache.delete(parentTitleCache.keys().next().value!);
  parentTitleCache.set(key, { expiresAt: Date.now() + 30_000, value });
  return value;
}

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
          ...(["codex", "kimi"].includes(agent) && stringValue(input.sessionId)
            ? { title: await readNativeParentTitle(agent, stringValue(input.sessionId)) } : {}),
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

export async function listDispatches(limit: string | number | null = null, root = rootDirectory(),
  listSessions: DispatchSessionProvider = () => []): Promise<Dispatch[]> {
  const raw = limit === null ? 50 : Number(limit);
  const count = Number.isFinite(raw) && raw >= 1 ? Math.min(200, Math.floor(raw)) : 50;
  const nativeRuns = await allDispatches(root);
  const dispatches = nativeRuns.sort((a, b) => a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0).slice(0, count);
  await Promise.all(dispatches.map(async (run) => {
    const directory = await resolveRun(run.runId, root);
    try { if (directory) run.promptHead = await promptHead(directory); } catch { run.status = "unknown"; }
  }));
  const sessions = await listSessions();
  const native = await allNativeSubagents(root, sessions);
  // Preserve delegate's existing run-ID ordering; insert native Claude records by time.
  for (const agent of native.sort((a, b) => Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""))) {
    const index = dispatches.findIndex((run) => Date.parse(run.startedAt ?? "") < Date.parse(agent.startedAt ?? ""));
    dispatches.splice(index < 0 ? dispatches.length : index, 0, agent);
  }
  return dispatches.slice(0, count);
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
// Native records have no delegate history/detail files; parent links include them.
const claudeScans = new Map<string, { fingerprint: string; list: ReturnType<typeof createDispatchScanCache> }>();
async function allClaudeSubagents(root: string, sessions: readonly ClaudeParentSession[]): Promise<Dispatch[]> {
  const projectsRoot = process.env.WORKBENCH_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
  const unique = new Map<string, ClaudeParentSession>();
  for (const session of sessions) {
    if (!session.nativeSessionId || !NATIVE_ID.test(session.nativeSessionId)) continue;
    const value = { cwd: stringValue(session.cwd), nativeSessionId: session.nativeSessionId };
    unique.set(JSON.stringify(value), value);
  }
  const candidates = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  const fingerprint = JSON.stringify([projectsRoot, candidates]);
  let entry = claudeScans.get(root);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint, list: createDispatchScanCache(async (directory) => readClaudeSubagents(await allDispatches(directory),
      projectsRoot, Date.now(), candidates), () => Date.now()) };
    claudeScans.delete(root);
    if (claudeScans.size >= 256) claudeScans.delete(claudeScans.keys().next().value!);
    claudeScans.set(root, entry);
  }
  return entry.list(root);
}

function eventTime(value: unknown): string | null {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Only registered Kimi sessions: root workspace names, explicit state.json and agents from that state. */
export function createKimiSubagentReader() {
  const wireCache = new Map<string, { fingerprint: string; rows: Record<string, any>[] }>();
  return async (root: string, sessions: readonly DispatchParentSession[], now = Date.now()): Promise<Dispatch[]> => {
    const candidates = sessions.filter((session) => session.agent === "kimi"
      && session.nativeSessionId && NATIVE_ID.test(session.nativeSessionId));
    if (!candidates.length) return [];
    let canonicalRoot: string;
    let workspaces;
    try { canonicalRoot = await realpath(root); workspaces = await readdir(canonicalRoot, { withFileTypes: true }); }
    catch { return []; }
    const output = new Map<string, Dispatch>();
    for (const session of candidates) for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const directory = join(canonicalRoot, workspace.name, session.nativeSessionId!);
      try {
        if (await realpath(directory) !== directory || await realpath(join(directory, "agents")) !== join(directory, "agents")) continue;
        const state = await readJson(directory, "state.json");
        if (!state || state.id !== session.nativeSessionId || (session.cwd && state.cwd !== session.cwd)
          || !state.agents || typeof state.agents !== "object" || Array.isArray(state.agents)) continue;
        for (const [id, raw] of Object.entries(state.agents as Record<string, unknown>)) {
          if (id === "main" || !NATIVE_ID.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          try {
          const metadata = raw as Record<string, unknown>;
          const agentDirectory = join(directory, "agents", id);
          if (await realpath(agentDirectory) !== agentDirectory) continue;
          const path = join(agentDirectory, "wire.jsonl");
          const file = await openFile(agentDirectory, "wire.jsonl");
          if (!file) continue;
          let rows: Record<string, any>[];
          let mtimeMs: number;
          try {
            const info = await file.stat();
            mtimeMs = info.mtimeMs;
            const fingerprint = `${info.mtimeMs}:${info.size}`;
            const cached = wireCache.get(path);
            if (cached?.fingerprint === fingerprint) rows = cached.rows;
            else {
              const head = await readBytes(file, 0, Math.min(info.size, CHUNK_SIZE));
              const offset = Math.max(head.length, info.size - CHUNK_SIZE);
              const tail = offset < info.size ? await readBytes(file, offset, info.size - offset) : Buffer.alloc(0);
              const lines = head.toString("utf8").split("\n");
              lines.pop(); // Ignore incomplete/capped records.
              if (tail.length) {
                const last = tail.toString("utf8").split("\n");
                if (offset > head.length) last.shift();
                last.pop();
                lines.push(...last);
              }
              rows = lines.flatMap((line) => {
                try {
                  const row = JSON.parse(line);
                  if (!row || typeof row !== "object") return [];
                  // Retain lifecycle fields only, not prompts, reasoning or command output.
                  return [{ type: row.type, time: row.time, created_at: row.created_at, model: stringValue(row.model),
                    ...(row.event ? { event: { type: row.event.type, name: row.event.name, finishReason: row.event.finishReason } } : {}),
                    ...(row.info?.taskId ? { info: { taskId: row.info.taskId } } : {}) }];
                }
                catch { return []; }
              });
              if (wireCache.size >= 256) wireCache.delete(wireCache.keys().next().value!);
              wireCache.set(path, { fingerprint, rows });
            }
          } finally { await file.close(); }
          let status = "unknown";
          let startedAt = eventTime(metadata.createdAt);
          let lastActivityAt = new Date(mtimeMs).toISOString();
          let model = stringValue(metadata.model);
          let activity: string | null = null;
          const tasks = new Set<string>();
          for (const row of rows) {
            const time = eventTime(row.time) ?? eventTime(row.created_at);
            if (time) { startedAt ??= time; lastActivityAt = time; }
            model = stringValue(row.model) ?? model;
            const event = row.type === "context.append_loop_event" ? row.event : row;
            if (["agent.turn.started", "turn.prompt", "step.begin", "tool.call"].includes(event?.type)) status = "running";
            if (event?.type === "tool.call") activity = `调用 ${event.name ?? "工具"}`;
            if (event?.type === "step.end" && ["stop", "end_turn"].includes(event.finishReason)) status = "OK";
            if (["agent.turn.completed", "turn.completed"].includes(event?.type)) status = "OK";
            if (["agent.turn.failed", "turn.failed"].includes(event?.type)) status = "TOOL_FAIL";
            if (row.type === "task.started" && row.info?.taskId) tasks.add(row.info.taskId);
            if (row.type === "task.terminated") tasks.delete(row.info?.taskId);
          }
          if (tasks.size) status = "running";
          if (status === "running" && now - mtimeMs > 300_000) status = "unknown";
          const parentId = stringValue(metadata.parentAgentId) ?? "main";
          // Explicit state membership avoids accepting arbitrary homedir paths or orphan parents.
          if (parentId !== "main" && !Object.hasOwn(state.agents, parentId)) continue;
          const nativeId = `${session.nativeSessionId}--${id}`;
          const runId = `kimi-agent-${nativeId}`;
          const started = Date.parse(startedAt ?? "");
          output.set(runId, {
            runId, tool: "kimi", name: stringValue(metadata.name) ?? stringValue(metadata.description) ?? id,
            cwd: stringValue(state.cwd), model, effort: null, status, startedAt,
            endedAt: ["OK", "TOOL_FAIL"].includes(status) ? lastActivityAt : null,
            elapsedS: Number.isFinite(started) ? Math.max(0, ((status === "running" ? now : Date.parse(lastActivityAt)) - started) / 1000) : null,
            exit: null, files: null, session: nativeId, promptHead: activity, agentType: stringValue(metadata.type), native: true,
            parent: { agent: "kimi", sessionId: parentId === "main" ? session.nativeSessionId! : `${session.nativeSessionId}--${parentId}`,
              model: session.model ?? null, entrypoint: null },
          });
          } catch { /* One invalid child must not hide other agents in this session. */ }
        }
      } catch { /* Missing, symlinked or concurrently written candidate session is isolated. */ }
    }
    return [...output.values()];
  };
}

const readKimiSubagents = createKimiSubagentReader();
const nativeScans = new Map<string, { fingerprint: string; list: ReturnType<typeof createDispatchScanCache> }>();
async function allNativeSubagents(root: string, sessions: readonly DispatchParentSession[]): Promise<Dispatch[]> {
  const codexRoot = process.env.WORKBENCH_CODEX_HISTORY_DIR || join(homedir(), ".codex", "sessions");
  const kimiRoot = process.env.WORKBENCH_KIMI_HISTORY_DIR || join(homedir(), ".kimi-code", "sessions");
  const fingerprint = JSON.stringify([codexRoot, kimiRoot, sessions]);
  let entry = nativeScans.get(root);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint, list: createDispatchScanCache(async () => {
      const codexSessions = sessions.filter((session) => session.agent === "codex"
        && session.nativeSessionId && NATIVE_ID.test(session.nativeSessionId));
      const roots: Dispatch[] = codexSessions.map((session) => ({
        runId: `codex-session-${session.nativeSessionId}`, tool: "codex", name: "Codex", cwd: session.cwd,
        model: session.model ?? null, effort: null, status: "running", startedAt: session.createdAt ?? new Date().toISOString(),
        endedAt: null, elapsedS: null, exit: null, files: null, session: session.nativeSessionId!, parent: null, promptHead: null,
      }));
      await attachCodexSubagents(roots, codexRoot);
      const output = new Map<string, Dispatch>();
      for (const parent of roots) for (const child of parent.subagents ?? []) {
        const started = Date.parse(child.startedAt ?? "");
        output.set(child.threadId, {
          runId: `codex-agent-${child.threadId}`, tool: "codex", name: child.nickname, cwd: parent.cwd,
          model: child.model ?? null, effort: child.effort ?? null, agentType: child.role, native: true,
          status: child.status === "finished" ? "OK" : child.status, startedAt: child.startedAt,
          endedAt: child.status === "finished" ? child.lastActivityAt : null,
          elapsedS: Number.isFinite(started) ? Math.max(0, (Date.parse(child.lastActivityAt) - started) / 1000) : null,
          exit: null, files: null, session: child.threadId, promptHead: child.activity ?? null,
          parent: { agent: "codex", sessionId: child.parentThreadId, model: parent.model, entrypoint: null },
        });
      }
      const [kimi, claude] = await Promise.all([
        readKimiSubagents(kimiRoot, sessions),
        allClaudeSubagents(root, sessions.filter((session) => (session.agent ?? "claude") === "claude")),
      ]);
      return [...output.values(), ...kimi, ...claude];
    }) };
    nativeScans.delete(root);
    if (nativeScans.size >= 256) nativeScans.delete(nativeScans.keys().next().value!);
    nativeScans.set(root, entry);
  }
  return entry.list(root);
}

export async function listParentDispatches(parent: string, root = rootDirectory(), agent?: AgentKind,
  listSessions: DispatchSessionProvider = () => []): Promise<Dispatch[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parent)) throw new DispatchQueryError("parent 必须是原生会话 ID");
  const sessions = await listSessions();
  const aliases = new Set([parent]);
  for (const session of sessions) {
    if (agent && (session.agent ?? "claude") !== agent) continue;
    if (session.id === parent || session.nativeSessionId === parent) {
      if (session.id) aliases.add(session.id);
      if (session.nativeSessionId) aliases.add(session.nativeSessionId);
    }
  }
  const runs = [...await allDispatches(root), ...await allNativeSubagents(root, sessions)];
  return runs.filter((run) => {
    if (run.status !== "running") return false;
    const seen = new Set<string>();
    let current: Dispatch | undefined = run;
    while (current?.parent && !seen.has(current.runId)) {
      seen.add(current.runId);
      const source: NonNullable<Dispatch["parent"]> = current.parent;
      if (source.sessionId && aliases.has(source.sessionId) && (!agent || source.agent === agent)) return true;
      current = source.runId ? runs.find((item) => item.runId === source.runId)
        : runs.find((item) => item.tool === source.agent && item.session === source.sessionId);
    }
    return false;
  });
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
  if (!run.session || !["codex", "kimi", "claude"].includes(run.tool)) return fallback;
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
