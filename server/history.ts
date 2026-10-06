import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentKind } from "./types.js";
import { dispatchSessionMap, type DispatchSession } from "./dispatches.js";

export function kimiHistoryRoot(): string {
  return process.env.WORKBENCH_KIMI_HISTORY_DIR || join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "sessions");
}

export type HistorySource = "interactive" | "workbench" | "unknown";

export interface HistorySession {
  agent: AgentKind;
  nativeSessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: string;
  messageCount?: number;
  source: HistorySource;
  filePath: string;
  dispatch?: DispatchSession;
}

interface HistoryListInput {
  agent?: AgentKind;
  q?: string;
  cwd?: string;
  limit: number;
  cursor?: string;
}

interface HistoryListResult {
  sessions: HistorySession[];
  nextCursor?: string;
  truncated: boolean;
  skipped: number;
  empty: number;
  discovered: number;
  durationMs: number;
}

export type HistoryMessage =
  | { role: "user" | "assistant" | "thought"; text: string; timestamp: string | null }
  | { role: "tool"; timestamp: string | null; tool: {
      id: string; name: string; input: unknown; result?: string; rawResult?: unknown;
      status: "ok" | "error" | "unknown";
    } };

interface HistoryMessagesInput {
  limit: number;
  cursor?: string;
}

export interface HistoryMessagesPage {
  session: HistorySession;
  messages: HistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;
  durationMs: number;
}

interface HistoryRoots {
  claude: string;
  codex: string;
  kimi: string;
  workbenchRegistry: string;
}

interface HistoryIndexOptions {
  roots?: Partial<HistoryRoots>;
  timeoutMs?: number;
  maxDiscovered?: number;
  headBytes?: number;
  messagePageBytes?: number;
}

interface Candidate {
  agent: AgentKind;
  path: string;
  idHint: string;
  mtimeMs: number;
  size: number;
}

interface CachedSession {
  fingerprint: string;
  session: HistorySession | null;
  hasUserMessage?: boolean;
}

interface DiscoveryResult {
  candidates: Candidate[];
  skipped: number;
  truncated: boolean;
}

interface CursorPosition {
  version: 1;
  mtimeMs: number;
  agent: AgentKind;
  path: string;
}

type CursorData = CursorPosition | { version: 1; start: true };

interface HeadRead {
  lines: string[];
  truncated: boolean;
}

interface HistoryMessageCursor {
  version: 1;
  agent: AgentKind;
  nativeSessionId: string;
  offset: number;
  beforeIndex?: number;
}

interface OffsetLine {
  text: string;
  startOffset: number;
}

interface BackwardRead {
  lines: OffsetLine[];
  earlierOffset?: number;
  truncated: boolean;
}

type OffsetHistoryMessage = HistoryMessage & { startOffset: number };

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_DISCOVERED = 20_000;
const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_MESSAGE_PAGE_BYTES = 4 * 1024 * 1024;
const TITLE_LIMIT = 160;
const AGENTS: AgentKind[] = ["claude", "codex", "kimi"];

const INJECTED_TEXT_PREFIXES = [
  "<recommended_plugins>",
  "<environment_context>",
  "<skills_instructions>",
  "<permissions instructions>",
  "<apps_instructions>",
  "<plugins_instructions>",
  "<multi_agent_mode>",
  "<system-reminder>",
  "# AGENTS.md instructions",
  "## Memory\n\nYou have access to a memory folder",
];

const WRAPPER_TAGS = new Set([
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
  "task-notification",
  "ide_selection",
  "ide_opened_file",
]);

export class HistoryQueryError extends Error {}

export class HistoryIndex {
  private readonly roots: HistoryRoots;
  private readonly timeoutMs: number;
  private readonly maxDiscovered: number;
  private readonly headBytes: number;
  private readonly messagePageBytes: number;
  private readonly cache = new Map<string, CachedSession>();
  private registryFingerprint = "";
  private workbenchSessionIds = new Set<string>();

