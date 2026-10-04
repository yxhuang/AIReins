import { statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type IPty } from "@lydell/node-pty";
import type { AccessPolicy, RemoteConfig } from "./access.js";
import { ulid } from "./ulid.js";

export const MAX_SCROLLBACK_BYTES = 256 * 1024;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 300;

/**
 * 回放专用过滤：OSC 4/10/11/12 颜色查询、CSI DA 与 DSR/CPR 询问。
 * 这些查询没有视觉效果，但回放 scrollback 时 xterm 会重新应答，应答字节进 PTY 输入，
 * 被 shell 当键盘输入回显成垃圾（如 `11;rgb:fbfb/…`）。只剥查询（参数位只认数字/?/;），
 * `]11;rgb:x/y/z` 这类设置命令不受影响。实时推送不过滤——shell 启动时的首次应答是需要的。
 */
const REPLAY_QUERY_RE = /\x1b\](?:4|10|11|12)(?:;[\d?]+)+(?:\x07|\x1b\\)|\x1b\[[\d;>]*c|\x1b\[(?:5|6|\?6)n/g;

export function stripReplayQueries(data: string): string {
  return data.replace(REPLAY_QUERY_RE, "");
}

export type ShellKind = "bash" | "powershell";

export interface TerminalInfo {
  id: string;
  cwd: string;
  kind: ShellKind;
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

function validateTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || typeof cols !== "number" || cols < 1 || cols > MAX_TERMINAL_COLS) {
    throw new TerminalError("invalid", `cols 必须是 1 到 ${MAX_TERMINAL_COLS} 的整数`);
  }
  if (!Number.isInteger(rows) || typeof rows !== "number" || rows < 1 || rows > MAX_TERMINAL_ROWS) {
    throw new TerminalError("invalid", `rows 必须是 1 到 ${MAX_TERMINAL_ROWS} 的整数`);
  }
  return { cols, rows };
}

const POWERSHELL_CANDIDATES = [
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe",
];

/** 只认白名单种类，不接受路径——远程入口也会调到这里。 */
export function resolveShell(kind: unknown, exists: (path: string) => boolean = fileExists): { kind: ShellKind; file: string; args: string[] } {
  if (kind === undefined || kind === "bash") return { kind: "bash", file: "bash", args: ["-l", "-i"] };
  if (kind !== "powershell") throw new TerminalError("invalid", "shell 只能是 bash 或 powershell");
  const file = POWERSHELL_CANDIDATES.find(exists);
  if (!file) throw new TerminalError("invalid", "本机没有找到 PowerShell");
  return { kind, file, args: ["-NoLogo"] };
}

/** /mnt/<盘符> 下的路径 = Windows 目录，PowerShell 直接用。 */
export function isWindowsMount(path: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(path);
}

/** Windows 用户目录（/mnt/c/Users/<名>）：WSL 追加的 Windows PATH 里一定带它；找不到退 /mnt/c。 */
export function windowsHome(pathEnv = process.env.PATH ?? "", exists: (path: string) => boolean = directoryExists): string {
  for (const entry of pathEnv.split(":")) {
    const home = /^(\/mnt\/[a-z]\/Users\/[^/]+)\//i.exec(entry)?.[1];
    if (home && exists(home)) return home;
  }
  return "/mnt/c";
}

function directoryExists(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function fileExists(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
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

  create(input: { cwd?: string; shell?: unknown; cols: number; rows: number }): TerminalInfo {
    if (this.stopping) throw new TerminalError("invalid", "server 正在停止，不能新建终端");
    const { cols, rows } = validateTerminalSize(input.cols, input.rows);
    if (input.cwd !== undefined && typeof input.cwd !== "string") {
      throw new TerminalError("invalid", "cwd 必须是字符串");
    }
    const { kind, file: shell, args } = resolveShell(input.shell);
    const requested = this.existingDirectory(input.cwd);
    // PowerShell 不跟 WSL 目录：当前在 Windows 目录就用它，否则进 Windows 用户目录
    const cwd = kind === "powershell"
      ? (requested && isWindowsMount(requested) ? requested : windowsHome())
      : requested ?? this.defaultCwd;
    const pty = this.spawnPty(shell, args, { cwd, cols, rows, env: process.env, name: "xterm-256color" });
    const info: TerminalInfo = {
      id: `term_${ulid()}`,
      cwd,
      kind,
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
      data: stripReplayQueries(this.snapshot(record).toString("utf8")),
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
