// 终端面板纯逻辑（无 DOM 依赖，tsx 单测直接 import）。
// 接口形状以 docs/terminal-panel-design.md §9 为唯一契约，不自创字段。
import type { ShellKind, TerminalInfo } from "./types";

/** 面板宽度下限（px）：再窄终端就没法用了。 */
export const TERM_MIN_WIDTH = 320;
/** 主区至少保留的宽度（px）：面板宽上限 = 视口宽 − 此值。 */
export const TERM_MAIN_MIN_WIDTH = 480;
/** 双击分隔条复位的默认宽度（px）。 */
export const TERM_DEFAULT_WIDTH = 480;

/**
 * 面板宽度 clamp 到 [320, 视口宽 − 480]。
 * 视口过窄（上限 < 下限）时区间为空，按下限 320 收口——宁挤主区也不让面板消失；
 * 非有限输入（坏 localStorage 数据）按默认宽度再 clamp。
 */
export function clampPanelWidth(width: number, viewportWidth: number, minWidth = TERM_MIN_WIDTH, defaultWidth = TERM_DEFAULT_WIDTH): number {
  const max = Math.max(minWidth, viewportWidth - TERM_MAIN_MIN_WIDTH);
  if (!Number.isFinite(width)) return Math.min(defaultWidth, max);
  return Math.min(Math.max(minWidth, Math.round(width)), max);
}

/** 手机快捷键栏按键 → 发往终端的控制序列。 */
interface TermShortcutKey {
  id: string;
  label: string;
  seq: string;
  ariaLabel: string;
}

export const TERM_SHORTCUT_KEYS: TermShortcutKey[] = [
  { id: "esc", label: "Esc", seq: "\x1b", ariaLabel: "发送 Esc 到终端" },
  { id: "tab", label: "Tab", seq: "\t", ariaLabel: "发送 Tab 到终端" },
  { id: "ctrl-c", label: "Ctrl-C", seq: "\x03", ariaLabel: "发送 Ctrl-C（中断）到终端" },
  { id: "ctrl-d", label: "Ctrl-D", seq: "\x04", ariaLabel: "发送 Ctrl-D（EOF）到终端" },
  { id: "up", label: "↑", seq: "\x1b[A", ariaLabel: "发送上方向键到终端" },
  { id: "down", label: "↓", seq: "\x1b[B", ariaLabel: "发送下方向键到终端" },
  { id: "left", label: "←", seq: "\x1b[D", ariaLabel: "发送左方向键到终端" },
  { id: "right", label: "→", seq: "\x1b[C", ariaLabel: "发送右方向键到终端" },
];

