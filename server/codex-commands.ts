import type { UnifiedCommand } from "./types.js";

/** Curated client actions, verified against codex-cli 0.159.3's generated v2 schema. */
export const CODEX_COMMANDS: UnifiedCommand[] = [
  { name: "status", description: "查看当前线程与会话配置", source: "codex" },
  { name: "model", description: "查看可用模型；切换使用输入框模型菜单", source: "codex" },
  { name: "mcp", description: "查看 MCP 连接、工具与认证状态", source: "codex" },
  { name: "skills", description: "查看当前工作目录可用的 skills；用 $名称调用", source: "codex" },
  { name: "compact", description: "压缩当前线程上下文", source: "codex" },
  { name: "review", description: "审查未提交改动，或按指定要求审查", argHint: "可选审查要求（留空审查未提交改动）", source: "codex" },
  { name: "new", description: "在相同目录新建 Codex 会话，保留当前对话", source: "codex" },
  { name: "interrupt", description: "中断当前执行", source: "codex" },
];

export function parseCodexCommand(input: unknown): { name: string; arguments?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("command 必须是对象");
  const value = input as Record<string, unknown>;
  if (typeof value.name !== "string" || !CODEX_COMMANDS.some(c => c.name === value.name)) {
    throw new Error("未知 Codex 命令");
  }
  if (value.arguments !== undefined && (typeof value.arguments !== "string" || value.arguments.length > 8000)) {
    throw new Error("arguments 必须是至多 8000 字符的文本");
  }
  const args = typeof value.arguments === "string" ? value.arguments.trim() : "";
  if (args && value.name !== "review") throw new Error("该 Codex 命令不接受参数");
  return { name: value.name, ...(args ? { arguments: args } : {}) };
}

export interface CodexSkill {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope: string;
}

export function codexSkillsForCwd(result: any, cwd: string): { skills: CodexSkill[]; errors: unknown[] } {
  const groups = Array.isArray(result?.data) ? result.data.filter((g: any) => g?.cwd === cwd) : [];
  return {
    skills: groups.flatMap((g: any) => Array.isArray(g.skills) ? g.skills : [])
      .filter((s: any) => s?.enabled === true && typeof s.name === "string" && typeof s.description === "string"
        && typeof s.path === "string" && s.path.startsWith("/"))
      .map((s: any) => ({ name: s.name, description: s.description, path: s.path, enabled: true, scope: s.scope })),
    errors: groups.flatMap((g: any) => Array.isArray(g.errors) ? g.errors : []),
  };
}

/** The picker inserts $name; paths always come from skills/list, never from client input. */
export function codexSkillInputs(text: string, skills: CodexSkill[]): Array<{ type: "skill"; name: string; path: string }> {
  const selected = new Map<string, { type: "skill"; name: string; path: string }>();
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const escaped = skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\w$\\\\])\\$${escaped}(?![\\w:./-])`, "u").test(text)) continue;
    const previous = selected.get(skill.name);
    if (previous && previous.path !== skill.path) throw new Error(`Skill 名称重复，无法确定文件：${skill.name}`);
    selected.set(skill.name, { type: "skill", name: skill.name, path: skill.path });
  }
  return [...selected.values()];
}
