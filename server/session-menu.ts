import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type McpAction = { action: "toggle"; serverName: string; enabled: boolean } | { action: "reconnect"; serverName: string };

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