/** /ws/terminal 的 URL：与 store.ts 的 /ws 同一取法（https 入口用 wss）。 */
export function buildTerminalWsUrl(protocol: string, host: string): string {
  const scheme = protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}/ws/terminal`;
}

/** 当前 attach 的终端的归约状态（每 attach 一次重置）。 */
export interface TermSessionState {
  /** 已收到 attached（此前到达的 data 不是回放数据，直接忽略） */
  attached: boolean;
  /** scrollback 因 256KB 上限被服务端丢弃的字节数（>0 时面板顶部提示） */
  omitted: number;
  exited: boolean;
  exitCode: number | null;
}

export function initialTermState(): TermSessionState {
  return { attached: false, omitted: 0, exited: false, exitCode: null };
}

/** 归约产生的副作用，由连接层应用到 xterm / React 状态。 */
type TermEffect =
  | { type: "reset" }
  | { type: "write"; data: string }
  | { type: "exited"; exitCode: number | null }
  | { type: "error"; message: string };

/**
 * /ws/terminal 下行帧归约：
 * - attached：重置状态（重复 attach = 重新回放，先 reset 再写），记录 omitted；
 * - data：仅在 attached 之后追加（回放帧在 attached 之后到达，乱序帧不写）；
 * - exit：标记退出与退出码；
 * - error：terminalId 缺省或匹配当前终端时转成提示，其他终端的帧一律忽略。
 */
export function reduceTermFrame(
  state: TermSessionState,
  terminalId: string,
  frame: unknown,
): { state: TermSessionState; effects: TermEffect[] } {
  if (!frame || typeof frame !== "object") return { state, effects: [] };
  const f = frame as Record<string, unknown>;
  const frameId = typeof f.terminalId === "string" ? f.terminalId : null;
  if (f.type === "error") {
    if (frameId !== null && frameId !== terminalId) return { state, effects: [] };
    const message = typeof f.message === "string" && f.message ? f.message : "未知错误";
    return { state, effects: [{ type: "error", message }] };
  }
  if (frameId !== terminalId) return { state, effects: [] };
  switch (f.type) {
    case "attached": {
      const omitted =
        typeof f.omitted === "number" && Number.isFinite(f.omitted) && f.omitted > 0
          ? Math.floor(f.omitted)
          : 0;
      return {
        state: { attached: true, omitted, exited: false, exitCode: null },
        effects: [{ type: "reset" }],
      };
    }
    case "data": {
      if (!state.attached) return { state, effects: [] };
      const data = typeof f.data === "string" ? f.data : "";
      if (!data) return { state, effects: [] };
      return { state, effects: [{ type: "write", data }] };
    }
    case "exit": {
      const exitCode =
        typeof f.exitCode === "number" && Number.isFinite(f.exitCode) ? f.exitCode : null;
      return {
        state: { ...state, exited: true, exitCode },
        effects: [{ type: "exited", exitCode }],
      };
    }
    default:
      return { state, effects: [] };
  }
}

/** 建终端的 cwd 取值：当前所看会话的 cwd，没有会话取 meta.defaultCwd（§9 定案 2）。 */
export function pickTerminalCwd(
  sessionCwd: string | undefined,
  defaultCwd: string | undefined,
): string | undefined {
  const cwd = sessionCwd?.trim();
  if (cwd) return cwd;
  const fallback = defaultCwd?.trim();
  return fallback || undefined;
}

/** localStorage 键：最近激活的终端 id，刷新后引导优先重连它（读写按本仓库纪律 try/catch）。 */
export const TERM_ACTIVE_STORAGE_KEY = "workbench-term-active";

/** 激活顺序从旧到新；忽略已退出、已删除或其他 kind 的记录。 */
export function pickRecentTerminal(terminals: TerminalInfo[], kind: ShellKind, activationOrder: readonly string[]): TerminalInfo | null {
  const live = terminals.filter((terminal) => !terminal.exited && terminal.kind === kind);
  for (let index = activationOrder.length - 1; index >= 0; index--) {
    const target = live.find((terminal) => terminal.id === activationOrder[index]);
    if (target) return target;
  }
  return live[0] ?? null;
}

/** 关闭退出标签时优先右侧邻居，再向两侧找最近的存活标签。 */
export function pickAdjacentTerminal(terminals: TerminalInfo[], id: string): TerminalInfo | null {
  const index = terminals.findIndex((terminal) => terminal.id === id);
  if (index < 0) return null;
  for (let distance = 1; distance < terminals.length; distance++) {
    for (const candidate of [terminals[index + distance], terminals[index - distance]]) {
      if (candidate && !candidate.exited) return candidate;
    }
  }
  return null;
}

/**
 * 刷新/重进面板时的 attach 目标：
 * 持久化的激活 id 仍存活 → 它；否则第一个未退出的（不限 shell 种类）；都没有返回 null（调用方新建）。
 */
export function pickBootTerminal(terminals: TerminalInfo[], persistedId: string | null): TerminalInfo | null {
  if (persistedId) {
    const hit = terminals.find((t) => t.id === persistedId && !t.exited);
    if (hit) return hit;
  }
  return terminals.find((t) => !t.exited) ?? null;
}

/** 标签条上的一个终端标签。 */
export interface TermTab {
  id: string;
  kind: ShellKind;
  /** 显示名：唯一时就是 shell 名；同种多个时全部带序号（bash 1 / bash 2，VSCode 式）。 */
  label: string;
  cwd: string;
  exited: boolean;
}

/**
 * 终端列表 → 标签条：
 * 已退出的只保留当前激活的那个（刚退出还能看输出与退出码），其余藏掉；
 * 顺序保持服务端注册表顺序（创建先后）；同种 shell 多个时按顺序编号。
 */
export function buildTermTabs(terminals: TerminalInfo[], activeId: string | null): TermTab[] {
  const visible = terminals.filter((t) => !t.exited || t.id === activeId);
  const totals = new Map<ShellKind, number>();
  for (const t of visible) totals.set(t.kind, (totals.get(t.kind) ?? 0) + 1);
  const seen = new Map<ShellKind, number>();
  return visible.map((t) => {
    const base = t.kind === "powershell" ? "PowerShell" : "bash";
    const n = (seen.get(t.kind) ?? 0) + 1;
    seen.set(t.kind, n);
    const label = (totals.get(t.kind) ?? 0) > 1 ? `${base} ${n}` : base;
    return { id: t.id, kind: t.kind, label, cwd: t.cwd, exited: t.exited };
  });
}

/** Shared by the global listener and xterm passthrough; dispatch only on keydown. */
export function isTerminalToggleKey(event: Pick<KeyboardEvent, "ctrlKey" | "code" | "altKey" | "metaKey" | "shiftKey">): boolean {
  return event.ctrlKey && event.code === "Backquote" && !event.altKey && !event.metaKey && !event.shiftKey;
}