  constructor(options: HistoryIndexOptions = {}) {
    const workbenchHome = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");
    this.roots = {
      claude: process.env.WORKBENCH_CLAUDE_HISTORY_DIR || join(homedir(), ".claude", "projects"),
      codex: process.env.WORKBENCH_CODEX_HISTORY_DIR || join(homedir(), ".codex", "sessions"),
      kimi: kimiHistoryRoot(),
      workbenchRegistry: join(workbenchHome, "sessions.json"),
      ...options.roots,
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxDiscovered = options.maxDiscovered ?? DEFAULT_MAX_DISCOVERED;
    this.headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES;
    this.messagePageBytes = options.messagePageBytes ?? DEFAULT_MESSAGE_PAGE_BYTES;
  }

  async list(input: HistoryListInput): Promise<HistoryListResult> {
    const started = Date.now();
    const agents = input.agent ? [input.agent] : AGENTS;
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const discovery = await this.discover(agents, started + this.timeoutMs);
    const candidates = discovery.candidates
      .sort(compareCandidates)
      .filter((candidate) => !cursor || candidateAfterCursor(candidate, cursor));
    const workbenchIds = await this.loadWorkbenchSessionIds();
    const dispatches = await dispatchSessionMap();
    // 发现与消费各有预算；目录发现耗尽预算后，已发现的候选仍能处理。
    const deadline = Date.now() + this.timeoutMs;
    const q = (input.q ?? "").trim().toLocaleLowerCase();
    const cwd = (input.cwd ?? "").trim().replace(/\/+$/, "") || (input.cwd?.trim().startsWith("/") ? "/" : "");
    const sessions: HistorySession[] = [];
    let skipped = discovery.skipped;
    let empty = 0;
    let truncated = discovery.truncated;
    let consumed = 0;
    let lastConsumed: Candidate | undefined;

    for (const candidate of candidates) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const session = await this.parseCandidate(candidate);
      let hasUserMessage = false;
      if (session) {
        try {
          const found = await this.hasUserMessage(candidate, deadline);
          if (found === undefined) { truncated = true; break; }
          hasUserMessage = found;
        } catch {
          consumed += 1;
          lastConsumed = candidate;
          skipped += 1;
          continue;
        }
      }
      consumed += 1;
      lastConsumed = candidate;
      if (!session) {
        skipped += 1;
        continue;
      }
      if (!hasUserMessage) {
        empty += 1;
        continue;
      }
      const decorated = decorateSource(session, workbenchIds);
      const dispatch = dispatches.get(session.nativeSessionId);
      if (dispatch) decorated.dispatch = dispatch;
      if (q && !`${decorated.title}\n${decorated.cwd}`.toLocaleLowerCase().includes(q)) continue;
      if (cwd && decorated.cwd !== cwd && !decorated.cwd.startsWith(cwd === "/" ? "/" : `${cwd}/`)) continue;
      sessions.push(decorated);
      if (sessions.length >= input.limit) break;
    }

    const hasMore = consumed < candidates.length || truncated;
    return {
      sessions,
      // 零消费时保留上一页边界；首轮用起始哨兵，不能排除尚未消费的候选。
      ...(hasMore ? { nextCursor: lastConsumed ? encodeCursor(lastConsumed) : input.cursor ?? encodeCursor() } : {}),
      truncated,
      skipped,
      empty,
      discovered: discovery.candidates.length,
      durationMs: Date.now() - started,
    };
  }

  /** Reuse native title parsing for an already validated path, without archive discovery. */
  async sessionMetadata(agent: AgentKind, path: string): Promise<HistorySession | null> {
    try {
      if (await realpath(path) !== path) return null;
      const metadata = await stat(path);
      return await this.parseCandidate({ agent, path, idHint: idHintFor(agent, path),
        mtimeMs: metadata.mtimeMs, size: metadata.size });
    } catch { return null; }
  }

  /**
   * 「导入前的历史对话」截止点：偏移量 = 该原生会话消息文件当前大小的消息 cursor，
   * 编码与 messages() 的 nextCursor 完全一致；用它调 messages() 拿到的就是该时刻之前的最新一页。
   * 文件定位与 messages() 相同（Kimi 用 agents/main/wire.jsonl）。找不到会话或文件时返回 undefined。
   */
  async endCursor(agent: AgentKind, nativeSessionId: string): Promise<string | undefined> {
    const deadline = Date.now() + this.timeoutMs;
    const discovery = await this.discover([agent], deadline);
    const candidate = discovery.candidates.find((item) => item.idHint === nativeSessionId);
    if (!candidate) return undefined;
    const path = agent === "kimi"
      ? join(dirname(candidate.path), "agents", "main", "wire.jsonl")
      : candidate.path;
    try {
      const metadata = await stat(path);
      return encodeMessageCursor(agent, nativeSessionId, metadata.size);
    } catch {
      return undefined;
    }
  }

  async messages(
    agent: AgentKind,
    nativeSessionId: string,
    input: HistoryMessagesInput,
  ): Promise<HistoryMessagesPage | undefined> {
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const discovery = await this.discover([agent], deadline);
    const candidate = discovery.candidates.find((item) => item.idHint === nativeSessionId);
    if (!candidate) return undefined;
    const session = await this.parseCandidate(candidate);
    if (!session) return undefined;
    const workbenchIds = await this.loadWorkbenchSessionIds();
    const decorated = decorateSource(session, workbenchIds);
    const path = agent === "kimi"
      ? join(dirname(candidate.path), "agents", "main", "wire.jsonl")
      : candidate.path;

    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      return {
        session: decorated,
        messages: [],
        hasMore: false,
        truncated: true,
        durationMs: Date.now() - started,
      };
    }

