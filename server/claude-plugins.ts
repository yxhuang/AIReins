import { proxyEnvironment } from "./proxy-env.js";
import { execFile } from "node:child_process";

export interface ClaudePlugin {
  id: string;
  scope?: "user" | "project" | "local";
  enabled?: boolean;
  projectEnabled?: boolean;
  [key: string]: unknown;
}

type PluginRunner = (cwd: string, args: string[]) => Promise<unknown>;

const runPluginCommand: PluginRunner = (cwd, args) => new Promise((resolve, reject) => {
  execFile("claude", ["plugin", ...args], {
    cwd, env: proxyEnvironment(), timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`claude plugin ${args[0]} 失败：${stderr.trim() || error.message}`));
    try {
      const result: unknown = JSON.parse(stdout);
      if (result && typeof result === "object" && "success" in result && result.success === false) {
        throw new Error(String((result as Record<string, unknown>).error ?? "插件操作失败"));
      }
      resolve(result);
    } catch (error) {
      reject(new Error(`claude plugin ${args[0]}：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

/** 列表快照决定允许操作的 id 和 scope，客户端不能提供任意 CLI 参数。 */
export class ClaudePlugins {
  private readonly latest = new Map<string, ClaudePlugin[]>();
  constructor(private readonly run: PluginRunner = runPluginCommand) {}

  async list(cwd: string): Promise<ClaudePlugin[]> {
    const result = await this.run(cwd, ["list", "--json"]);
    if (!Array.isArray(result) || result.some((p) => !p || typeof p !== "object" || typeof p.id !== "string")) {
      this.latest.delete(cwd);
      throw new Error("claude plugin list 输出不是插件列表");
    }
    // CLI 会列出所有项目的安装记录；每个插件只留当前目录下最具体的一条（local > project > user）。
    // enabled 已是 CLI 按 cwd 算出的实际生效状态，开关作用于这一条的 scope。
    const rank = (p: ClaudePlugin) => ({ local: 3, project: 2, user: 1 } as Record<string, number>)[p.scope ?? ""] ?? 0;
    const byId = new Map<string, ClaudePlugin>();
    for (const p of result as ClaudePlugin[]) {
      if (typeof p.projectPath === "string" && p.projectPath !== cwd) continue;
      const prev = byId.get(p.id);
      if (!prev || rank(p) > rank(prev)) byId.set(p.id, p);
    }
    const plugins = [...byId.values()];
    this.latest.set(cwd, plugins);
    return plugins;
  }

  async setEnabled(cwd: string, id: string, enabled: boolean, scope?: unknown): Promise<void> {
    if (typeof id !== "string" || !id || id.startsWith("-") || /[\x00-\x1f]/.test(id)) {
      throw new Error("插件 id 不合法");
    }
    if (typeof enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    const matches = (this.latest.get(cwd) ?? []).filter((p) => p.id === id && (scope === undefined || p.scope === scope));
    if (matches.length !== 1) throw new Error("插件不在最近一次列表中或 scope 不明确，请刷新列表");
    const plugin = matches[0];
    const args = [enabled ? "enable" : "disable", plugin.id, "--json"];
    if (plugin.scope !== undefined) {
      if (!["user", "project", "local"].includes(plugin.scope)) throw new Error("插件 scope 不支持切换");
      args.push("-s", plugin.scope);
    }
    await this.run(cwd, args);
    this.latest.delete(cwd);
  }
}
