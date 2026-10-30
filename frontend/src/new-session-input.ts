import type { AgentKind, CommandInfo, SessionRecord } from "./types";
import { normalizeDirectoryPath } from "./directory-path";
import { t } from "./i18n";
import type { SessionInfoKind } from "./api";

const CLAUDE_PANELS: Array<{ name: string; kind: SessionInfoKind; label: string }> = [
  { name: "plugin", kind: "plugins", label: "ui.SlashMenu.manage_plugins" },
  { name: "mcp", kind: "mcp", label: "ui.SlashMenu.mcp_servers" },
  { name: "instructions", kind: "instructions", label: "" },
  { name: "memory", kind: "memory", label: "" },
  { name: "skills", kind: "skills", label: "" },
  { name: "hooks", kind: "hooks", label: "" },
  { name: "output-style", kind: "output", label: "ui.SlashMenu.output_style" },
  { name: "permissions", kind: "permissions", label: "ui.SlashMenu.permission_rules" },
  { name: "sandbox", kind: "sandbox", label: "" },
  { name: "status", kind: "status", label: "ui.common.status" },
  { name: "usage", kind: "usage", label: "ui.SlashMenu.account_and_usage" },
  { name: "settings", kind: "settings", label: "ui.SlashMenu.claude_settings" },
];
// 选择器按命令引用比较，固定条目不能在每次快照读取时重新创建。
const CLAUDE_PANEL_COMMANDS: CommandInfo[] = CLAUDE_PANELS.map(panel => ({
  name: panel.name, description: panel.label ? t(panel.label) : panel.name, source: "claude",
}));

/** 只有无参数整行命令由面板接管；显式参数仍交给 CLI。 */
export function newSessionInfoKind(agent: AgentKind, text: string): SessionInfoKind | null {
  if (agent !== "claude") return null;
  const name = /^\/([^\s]+)$/.exec(text.trim())?.[1];
  return CLAUDE_PANELS.find(panel => panel.name === name || (name === "plugins" && panel.kind === "plugins"))?.kind ?? null;
}

/** 仅复用已加载的本机命令表；同目录优先，再按最后活动选择同 agent 会话。 */
export function newSessionCommands(agent: AgentKind, cwd: string, sessions: SessionRecord[], tables: Map<string, CommandInfo[]>): CommandInfo[] {
  const sameDirectory = (session: SessionRecord) => normalizeDirectoryPath(session.cwd) === normalizeDirectoryPath(cwd);
  const source = sessions.filter(session => session.agent === agent && tables.get(session.id)?.length)
    .sort((a, b) => Number(sameDirectory(b)) - Number(sameDirectory(a)) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];
  const commands = source ? tables.get(source.id)! : [];
  // Codex 其余条目是现有线程上的 AIReins 动作；review 可以填入首条消息。
  // Claude 管理面板由前端接管，侧问和依赖已有对话的生命周期命令不在新建页提供。
  const sessionOnly = new Set(["btw", "side", "mcp", "compact", "clear", "context", "cost", "usage", "status", "tasks", "resume", "rewind", "export", "exit", "quit", "model", "permissions", "config", "settings", "thinking", "fast"]);
  const panels = agent === "claude" ? CLAUDE_PANEL_COMMANDS : [];
  return [...panels, ...commands.filter(command => agent === "codex" ? command.name === "review"
    : !sessionOnly.has(command.name) && !newSessionInfoKind(agent, `/${command.name}`))];
}
