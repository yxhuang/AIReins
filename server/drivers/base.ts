import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { log } from "../logger.js";
import { platform } from "../platform.js";
import type {
  AgentKind,
  Driver,
  DriverCallbacks,
  DriverConfigSchema,
  DriverOptions,
  PermissionDecision,
  QuestionAnswers,
  SessionConfig,
  FileMention,
  UserMessageInput,
  SendUserMessageOptions,
  SendUserMessageReceipt,
} from "../types.js";

const MAX_EMBEDDED_MENTION_BYTES = 1024 * 1024;

export abstract class BaseDriver implements Driver {
  abstract readonly kind: AgentKind;
  child?: ChildProcessWithoutNullStreams;
  protected readonly sessionId: string;
  protected readonly cwd: string;
  protected config: SessionConfig;
  protected readonly resumeSessionId?: string;
  protected readonly callbacks: DriverCallbacks;
  protected stopping = false;

  constructor(options: DriverOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.config = { ...options.config };
    this.resumeSessionId = options.resumeSessionId;
    this.callbacks = options.callbacks;
  }

  abstract start(): Promise<void>;
  abstract getConfigSchema(): DriverConfigSchema;
  abstract setConfig(config: SessionConfig): Promise<SessionConfig>;
  abstract sendUserMessage(message: UserMessageInput, options?: SendUserMessageOptions): Promise<void | SendUserMessageReceipt>;
  abstract resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void>;

  protected spawnProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): void {
    const env = { ...(options.env ?? process.env) };
    // A Workbench worker is its own conversation, not the launcher terminal's delegate.
    for (const key of ["DELEGATE_RUN_ID", "DELEGATE_TOOL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "KIMI_CODE_SESSION_ID", "KIMI_SESSION_ID"]) delete env[key];
    env.WORKBENCH_PARENT_AGENT = this.kind;
    env.WORKBENCH_PARENT_SESSION_ID = this.sessionId;
    const child = spawn(command, args, {
      cwd: this.cwd,
      // Keep launcher descendants identifiable after wb or the launcher itself is killed.
      detached: platform === "linux" || platform === "wsl" || platform === "darwin",
      ...options,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.callbacks.metadata({});

    createInterface({ input: child.stdout }).on("line", (line) => this.handleStdoutLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      log("warn", "driver stderr", { sessionId: this.sessionId, driver: this.kind, line });
    });
    // 进程退出瞬间的写入会异步抛 EPIPE；退出本身由 close 处理，这里只防止崩掉 wb
    child.stdin.on("error", (error) => {
      log("warn", "driver stdin error", { sessionId: this.sessionId, driver: this.kind, message: error.message });
    });
    child.on("error", (error) => {
      this.callbacks.emit("session_error", { message: error.message, source: "process" });
      this.callbacks.status("error");
    });
    child.on("close", (code, signal) => {
      this.handleProcessExit();
      this.callbacks.exited({ code, signal, expected: this.stopping });
    });
  }

  protected abstract handleStdoutLine(line: string): void;

  protected handleProcessExit(): void {}

  protected send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.kind} worker stdin 已关闭`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async interrupt(): Promise<void> {
    if (!this.child || this.child.killed) return;
    this.child.kill("SIGINT");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopping = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      child.once("close", finish);
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          finish();
        }, 1_000).unref();
      }, 1_000);
      timer.unref();
    });
  }
}

export function parseJsonLine(line: string): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? value as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userMessageText(message: UserMessageInput): string {
  if (!message.command) return message.text ?? "";
  const name = message.command.name.replace(/^\/+/, "");
  const args = message.command.arguments?.trim();
  return `/${name}${args ? ` ${args}` : ""}`;
}

function readMentionText(mention: FileMention): string {
  const fd = openSync(mention.path, "r");
  try {
    if (fstatSync(fd).size > MAX_EMBEDDED_MENTION_BYTES) {
      throw new Error(`引用文件超过 1 MiB，无法嵌入：${mention.path}`);
    }
    // 多读一字节捕获检查后增长的文件；短读时继续，但总量始终有界。
    const buffer = Buffer.alloc(MAX_EMBEDDED_MENTION_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const count = readSync(fd, buffer, length, buffer.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_EMBEDDED_MENTION_BYTES) {
      throw new Error(`引用文件超过 1 MiB，无法嵌入：${mention.path}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error(`当前只支持 UTF-8 文本文件引用：${mention.path}`);
    }
  } finally {
    closeSync(fd);
  }
}

/** 读不了（二进制或超 1 MiB）时返回 null 而不是抛错，由调用方降级为路径提示。 */
export function tryReadMentionText(mention: FileMention): string | null {
  try {
    return readMentionText(mention);
  } catch {
    return null;
  }
}

/** 二进制/超大文件引用的降级提示行，追加在用户文本末尾（agent 可自行用工具读取）。 */
export function mentionFallbackNote(path: string): string {
  return `[附件] ${path}（二进制或超过 1 MiB，未嵌入，请用工具读取）`;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
