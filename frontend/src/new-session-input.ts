import type { AgentKind, CommandInfo, SessionRecord } from "./types";
import { normalizeDirectoryPath } from "./directory-path";

/** 仅复用已加载的本机命令表；同目录优先，再按最后活动选择同 agent 会话。 */
export function newSessionCommands(agent: AgentKind, cwd: string, sessions: SessionRecord[], tables: Map<string, CommandInfo[]>): CommandInfo[] {
  const sameDirectory = (session: SessionRecord) => normalizeDirectoryPath(session.cwd) === normalizeDirectoryPath(cwd);
  const source = sessions.filter(session => session.agent === agent && tables.get(session.id)?.length)
    .sort((a, b) => Number(sameDirectory(b)) - Number(sameDirectory(a)) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];
  const commands = source ? tables.get(source.id)! : [];
  // Codex 其余条目是现有线程上的 AIReins 动作；review 可以填入首条消息。
  // Claude MCP/侧问由会话 UI 接管，其他会话信息与生命周期命令也不在新建页提供。
  const sessionOnly = new Set(["btw", "side", "mcp", "compact", "clear", "context", "cost", "usage", "status", "tasks", "resume", "rewind", "export", "exit", "quit", "model", "permissions", "config", "settings", "thinking", "fast"]);
  return commands.filter(command => agent === "codex" ? command.name === "review" : !sessionOnly.has(command.name));
}
