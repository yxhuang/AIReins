import { statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type IPty } from "@lydell/node-pty";
import type { AccessPolicy, RemoteConfig } from "./access.js";
import { ulid } from "./ulid.js";

export const MAX_SCROLLBACK_BYTES = 256 * 1024;
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 300;

export interface TerminalInfo {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
}

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number | null };

export class TerminalError extends Error {
  constructor(readonly kind: "invalid" | "missing" | "exited", message: string) {
    super(message);
  }
}

interface TerminalRecord {
  info: TerminalInfo;
  pty: IPty;
  buffer: Buffer;
  head: number;
  size: number;
  omitted: number;
  listeners: Set<(event: TerminalEvent) => void>;
}

/** 能力只取决于请求进入的监听；远程配置未显式开启时保持关闭。 */
export function terminalEnabled(policy: AccessPolicy, remoteConfig: RemoteConfig | null): boolean {
  return policy.kind === "local" || remoteConfig?.terminal === true;
}

export function validateTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || typeof cols !== "number" || cols < 1 || cols > MAX_TERMINAL_COLS) {
    throw new TerminalError("invalid", `cols 必须是 1 到 ${MAX_TERMINAL_COLS} 的整数`);
  }
  if (!Number.isInteger(rows) || typeof rows !== "number" || rows < 1 || rows > MAX_TERMINAL_ROWS) {
    throw new TerminalError("invalid", `rows 必须是 1 到 ${MAX_TERMINAL_ROWS} 的整数`);
  }
  return { cols, rows };
}

/** 用户自由终端的独立注册表；不会接入 session/driver 的终端协议。 */
export class TerminalRegistry {
  private readonly records = new Map<string, TerminalRecord>();
  private stopping = false;

  constructor(
    private readonly defaultCwd: string,
    private readonly spawnPty: typeof spawn = spawn,
  ) {}

  list(): TerminalInfo[] {
    return [...this.records.values()].map(({ info }) => ({ ...info }));
  }

  get(id: string): TerminalInfo | undefined {
    const info = this.records.get(id)?.info;
    return info && { ...info };
  }

  create(input: { cwd?: string; cols: number; rows: number }): TerminalInfo {
    if (this.stopping) throw new TerminalError("invalid", "server 正在停止，不能新建终端");
    const { cols, rows } = validateTerminalSize(input.cols, input.rows);
    if (input.cwd !== undefined && typeof input.cwd !== "string") {
      throw new TerminalError("invalid", "cwd 必须是字符串");
    }
    const cwd = this.existingDirectory(input.cwd) ?? this.defaultCwd;
    const shell = process.env.SHELL || "bash";
    const pty = this.spawnPty(shell, ["-l", "-i"], { cwd, cols, rows, env: process.env, name: "xterm-256color" });
    const info: TerminalInfo = {
      id: `term_${ulid()}`,
      cwd,
      shell,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      exited: false,
      exitCode: null,
    };
    const record: TerminalRecord = {
      info, pty, buffer: Buffer.alloc(MAX_SCROLLBACK_BYTES), head: 0, size: 0, omitted: 0, listeners: new Set(),
    };
    this.records.set(info.id, record);
    pty.onData((data) => {
      this.append(record, data);
      this.emit(record, { type: "data", terminalId: info.id, data });
    });
    pty.onExit(({ exitCode }) => {
      info.exited = true;
      info.exitCode = exitCode;
      this.emit(record, { type: "exit", terminalId: info.id, exitCode });
    });
    return { ...info };
  }

  /** 注册订阅后立即返回同一时点的回放快照；调用方先发 attached，再发 data。 */
  attach(id: string, listener: (event: TerminalEvent) => void): { omitted: number; data: string; exited: boolean; exitCode: number | null; detach: () => void } {
    const record = this.require(id);
    record.listeners.add(listener);
    return {
      omitted: record.omitted,
      data: this.snapshot(record).toString("utf8"),
      exited: record.info.exited,
      exitCode: record.info.exitCode,
      detach: () => record.listeners.delete(listener),
    };
  }

  input(id: string, data: unknown): void {
    const record = this.requireLive(id);
    if (typeof data !== "string") throw new TerminalError("invalid", "input.data 必须是字符串");
    record.pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const record = this.requireLive(id);
    const size = validateTerminalSize(cols, rows);
    record.pty.resize(size.cols, size.rows);
    record.info.cols = size.cols;
    record.info.rows = size.rows;
  }

  kill(id: string): void {
    const record = this.require(id);
    if (!record.info.exited) record.pty.kill();
  }

  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const record of this.records.values()) {
      if (!record.info.exited) {
        try { record.pty.kill(); } catch { /* 进程可能已退出但 onExit 尚未回调；继续结束其余 PTY。 */ }
      }
      record.listeners.clear();
    }
  }

  private existingDirectory(path: string | undefined): string | undefined {
    if (!path) return undefined;
    try {
      const absolute = resolve(path);
      return statSync(absolute).isDirectory() ? absolute : undefined;
    } catch {
      return undefined;
    }
  }

  private require(id: string): TerminalRecord {
    const record = this.records.get(id);
    if (!record) throw new TerminalError("missing", `终端不存在：${id}`);
    return record;
  }

  private requireLive(id: string): TerminalRecord {
    const record = this.require(id);
    if (record.info.exited) throw new TerminalError("exited", `终端已退出：${id}`);
    return record;
  }

  private append(record: TerminalRecord, data: string): void {
    const chunk = Buffer.from(data, "utf8");
    if (chunk.length >= MAX_SCROLLBACK_BYTES) {
      record.omitted += record.size + chunk.length - MAX_SCROLLBACK_BYTES;
      chunk.copy(record.buffer, 0, chunk.length - MAX_SCROLLBACK_BYTES);
      record.head = 0;
      record.size = MAX_SCROLLBACK_BYTES;
      return;
    }
    const excess = Math.max(0, record.size + chunk.length - MAX_SCROLLBACK_BYTES);
    record.head = (record.head + excess) % MAX_SCROLLBACK_BYTES;
    record.size -= excess;
    record.omitted += excess;
    const tail = (record.head + record.size) % MAX_SCROLLBACK_BYTES;
    const firstPart = Math.min(chunk.length, MAX_SCROLLBACK_BYTES - tail);
    chunk.copy(record.buffer, tail, 0, firstPart);
    chunk.copy(record.buffer, 0, firstPart);
    record.size += chunk.length;
  }

  private snapshot(record: TerminalRecord): Buffer {
    const output = Buffer.allocUnsafe(record.size);
    const firstPart = Math.min(record.size, MAX_SCROLLBACK_BYTES - record.head);
    record.buffer.copy(output, 0, record.head, record.head + firstPart);
    record.buffer.copy(output, firstPart, 0, record.size - firstPart);
    return output;
  }

  private emit(record: TerminalRecord, event: TerminalEvent): void {
    for (const listener of record.listeners) listener(event);
  }
}
