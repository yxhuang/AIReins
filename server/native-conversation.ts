import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mergeHistoryMessages, parseHistoryMessages, type HistoryMessage } from "./history.js";
import type { AgentKind, SessionRecord } from "./types.js";

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 20_000;

export interface NativeConversationMark {
  path: string;
  identity: string;
  offset: number;
  size: number;
}

export interface NativeConversationChange {
  mark: NativeConversationMark;
  messages: HistoryMessage[];
  truncated: boolean;
}

interface NativeLine { text: string; startOffset: number }

/** Only reads native CLI files. All searches and tail reads have fixed limits. */
export class NativeConversationReader {
  private readonly roots: Record<AgentKind, string>;
  private readonly located = new Map<string, string>();

  constructor(roots: Partial<Record<AgentKind, string>> = {}) {
    this.roots = {
      claude: process.env.WORKBENCH_CLAUDE_HISTORY_DIR || join(homedir(), ".claude", "projects"),
      codex: process.env.WORKBENCH_CODEX_HISTORY_DIR || join(homedir(), ".codex", "sessions"),
      kimi: process.env.WORKBENCH_KIMI_HISTORY_DIR || join(homedir(), ".kimi-code", "sessions"),
      ...roots,
    };
  }

  async capture(session: SessionRecord): Promise<NativeConversationMark | undefined> {
    const snapshot = await this.read(session);
    return snapshot?.mark;
  }

  async changed(session: SessionRecord, previous: NativeConversationMark): Promise<NativeConversationChange | undefined> {
    const snapshot = await this.read(session);
    if (!snapshot) throw new Error("原生会话记录不可读");
    if (snapshot.mark.identity === previous.identity && snapshot.mark.path === previous.path) return undefined;
    const rewritten = snapshot.mark.path === previous.path && snapshot.mark.offset === previous.offset;
    const added = mergeHistoryMessages(parseHistoryMessages(session.agent, snapshot.lines)
      .filter((message) => snapshot.mark.path !== previous.path || message.startOffset > previous.offset
        || (rewritten && message.startOffset === previous.offset)));
    // A completed local turn can reach disk after turn_completed. Assistant-only
    // additions are that delayed flush; an external turn begins at its user line.
    const firstUser = added.findIndex((message) => message.role === "user");
    const messages = (firstUser < 0 ? [] : added.slice(firstUser))
      .map(({ startOffset: _offset, ...message }) => message);
    const bounded = boundExternalMessages(session.nativeSessionId ?? "", messages);
    return {
      mark: snapshot.mark,
      messages: bounded.messages,
      truncated: bounded.truncated || snapshot.mark.path !== previous.path || snapshot.mark.size < previous.size
        || !snapshot.lines.some((line) => line.startOffset === previous.offset),
    };
  }