    const cursor = input.cursor ? decodeMessageCursor(input.cursor) : undefined;
    if (cursor && (cursor.agent !== agent || cursor.nativeSessionId !== nativeSessionId)) {
      throw new HistoryQueryError("消息 cursor 与当前历史会话不匹配");
    }
    const endOffset = cursor?.offset ?? metadata.size;
    if (!Number.isSafeInteger(endOffset) || endOffset < 0 || endOffset > metadata.size) {
      throw new HistoryQueryError("消息 cursor 已失效，请从最新一页重新加载");
    }

    const window = await readBackward(path, endOffset, this.messagePageBytes);
    let normalized = mergeHistoryMessages(parseHistoryMessages(agent, window.lines));
    if (cursor?.beforeIndex !== undefined) {
      const lastOffset = window.lines.at(-1)?.startOffset;
      const first = normalized.findIndex((message) => message.startOffset === lastOffset);
      if (first >= 0) normalized = normalized.slice(0, first + cursor.beforeIndex);
    }
    const selected = normalized.slice(-input.limit);
    let nextOffset: number | undefined;
    let beforeIndex: number | undefined;
    if (normalized.length > selected.length) {
      const first = selected[0]!;
      const earlierInLine = normalized.slice(0, -selected.length).filter((message) => message.startOffset === first.startOffset).length;
      nextOffset = first.startOffset;
      if (earlierInLine) {
        const lineIndex = window.lines.findIndex((line) => line.startOffset === first.startOffset);
        nextOffset = window.lines[lineIndex + 1]?.startOffset ?? endOffset;
        beforeIndex = earlierInLine;
      }
    }
    else if (window.earlierOffset !== undefined) nextOffset = window.earlierOffset;
    const hasMore = nextOffset !== undefined && nextOffset > 0;
    return {
      session: decorated,
      messages: selected.map(({ startOffset: _startOffset, ...message }) => message),
      ...(hasMore ? { nextCursor: encodeMessageCursor(agent, nativeSessionId, nextOffset!, beforeIndex) } : {}),
      hasMore,
      truncated: window.truncated || normalized.length > selected.length,
      durationMs: Date.now() - started,
    };
  }

  private async discover(agents: AgentKind[], deadline: number): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { candidates: [], skipped: 0, truncated: false };
    for (const agent of agents) {
      const stack = [this.roots[agent]];
      while (stack.length > 0) {
        if (Date.now() >= deadline || result.candidates.length >= this.maxDiscovered) {
          result.truncated = true;
          return result;
        }
        const directory = stack.pop()!;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          result.skipped += 1;
          continue;
        }
        for (const entry of entries) {
          if (Date.now() >= deadline || result.candidates.length >= this.maxDiscovered) {
            result.truncated = true;
            return result;
          }
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            stack.push(path);
            continue;
          }
          if (!entry.isFile() || !isHistoryFile(agent, entry.name)) continue;
          try {
            const metadata = await stat(path);
            result.candidates.push({
              agent,
              path,
              idHint: idHintFor(agent, path),
              mtimeMs: metadata.mtimeMs,
              size: metadata.size,
            });
          } catch {
            result.skipped += 1;
          }
        }
      }
    }
    return result;
  }

  private async parseCandidate(candidate: Candidate): Promise<HistorySession | null> {
    let fingerprint = `${candidate.mtimeMs}:${candidate.size}`;
    if (candidate.agent === "kimi") {
      const wirePath = join(dirname(candidate.path), "agents", "main", "wire.jsonl");
      try {
        const wire = await stat(wirePath);
        fingerprint += `:${wire.mtimeMs}:${wire.size}`;
      } catch {
        fingerprint += ":missing";
      }
    }
    const cached = this.cache.get(candidate.path);
    if (cached?.fingerprint === fingerprint) return cached.session;
    let session: HistorySession | null = null;
    try {
      if (candidate.agent === "claude") session = await this.parseClaude(candidate);
      else if (candidate.agent === "codex") session = await this.parseCodex(candidate);
      else session = await this.parseKimi(candidate);
    } catch {
      session = null;
    }
    this.cache.set(candidate.path, { fingerprint, session });
    return session;
  }

  /** Scan beyond the title window, including image-only user messages. Cache with the file fingerprint. */
  private async hasUserMessage(candidate: Candidate, deadline: number): Promise<boolean | undefined> {
    const cached = this.cache.get(candidate.path)!;
    if (cached.hasUserMessage !== undefined) return cached.hasUserMessage;
    const path = candidate.agent === "kimi"
      ? join(dirname(candidate.path), "agents", "main", "wire.jsonl") : candidate.path;
    let hasUserMessage = false;
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (Date.now() >= deadline) return undefined;
        const record = parseLine(line);
        if (!record) continue;
        hasUserMessage = candidate.agent === "claude"
          ? record.type === "user" && record.message?.role === "user" && !record.isMeta && !record.isSidechain
          : candidate.agent === "codex"
            ? (record.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user")
              || (record.type === "event_msg" && record.payload?.type === "user_message")
            : record.type === "turn.prompt";
        if (hasUserMessage) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
    cached.hasUserMessage = hasUserMessage;
    return hasUserMessage;
  }

  private async parseClaude(candidate: Candidate): Promise<HistorySession | null> {
    const { lines } = await readHead(candidate.path, this.headBytes);
    let cwd = "";
    let entrypoint = "";
    let title = "";
    let validRecords = 0;
    for (const line of lines) {
      const record = parseLine(line);
      if (!record) continue;
      validRecords += 1;
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
      if (!entrypoint && typeof record.entrypoint === "string") entrypoint = record.entrypoint;
      if (!title && record.type === "user" && record.message?.role === "user" && !record.isMeta && !record.isSidechain) {
        title = firstHumanText(record.message.content) ?? "";
      }
      if (cwd && entrypoint && title) break;
    }
    if (validRecords === 0 || !cwd) return null;
    return sessionFromCandidate(candidate, {
      nativeSessionId: candidate.idHint,
      cwd,
      title,
      source: claudeSource(entrypoint),
    });
  }

  private async parseCodex(candidate: Candidate): Promise<HistorySession | null> {
    const { lines } = await readHead(candidate.path, this.headBytes);
    let metadata: Record<string, any> | undefined;
    let title = "";
    for (const line of lines) {
      const record = parseLine(line);
      if (!record) continue;
      if (!metadata && record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        metadata = record.payload;
      }
      if (!title && record.type === "response_item" && record.payload?.type === "message" && record.payload?.role === "user") {
        title = firstHumanText(record.payload.content) ?? "";
      }
      if (metadata && title) break;
    }
    if (!metadata || typeof metadata.id !== "string" || typeof metadata.cwd !== "string") return null;
    return sessionFromCandidate(candidate, {
      nativeSessionId: metadata.id,
      cwd: metadata.cwd,
      title,
      source: codexSource(metadata.originator, metadata.source),
    });
  }

  private async parseKimi(candidate: Candidate): Promise<HistorySession | null> {
    const stateHead = await readHead(candidate.path, this.headBytes);
    const stateText = stateHead.lines.join("\n").trim();
    if (!stateText) return null;
    const state = JSON.parse(stateText) as Record<string, any>;
    const nativeSessionId = typeof state.id === "string" ? state.id : candidate.idHint;
    const cwd = typeof state.cwd === "string" ? state.cwd : state.workDir;
    if (!nativeSessionId || typeof cwd !== "string") return null;
    let title = typeof state.title === "string" && state.title !== "New Session" ? state.title : "";
    if (!title) {
      try {
        const wirePath = join(dirname(candidate.path), "agents", "main", "wire.jsonl");
        const wire = await readHead(wirePath, this.headBytes);
        for (const line of wire.lines) {
          const record = parseLine(line);
          if (record?.type !== "turn.prompt") continue;
          title = firstHumanText(record.input) ?? "";
          if (title) break;
        }
      } catch { /* state.json 仍足以列出会话；预览会明确标记截断。 */ }
    }
    const custom = state.custom && typeof state.custom === "object" ? state.custom : {};
    const nativeSource: HistorySource = custom.source === "workbench" || custom.clientInfo?.name === "workbench"
      ? "workbench"
      : "unknown";
    return sessionFromCandidate(candidate, {
      nativeSessionId,
      cwd,
      title,
      source: nativeSource,
    });
  }

  private async loadWorkbenchSessionIds(): Promise<Set<string>> {
    let metadata;
    try {
      metadata = await stat(this.roots.workbenchRegistry);
    } catch {
      this.registryFingerprint = "missing";
      this.workbenchSessionIds = new Set();
      return this.workbenchSessionIds;
    }
    const fingerprint = `${metadata.mtimeMs}:${metadata.size}`;
    if (fingerprint === this.registryFingerprint) return this.workbenchSessionIds;
    const ids = new Set<string>();
    try {
      const records = JSON.parse(await readFile(this.roots.workbenchRegistry, "utf8")) as unknown;
      if (Array.isArray(records)) {
        for (const record of records) {
          if (!record || typeof record !== "object") continue;
          const item = record as Record<string, unknown>;
          // 导入的会话仍属于原来的客户端；注册表只证明工作台新建的会话来源。
          if (AGENTS.includes(item.agent as AgentKind) && typeof item.nativeSessionId === "string" && !item.resumedFrom) {
            ids.add(`${item.agent}:${item.nativeSessionId}`);
          }
        }
      }
    } catch { /* 来源回退失败不影响三家原生历史读取。 */ }
    this.registryFingerprint = fingerprint;
    this.workbenchSessionIds = ids;
    return ids;
  }
}

