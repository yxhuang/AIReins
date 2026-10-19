import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { log } from "../logger.js";
import { captureWorkerIdentity } from "../worker-process.js";
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
  WorkerProcessIdentity,
} from "../types.js";

const MAX_EMBEDDED_MENTION_BYTES = 1024 * 1024;
export const POSIX_PROCESS_GROUPS = ["linux", "wsl", "darwin"].includes(platform);

/** 只在 spawn 后确认 child 确实拥有独立组时保存；不能等到组长退出后再采集。 */
export function captureProcessGroup(child: ChildProcessWithoutNullStreams, detached = POSIX_PROCESS_GROUPS): WorkerProcessIdentity | undefined {
  if (!detached || !POSIX_PROCESS_GROUPS || child.pid === process.pid) return undefined;
  const identity = captureWorkerIdentity(child.pid);
  return identity?.processGroupId === child.pid ? identity : undefined;
}

function pidGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** 当前 child 与已确认的独立组共用收尾；身份失效只降级为 child 信号，不提前成功。 */
export async function stopChildProcess(child: ChildProcessWithoutNullStreams, identity?: WorkerProcessIdentity, graceMs = 0): Promise<void> {
  const pid = child.pid;
  const live = () => child.exitCode === null && child.signalCode === null;
  let group = POSIX_PROCESS_GROUPS && typeof pid === "number" && pid > 0 && pid !== process.pid && identity?.processGroupId === pid;
  const matchesNow = () => {
    const current = group ? captureWorkerIdentity(pid) : undefined;
    return current !== undefined && current.bootId === identity!.bootId && current.startTime === identity!.startTime && current.processGroupId === pid;
  };
  // 进入 stop 时组长仍活着且身份匹配，本次 stop（宽限期 + 补刀，约 2 秒）内组长退出后仍可清理原组。
  let verified = live() && matchesNow();
  const signal =(value: NodeJS.Signals): "group" | "child" | "gone" => {
    if (group && child.pid === pid) {
      const matches = matchesNow();
      // 组信号只在本次 stop 内核实过组长身份后发出；组长在 stop 前已退出时无法证明组号未被复用，
      // 不发组信号（可能残留孤儿，但不误杀）。核实后组长才退出的，同一次 stop 内仍发往原组。
      if (matches || (verified && !live() && pidGone(pid!))) {
        verified = true;
        try { process.kill(-pid!, value); return "group"; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") log("warn", "process group signal failed", { pid, signal: value, message: errorMessage(error) });
        }
      }
      group = false;
    } else group = false;
    if (!live()) return "gone";
    try { child.kill(value); }
    catch (error) { log("warn", "child signal failed", { pid, signal: value, message: errorMessage(error) }); }
    return "child";
  };
  if (!live() && !group) return;
  await new Promise<void>(resolve => {
    let settled = false;
    let target: "group" | "child" | "gone" | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      if (escalation) clearTimeout(escalation);
      child.off("close", closed);
      resolve();
    };
    const terminate = () => {
      if (settled || escalation) return;
      target = signal("SIGTERM");
      if (settled) return;
      if (target === "gone") { finish(); return; }
      escalation = setTimeout(() => { signal("SIGKILL"); finish(); }, 1_000);
    };
    const closed = () => {
      if (target === "child" || !group) finish();
      else terminate();
    };
    child.once("close", closed);
    if (live() && graceMs > 0) {
      grace = setTimeout(terminate, graceMs);
      child.stdin.end();
    } else terminate();
  });
}

export abstract class BaseDriver implements Driver {
  abstract readonly kind: AgentKind;
  child?: ChildProcessWithoutNullStreams;
  protected readonly sessionId: string;
  protected readonly cwd: string;
  protected config: SessionConfig;
  protected readonly resumeSessionId?: string;
  protected readonly callbacks: DriverCallbacks;
  protected stopping = false;
  private processGroup?: { child: ChildProcessWithoutNullStreams; identity: WorkerProcessIdentity };

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
    // An AIReins worker is its own conversation, not the launcher terminal's delegate.
    for (const key of ["DELEGATE_RUN_ID", "DELEGATE_TOOL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "KIMI_CODE_SESSION_ID", "KIMI_SESSION_ID"]) delete env[key];
    env.WORKBENCH_PARENT_AGENT = this.kind;
    env.WORKBENCH_PARENT_SESSION_ID = this.sessionId;
    const detached = options.detached ?? POSIX_PROCESS_GROUPS;
    const child = spawn(command, args, {
      cwd: this.cwd,
      // Keep launcher descendants identifiable after AIReins or the launcher itself is killed.
      detached,
      ...options,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const identity = captureProcessGroup(child, detached);
    this.processGroup = identity ? { child, identity } : undefined;
    this.callbacks.metadata({});

    createInterface({ input: child.stdout }).on("line", (line) => this.handleStdoutLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      log("warn", "driver stderr", { sessionId: this.sessionId, driver: this.kind, line });
    });
    // 进程退出瞬间的写入会异步抛 EPIPE；退出本身由 close 处理，这里只防止崩掉 AIReins
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
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await stopChildProcess(child, this.processGroup?.child === child ? this.processGroup.identity : undefined, 1_000);
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
