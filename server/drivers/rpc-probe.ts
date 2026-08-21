import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { parseJsonLine, withTimeout } from "./base.js";

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
}

export class StdioRpcProbe {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRpc>();
  private nextId = 1;
  private stderr = "";

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", () => {
      if (this.pending.size > 0) {
        this.rejectAll(new Error(this.stderr.trim() || `${command} probe 提前退出`));
      }
    });
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    try {
      return await withTimeout(response, timeoutMs, `${method} probe`);
    } finally {
      this.pending.delete(id);
    }
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      this.child.once("close", finish);
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
        setTimeout(finish, 500).unref();
      }, 500);
      timer.unref();
    });
  }

  private handleLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message || !Object.hasOwn(message, "id") || message.method) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
