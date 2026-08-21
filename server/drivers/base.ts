import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../logger.js";
import type { AgentKind, Driver, DriverCallbacks, DriverOptions, PermissionDecision } from "../types.js";

export abstract class BaseDriver implements Driver {
  abstract readonly kind: AgentKind;
  child?: ChildProcessWithoutNullStreams;
  protected readonly sessionId: string;
  protected readonly cwd: string;
  protected readonly model?: string;
  protected readonly resumeSessionId?: string;
  protected readonly callbacks: DriverCallbacks;
  protected stopping = false;

  constructor(options: DriverOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.model = options.model;
    this.resumeSessionId = options.resumeSessionId;
    this.callbacks = options.callbacks;
  }

  abstract start(): Promise<void>;
  abstract sendUserMessage(text: string): Promise<void>;
  abstract resolvePermission(requestId: string, decision: PermissionDecision, updatedInput?: unknown): Promise<void>;

  protected spawnProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): void {
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: process.env,
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.callbacks.metadata({});

    createInterface({ input: child.stdout }).on("line", (line) => this.handleStdoutLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      log("warn", "driver stderr", { sessionId: this.sessionId, driver: this.kind, line });
    });
    child.on("error", (error) => {
      this.callbacks.emit("session_error", { message: error.message, source: "process" });
      this.callbacks.status("error");
    });
    child.on("close", (code, signal) => {
      this.callbacks.exited({ code, signal, expected: this.stopping });
    });
  }

  protected abstract handleStdoutLine(line: string): void;

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
        setTimeout(finish, 1_000).unref();
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

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      timer.unref();
    }),
  ]);
}