function isHistoryFile(agent: AgentKind, name: string): boolean {
  if (agent === "claude") return name.endsWith(".jsonl");
  if (agent === "codex") return name.startsWith("rollout-") && name.endsWith(".jsonl");
  return name === "state.json";
}

function idHintFor(agent: AgentKind, path: string): string {
  if (agent === "kimi") return basename(dirname(path));
  const name = basename(path, ".jsonl");
  if (agent === "claude") return name;
  return name.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1] ?? name;
}

function sessionFromCandidate(
  candidate: Candidate,
  value: Pick<HistorySession, "nativeSessionId" | "cwd" | "title" | "source">,
): HistorySession {
  return {
    agent: candidate.agent,
    nativeSessionId: value.nativeSessionId,
    cwd: value.cwd,
    title: truncateText(value.title || "无标题会话", TITLE_LIMIT),
    lastActivityAt: new Date(candidate.mtimeMs).toISOString(),
    source: value.source,
    filePath: candidate.path,
  };
}

function decorateSource(session: HistorySession, workbenchIds: Set<string>): HistorySession {
  if ((session.source !== "unknown" && !(session.agent === "claude" && session.source === "interactive"))
    || !workbenchIds.has(`${session.agent}:${session.nativeSessionId}`)) {
    return { ...session };
  }
  return { ...session, source: "workbench" };
}

