import type { CommandInfo } from "./types";

// 斜杠命令面板的纯逻辑（无 DOM 依赖，可单测）：
// filterCommands 从 SessionView 抽出（行为不变），外加「最近使用」的读写与排序加权。
// localStorage 纪律与草稿/主题/cwd 相同：typeof 判定 + try/catch，拿不到时无声降级。

/** 每 agent 最近使用命令的 localStorage key 前缀；值是 JSON 数组（新 → 旧，命令名，≤10 条）。 */
const RECENT_STORAGE_PREFIX = "workbench-cmd-recent-";

/** 每 agent 记住的最近命令条数上限。 */
export const MAX_RECENT_COMMANDS = 10;

/** 读某 agent 的最近命令名（新 → 旧）；读不到/解析失败一律返回空数组。 */
export function readRecentCommands(agent: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(RECENT_STORAGE_PREFIX + agent);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .slice(0, MAX_RECENT_COMMANDS);
  } catch {
    return [];
  }
}

/** 记录一次命令使用：去重置顶、截断到上限；localStorage 不可用时静默跳过。 */
export function noteCommandUsed(agent: string, name: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const next = [name, ...readRecentCommands(agent).filter((item) => item !== name)];
    localStorage.setItem(
      RECENT_STORAGE_PREFIX + agent,
      JSON.stringify(next.slice(0, MAX_RECENT_COMMANDS)),
    );
  } catch {
    /* localStorage 不可用时仅本次不记忆 */
  }
}

/** recent 中仍存在于命令表的命令，按最近使用顺序（新 → 旧）；不在表内的名字跳过。 */
export function recentInTable(commands: CommandInfo[], recent: string[]): CommandInfo[] {
  const byName = new Map(commands.map((cmd) => [cmd.name, cmd]));
  const hits: CommandInfo[] = [];
  for (const name of recent) {
    const cmd = byName.get(name);
    if (cmd) hits.push(cmd);
  }
  return hits;
}

/**
 * 命令筛选：空 query 时「最近使用」段置顶（其余保持命令表原顺序）；
 * 有 query 时 名称前缀 > 名称子序列模糊 > 描述子串，各组内最近使用的命令先出（按最近序），
 * 其余保持命令表原顺序。
 */
export function filterCommands(
  commands: CommandInfo[],
  query: string,
  recent: string[] = [],
): CommandInfo[] {
  const recentHits = recentInTable(commands, recent);
  const q = query.toLowerCase();
  if (!q) {
    if (recentHits.length === 0) return commands;
    const hitSet = new Set(recentHits);
    return [...recentHits, ...commands.filter((cmd) => !hitSet.has(cmd))];
  }
  // 组内加权：recent 命中按最近序排前（未命中的同 rank，稳定排序保持表序）
  const rank = (cmd: CommandInfo): number => {
    const index = recentHits.indexOf(cmd);
    return index === -1 ? recentHits.length : index;
  };
  const weighted = (group: CommandInfo[]): CommandInfo[] =>
    group.some((cmd) => recentHits.includes(cmd))
      ? [...group].sort((a, b) => rank(a) - rank(b))
      : group;
  const prefix: CommandInfo[] = [];
  const fuzzy: CommandInfo[] = [];
  const desc: CommandInfo[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(cmd);
    else if (isSubsequence(q, name)) fuzzy.push(cmd);
    else if (cmd.description.toLowerCase().includes(q)) desc.push(cmd);
  }
  return [...weighted(prefix), ...weighted(fuzzy), ...weighted(desc)];
}

export function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i++;
      if (i === needle.length) return true;
    }
  }
  return needle.length === 0;
}