  private async read(session: SessionRecord): Promise<{
    mark: NativeConversationMark;
    lines: NativeLine[];
    truncated: boolean;
  } | undefined> {
    if (!session.nativeSessionId) return undefined;
    const path = await this.pathFor(session);
    if (!path) return undefined;
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - MAX_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const content = buffer.subarray(0, bytesRead);
      let begin = start === 0 ? 0 : content.indexOf(0x0a) + 1;
      if (begin === 0 && start > 0) return undefined; // oversized line
      const lines: NativeLine[] = [];
      while (begin < content.length) {
        const end = content.indexOf(0x0a, begin);
        if (end < 0) {
          const finalText = content.subarray(begin).toString("utf8");
          try {
            JSON.parse(finalText); // a complete final record need not end with a newline
            lines.push({ text: finalText, startOffset: start + begin });
          } catch { /* partially flushed final line: retry on the next send */ }
          break;
        }
        if (end > begin) lines.push({ text: content.subarray(begin, end).toString("utf8"), startOffset: start + begin });
        begin = end + 1;
      }
      const messages = parseHistoryMessages(session.agent, lines);
      const last = messages.at(-1);
      if (!last) return undefined;
      const source = lines.find((line) => line.startOffset === last.startOffset);
      if (!source) return undefined;
      let identity: string;
      if (session.agent === "claude") {
        const uuid = (JSON.parse(source.text) as { uuid?: unknown }).uuid;
        if (typeof uuid !== "string" || !uuid) return undefined;
        identity = `uuid:${uuid}`;
      } else {
        identity = `${last.startOffset}:${createHash("sha256").update(source.text).digest("hex")}`;
      }
      return {
        mark: { path, identity, offset: last.startOffset, size },
        lines,
        truncated: start > 0,
      };
    } finally {
      await file.close();
    }
  }

  private async pathFor(session: SessionRecord): Promise<string | undefined> {
    const root = this.roots[session.agent];
    const id = session.nativeSessionId;
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
    const key = `${session.agent}:${id}`;
    const cached = this.located.get(key);
    if (cached) {
      const safeCached = await safeNativeFile(root, cached);
      if (safeCached) return safeCached;
      this.located.delete(key);
    }
    const remember = (path: string): string => {
      this.located.set(key, path);
      return path;
    };
    const hint = session.nativeTranscriptPath;
    if (hint && isAbsolute(hint)) {
      const safeHint = await safeNativeFile(root, hint);
      if (safeHint) return remember(safeHint);
    }
    if (session.agent === "claude") {
      for (const project of await safeDirs(root)) {
        const path = join(root, project, `${id}.jsonl`);
        const safePath = await safeNativeFile(root, path);
        if (safePath) return remember(safePath);
      }
      return undefined;
    }
    if (session.agent === "kimi") {
      for (const workspace of await safeDirs(root)) {
        const path = join(root, workspace, id, "agents", "main", "wire.jsonl");
        const safePath = await safeNativeFile(root, path);
        if (safePath) return remember(safePath);
      }
      return undefined;
    }
    // Older Codex app-server versions may omit thread.path. Search only dated session dirs.
    let inspected = 0;
    for (const year of await safeDirs(root)) {
      for (const month of await safeDirs(join(root, year))) {
        for (const day of await safeDirs(join(root, year, month))) {
          const directory = join(root, year, month, day);
          const entries = await safeFiles(directory);
          inspected += entries.length;
          if (inspected > MAX_DISCOVERY_ENTRIES) return undefined;
          const name = entries.find((entry) => entry.startsWith("rollout-") && entry.endsWith(`-${id}.jsonl`));
          if (name) {
            const safePath = await safeNativeFile(root, join(directory, name));
            if (safePath) return remember(safePath);
          }
        }
      }
    }
    return undefined;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function safeNativeFile(root: string, path: string): Promise<string | undefined> {
  if (!within(root, path)) return undefined;
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    return within(realRoot, realPath) && (await stat(realPath)).isFile() ? realPath : undefined;
  } catch { return undefined; }
}

async function safeDirs(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); }
  catch { return []; }
}

async function safeFiles(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name); }
  catch { return []; }
}

/** Bound the self-contained event, counting UTF-8 bytes including JSON escaping. */
export function boundExternalMessages(nativeSessionId: string, messages: HistoryMessage[]): { messages: HistoryMessage[]; truncated: boolean } {
  const limit = 512 * 1024;
  const result = messages.map((message) => message.role === "tool" ? { ...message, tool: { ...message.tool } } : { ...message });
  const size = (message: HistoryMessage) => Buffer.byteLength(JSON.stringify(message));
  const overhead = Buffer.byteLength(JSON.stringify({ nativeSessionId, messages: [], truncated: false }));
  let total = overhead + result.reduce((sum, message) => sum + size(message) + 1, 0);
  let truncated = false;
  for (const message of result) {
    if (total <= limit) break;
    if (message.role !== "tool") continue;
    const before = size(message);
    message.tool.input = "[truncated]";
    message.tool.result = "[truncated]";
    delete message.tool.rawResult;
    total += size(message) - before;
    truncated = true;
  }
  // Text-only or exceptionally many calls may still exceed the event budget.
  let start = 0;
  while (total > limit && start < result.length - 1) {
    total -= size(result[start++]!) + 1;
    truncated = true;
  }
  const kept = result.slice(start);
  if (total > limit && kept[0]?.role !== "tool" && kept[0]) {
    const message = kept[0];
    let low = 0, high = message.text.length;
    const original = message.text;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      message.text = original.slice(0, mid) + "…[truncated]";
      if (overhead + size(message) + 1 <= limit) low = mid; else high = mid - 1;
    }
    message.text = original.slice(0, low) + "…[truncated]";
    truncated = true;
  }
  return { messages: kept, truncated };
}