function claudeSource(entrypoint: string): HistorySource {
  if (entrypoint === "sdk-cli") return "workbench";
  if (entrypoint && !entrypoint.startsWith("sdk-")) return "interactive";
  return "unknown";
}

function codexSource(originator: unknown, source: unknown): HistorySource {
  if (typeof originator === "string" && originator.startsWith("workbench")) return "workbench";
  if (typeof originator === "string" && originator.length > 0) return "interactive";
  if (typeof source === "string" && ["cli", "vscode", "exec"].includes(source)) return "interactive";
  return "unknown";
}

function firstHumanText(content: unknown): string | undefined {
  const blocks = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const item = block as Record<string, unknown>;
        if (!["text", "input_text"].includes(String(item.type ?? "")) || typeof item.text !== "string") return [];
        return [item.text];
      })
      : [];
  for (const block of blocks) {
    const text = unwrapHumanText(block);
    if (text) return text;
  }
  return undefined;
}

function unwrapHumanText(value: string): string | undefined {
  let text = value.replace(/^\uFEFF/, "").trim();
  if (!text) return undefined;
  const commandArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim();
  if (commandArgs) return normalizeText(commandArgs);
  const commandName = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]?.trim();
  if (/^<(command-message|command-name)\b/i.test(text)) {
    return commandName ? normalizeText(commandName) : undefined;
  }
  while (true) {
    const tag = text.match(/^<([a-zA-Z0-9_-]+)\b[^>]*>/)?.[1];
    if (!tag || !WRAPPER_TAGS.has(tag)) break;
    const closing = `</${tag}>`;
    const end = text.indexOf(closing);
    if (end < 0) return undefined;
    text = text.slice(end + closing.length).trim();
    if (!text) return undefined;
  }
  if (INJECTED_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
  return normalizeText(text);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, limit: number): string {
  const normalized = normalizeText(text);
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join("")}…`;
}

function parseLine(line: string): Record<string, any> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, any>
      : undefined;
  } catch {
    return undefined;
  }
}

async function readHead(path: string, maxBytes: number): Promise<HeadRead> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const metadata = await handle.stat();
    const truncated = metadata.size > bytesRead;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (truncated && !text.endsWith("\n")) lines.pop();
    return { lines, truncated };
  } finally {
    await handle.close();
  }
}

async function readBackward(path: string, endOffset: number, maxBytes: number): Promise<BackwardRead> {
  const startOffset = Math.max(0, endOffset - maxBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(endOffset - startOffset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, startOffset);
    const content = buffer.subarray(0, bytesRead);
    let contentStart = 0;
    let earlierOffset: number | undefined;
    if (startOffset > 0) {
      const firstNewline = content.indexOf(0x0a);
      if (firstNewline < 0) {
        return { lines: [], earlierOffset: startOffset, truncated: true };
      }
      contentStart = firstNewline + 1;
      earlierOffset = startOffset + contentStart;
    }

    const lines: OffsetLine[] = [];
    let lineStart = contentStart;
    while (lineStart < content.length) {
      const newline = content.indexOf(0x0a, lineStart);
      const lineEnd = newline < 0 ? content.length : newline;
      if (lineEnd > lineStart) {
        lines.push({
          text: content.subarray(lineStart, lineEnd).toString("utf8"),
          startOffset: startOffset + lineStart,
        });
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    return {
      lines,
      ...(earlierOffset !== undefined ? { earlierOffset } : {}),
      truncated: earlierOffset !== undefined,
    };
  } finally {
    await handle.close();
  }
}

export function parseHistoryMessages(agent: AgentKind, lines: OffsetLine[]): OffsetHistoryMessage[] {
  const messages: OffsetHistoryMessage[] = [];
  const calls = new Map<string, Extract<HistoryMessage, { role: "tool" }>>();
  function addTool(id: unknown, name: unknown, input: unknown, time: unknown, startOffset: number) {
    if (typeof id !== "string" || typeof name !== "string") return;
    const message: OffsetHistoryMessage & { role: "tool" } = {
      role: "tool", timestamp: historyTimestamp(time), startOffset,
      // exec 的 JS 必须完整才能在前端提取命令/patch；读取窗口仍由 4 MiB 页上限约束。
      tool: { id: id.slice(0, 256), name: name.slice(0, 256),
        input: agent === "codex" && name === "exec" && typeof input === "string" ? input : boundedToolValue(input ?? null),
        status: "unknown" },
    };
    calls.set(id, message);
    messages.push(message);
  }
  function finishTool(id: string, result: unknown, error?: boolean, rawResult?: unknown) {
    const message = calls.get(id);
    if (!message) return;
    message.tool.result = boundedToolText(typeof result === "string" ? result : fullText(result, ["text"]) ?? JSON.stringify(result ?? null));
    if (rawResult !== undefined) message.tool.rawResult = boundedToolValue(rawResult);
    message.tool.status = error === undefined ? "unknown" : error ? "error" : "ok";
  }
  const codexHasEventMessages = agent === "codex" && lines.some((line) => {
    const record = parseLine(line.text);
    return record?.type === "event_msg" && ["user_message", "agent_message"].includes(record.payload?.type);
  });
  for (const line of lines) {
    const record = parseLine(line.text);
    if (!record) continue;
    if (agent === "claude") {
      if (record.isMeta || record.isSidechain) continue;
      const content = record.message?.content;
      if (record.type === "assistant" && record.message?.role === "assistant") {
        for (const block of Array.isArray(content) ? content : [{ type: "text", text: content }]) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") pushHistoryMessage(messages, "assistant", stringValue(block.text), record.timestamp, line.startOffset);
          // Opus 等多数思考块只存签名、thinking 为空，空的不推（实时流也不显示）
          if (block.type === "thinking") pushHistoryMessage(messages, "thought", stringValue(block.thinking), record.timestamp, line.startOffset);
          if (block.type === "tool_use") addTool(block.id, block.name, block.input, record.timestamp, line.startOffset);
        }
      } else if (record.type === "user" && record.message?.role === "user") {
        for (const block of Array.isArray(content) ? content : []) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") finishTool(block.tool_use_id, block.content, block.is_error === true, record.toolUseResult);
        }
        pushHistoryMessage(messages, "user", fullHumanText(content), record.timestamp, line.startOffset);
      }
    } else if (agent === "codex") {
      const payload = record.payload;
      if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload?.type)) {
        let input = payload.arguments ?? payload.input;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* raw custom input */ } }
        const name = String(payload.name ?? "tool").replace(/^functions\./, "");
        if (["exec_command", "shell_command", "shell"].includes(name)) {
          const args = input && typeof input === "object" ? input : {};
          addTool(payload.call_id, "commandExecution", { ...args, command: args.cmd ?? args.command ?? input }, record.timestamp, line.startOffset);
        } else if (name === "apply_patch") {
          const changes = nativePatchChanges(input);
          addTool(payload.call_id, changes ? "fileChange" : name, changes ? { changes } : input, record.timestamp, line.startOffset);
        } else addTool(payload.call_id, name, input, record.timestamp, line.startOffset);
        continue;
      }
      if (record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload?.type)) {
        let decoded = payload.output;
        if (typeof decoded === "string") { try { decoded = JSON.parse(decoded); } catch { /* native terminal text */ } }
        const output = decoded && typeof decoded === "object" && typeof decoded.output === "string" ? decoded.output : payload.output;
        const code = decoded?.metadata?.exit_code ?? (typeof output === "string" ? /(?:Process exited with code|Exit code:)\s*(-?\d+)/.exec(output)?.[1] : undefined);
        const call = calls.get(payload.call_id);
        finishTool(payload.call_id, output, code !== undefined ? Number(code) !== 0 : undefined,
          call?.tool.name === "commandExecution" ? { aggregatedOutput: output, ...(code !== undefined ? { exitCode: Number(code) } : {}) } : undefined);
        continue;
      }
      // 推理摘要只在 response_item 里（新旧格式都有）；多数只有加密正文、summary 为空
      if (record.type === "response_item" && payload?.type === "reasoning") {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.flatMap((part: unknown) => {
            const text = (part as { text?: unknown } | null)?.text;
            return typeof text === "string" && text ? [text] : [];
          })
          : [];
        pushHistoryMessage(messages, "thought", summary.join("\n\n") || undefined, record.timestamp, line.startOffset);
        continue;
      }
      if (codexHasEventMessages) {
        if (record.type === "event_msg" && record.payload?.type === "user_message") {
          pushHistoryMessage(messages, "user", stringValue(record.payload.message), record.timestamp, line.startOffset);
        } else if (record.type === "event_msg" && record.payload?.type === "agent_message") {
          pushHistoryMessage(messages, "assistant", stringValue(record.payload.message), record.timestamp, line.startOffset);
        }
        continue;
      }
      if (record.type !== "response_item" || record.payload?.type !== "message") continue;
      if (record.payload.role === "user") {
        pushHistoryMessage(messages, "user", fullHumanText(record.payload.content), record.timestamp, line.startOffset);
      } else if (record.payload.role === "assistant") {
        pushHistoryMessage(messages, "assistant", fullText(record.payload.content, ["output_text", "text"]), record.timestamp, line.startOffset);
      }
    } else if (record.type === "context.append_loop_event" && (!record.agentId || record.agentId === "main") && record.event?.type === "tool.call") {
      addTool(record.event.toolCallId, record.event.name, record.event.args, record.time, line.startOffset);
    } else if (record.type === "context.append_loop_event" && (!record.agentId || record.agentId === "main") && record.event?.type === "tool.result") {
      const result = record.event.result;
      finishTool(record.event.toolCallId, result?.output ?? result, result?.isError ?? result?.is_error ?? Boolean(result?.error), result);
    } else if (record.type === "turn.prompt") {
      pushHistoryMessage(messages, "user", fullHumanText(record.input), record.time, line.startOffset);
    } else if (record.type === "context.append_loop_event" && record.event?.type === "content.part") {
      const part = record.event.part;
      if (part?.type === "text" && typeof part.text === "string") {
        pushHistoryMessage(messages, "assistant", part.text, record.time, line.startOffset);
      } else if (part?.type === "think") {
        pushHistoryMessage(messages, "thought", stringValue(part.think), record.time, line.startOffset);
      }
    }
  }
  return messages;
}

const TOOL_BODY_LIMIT = 4000;
function boundedToolText(text: string): string {
  if (JSON.stringify(text).length <= TOOL_BODY_LIMIT) return text;
  const suffix = "…[truncated]";
  let low = 0, high = Math.min(text.length, TOOL_BODY_LIMIT);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, mid) + suffix).length <= TOOL_BODY_LIMIT) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + suffix;
}
function boundedToolValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= TOOL_BODY_LIMIT ? value : boundedToolText(serialized);
}

function nativePatchChanges(input: unknown): Array<{ path: string; kind: { type: string; move_path?: string }; diff: string }> | undefined {
  if (typeof input !== "string" || !input.startsWith("*** Begin Patch")) return undefined;
  const changes: Array<{ path: string; kind: { type: string; move_path?: string }; diff: string }> = [];
  for (const line of input.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) changes.push({ path: header[2]!, kind: { type: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update" }, diff: "" });
    else {
      const last = changes.at(-1);
      if (!last) continue;
      if (line.startsWith("*** Move to: ")) last.kind.move_path = line.slice(13);
      else if (!line.startsWith("***")) last.diff += line + "\n";
    }
  }
  return changes.length ? changes : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function mergeHistoryMessages(messages: OffsetHistoryMessage[]): OffsetHistoryMessage[] {
  const merged: OffsetHistoryMessage[] = [];
  const toolLines = new Set(messages.filter((message) => message.role === "tool").map((message) => message.startOffset));
  for (const message of messages) {
    const previous = merged.at(-1);
    if ((message.role === "assistant" || message.role === "thought") && previous?.role === message.role
      && (previous.startOffset === message.startOffset
        || (!toolLines.has(previous.startOffset) && !toolLines.has(message.startOffset)))) {
      previous.text += message.text;
      continue;
    }
    merged.push({ ...message });
  }
  return merged;
}

function fullHumanText(content: unknown): string | undefined {
  const blocks = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const item = block as Record<string, unknown>;
        if (!["text", "input_text"].includes(String(item.type ?? "")) || typeof item.text !== "string") return [];
        return [item.text];
      })
      : [];
  const readable = blocks.flatMap((block) => {
    const text = unwrapHumanDisplayText(block);
    return text ? [text] : [];
  });
  return readable.length > 0 ? readable.join("\n\n") : undefined;
}

function unwrapHumanDisplayText(value: string): string | undefined {
  let text = value.replace(/^\uFEFF/, "").trim();
  if (!text) return undefined;
  const commandArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim();
  if (commandArgs) return commandArgs;
  const commandName = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1]?.trim();
  if (/^<(command-message|command-name)\b/i.test(text)) return commandName || undefined;
  while (true) {
    const tag = text.match(/^<([a-zA-Z0-9_-]+)\b[^>]*>/)?.[1];
    if (!tag || !WRAPPER_TAGS.has(tag)) break;
    const closing = `</${tag}>`;
    const end = text.indexOf(closing);
    if (end < 0) return undefined;
    text = text.slice(end + closing.length).trim();
    if (!text) return undefined;
  }
  if (INJECTED_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
  return text;
}

function fullText(content: unknown, types: string[]): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    if (!types.includes(String(item.type ?? "")) || typeof item.text !== "string" || !item.text) return [];
    return [item.text];
  });
  return texts.length > 0 ? texts.join("") : undefined;
}

function pushHistoryMessage(
  messages: OffsetHistoryMessage[],
  role: "user" | "assistant" | "thought",
  text: string | undefined,
  timestamp: unknown,
  startOffset: number,
): void {
  if (!text) return;
  messages.push({
    role,
    text,
    timestamp: historyTimestamp(timestamp),
    startOffset,
  });
}

function historyTimestamp(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return numberTimestamp(value) ?? null;
}

function numberTimestamp(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return right.mtimeMs - left.mtimeMs
    || `${left.agent}\0${left.path}`.localeCompare(`${right.agent}\0${right.path}`);
}

function candidateAfterCursor(candidate: Candidate, cursor: CursorData): boolean {
  if ("start" in cursor) return true;
  if (candidate.mtimeMs !== cursor.mtimeMs) return candidate.mtimeMs < cursor.mtimeMs;
  return `${candidate.agent}\0${candidate.path}`.localeCompare(`${cursor.agent}\0${cursor.path}`) > 0;
}

function encodeCursor(candidate?: Candidate): string {
  const value: CursorData = candidate ? {
    version: 1,
    mtimeMs: candidate.mtimeMs,
    agent: candidate.agent,
    path: candidate.path,
  } : { version: 1, start: true };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string): CursorData {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPosition> & { start?: unknown };
    if (parsed.version === 1 && parsed.start === true) return { version: 1, start: true };
    if (parsed.version !== 1 || typeof parsed.mtimeMs !== "number" || !AGENTS.includes(parsed.agent as AgentKind) || typeof parsed.path !== "string") {
      throw new Error("invalid cursor fields");
    }
    return parsed as CursorData;
  } catch {
    throw new HistoryQueryError("cursor 无效或版本不受支持");
  }
}

function encodeMessageCursor(agent: AgentKind, nativeSessionId: string, offset: number, beforeIndex?: number): string {
  const value: HistoryMessageCursor = { version: 1, agent, nativeSessionId, offset, beforeIndex };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeMessageCursor(value: string): HistoryMessageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryMessageCursor>;
    if (
      parsed.version !== 1
      || !AGENTS.includes(parsed.agent as AgentKind)
      || typeof parsed.nativeSessionId !== "string"
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset! < 0
      || (parsed.beforeIndex !== undefined && (!Number.isSafeInteger(parsed.beforeIndex) || parsed.beforeIndex < 0))
    ) {
      throw new Error("invalid message cursor fields");
    }
    return parsed as HistoryMessageCursor;
  } catch {
    throw new HistoryQueryError("消息 cursor 无效或版本不受支持");
  }
}
