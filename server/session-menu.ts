import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type McpAction = { action: "toggle"; serverName: string; enabled: boolean } | { action: "reconnect"; serverName: string };

export interface SideQuestionInput { question: string; history?: { question: string; response: string }[] }

export function parseSideQuestion(input: unknown): SideQuestionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求体必须是 JSON 对象");
  const body = input as Record<string, unknown>;
  const validText = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 20000;
  if (!validText(body.question)) throw new Error("question 必须为 1–20000 字符的问题");
  if (body.history === undefined) return { question: body.question.trim() };
  if (!Array.isArray(body.history) || body.history.length > 20) throw new Error("history 最多 20 轮");
  const history = body.history.map(row => {
    if (!row || typeof row !== "object" || !validText(row.question) || !validText(row.response)) throw new Error("history 必须包含 question 和 response");
    return { question: row.question, response: row.response };
  });
  return { question: body.question.trim(), history };
}

export function parseTaskId(input: unknown): string {
  const id = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).taskId : undefined;
  if (typeof id !== "string" || !id.trim() || id.length > 500 || /[\x00-\x1f]/.test(id)) throw new Error("taskId 必须为非空任务 ID");
  return id;
}

/** 与扩展 currentModelInfo 相同：别名、[1m]、resolvedModel，未知模型不猜能力。 */
export function supportsClaudeFastMode(models: unknown, model: string | null | undefined): boolean {
  if (!Array.isArray(models)) return false;
  const selected = !model || model === "default" ? "default" : model;
  const base = selected.replace(/\[1m\]$/i, "");
  const rows = models.filter(row => row && typeof row === "object");
  const match = rows.find(row => row.value === selected) ?? rows.find(row => row.value === base)
    ?? rows.find(row => row.resolvedModel === selected || row.resolvedModel === base);
  return match?.supportsFastMode === true;
}

/** HTTP 边界只接受明确操作；绝不暴露任意 control_request 转发。 */
export function parseMcpAction(input: unknown): McpAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求体必须是 JSON 对象");
  const body = input as Record<string, unknown>;
  if (typeof body.serverName !== "string" || !body.serverName.trim() || body.serverName.length > 500 || /[\x00-\x1f]/.test(body.serverName)) {
    throw new Error("serverName 必须是非空服务器名称");
  }
  if (body.action === "toggle" && typeof body.enabled === "boolean") {
    return { action: "toggle", serverName: body.serverName, enabled: body.enabled };
  }
  if (body.action === "reconnect") return { action: "reconnect", serverName: body.serverName };
  throw new Error("action 必须为 toggle（enabled 为布尔值）或 reconnect");
}

/** 与续接按钮相同的协议打开方式；不会在服务器上启动编辑器。 */
export function menuFileUri(path: string, distro = process.env.WSL_DISTRO_NAME): string | null {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) return null;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return distro?.trim()
    ? `vscode://vscode-remote/wsl+${encodeURIComponent(distro.trim())}${encoded}`
    : `vscode://file${encoded}`;
}

export function menuSettingsFiles(cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) {
  return [
    { source: "userSettings", label: "用户设置", path: join(configDir, "settings.json") },
    { source: "projectSettings", label: "项目设置", path: join(cwd, ".claude", "settings.json") },
    { source: "localSettings", label: "项目本地设置", path: join(cwd, ".claude", "settings.local.json") },
  ].map(file => ({ ...file, uri: menuFileUri(file.path) }));
}

export function withMenuFileUris(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map(row => ({ ...row, uri: typeof row.path === "string" ? menuFileUri(row.path) : null }));
}
