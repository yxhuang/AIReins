import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export interface WorkbenchPrefs {
  /** 空闲自动释放 worker 的分钟数；0 = 关闭 */
  idleReleaseMinutes: number;
  /** 会话保留天数：最后活动早于此的会话在启动时清掉（对标 Claude 的 cleanupPeriodDays）；0 = 不清 */
  retentionDays: number;
  /** 本机配置：绝对路径；无参数排定 60 秒后关机，abort 取消。 */
  shutdownCommand?: string;
  /** Tibo 额度重置公开监控；省略等同关闭。 */
  codexResetWatch?: boolean;
  /** 省略时使用 Claude CLI 默认入口身份。 */
  claudeCodeEntrypoint?: "claude-vscode";
  /** 目录浏览器主目录；省略时使用 $HOME。 */
  directoryBrowserHome?: string;
  /** Local HTTP(S) proxy for CLI children and self-update Git network commands. */
  proxyUrl?: string;
  /** Legacy alias for proxyUrl, used only when proxyUrl is absent or invalid. */
  codexProxyUrl?: string;
}

const MAX_IDLE_RELEASE_MINUTES = 1_440;
const MAX_RETENTION_DAYS = 3_650;
export const DEFAULT_PREFS: WorkbenchPrefs = { idleReleaseMinutes: 30, retentionDays: 30 };

export function prefsPath(): string {
  return join(process.env.WORKBENCH_HOME || join(homedir(), ".workbench"), "prefs.json");
}

export function isValidIdleReleaseMinutes(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_IDLE_RELEASE_MINUTES;
}

function isValidRetentionDays(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_RETENTION_DAYS;
}

/** 文件缺失、坏 JSON 时按默认值处理；单个字段无效只回落该字段。 */
export function loadPrefs(): WorkbenchPrefs {
  try {
    const path = prefsPath();
    if (!existsSync(path)) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = parsed as Record<string, unknown> | null;
    const idle = record?.idleReleaseMinutes;
    const retention = record?.retentionDays;
    return {
      idleReleaseMinutes: isValidIdleReleaseMinutes(idle) ? idle : DEFAULT_PREFS.idleReleaseMinutes,
      retentionDays: isValidRetentionDays(retention) ? retention : DEFAULT_PREFS.retentionDays,
      ...(typeof record?.codexResetWatch === "boolean" ? { codexResetWatch: record.codexResetWatch } : {}),
      ...(validPath(record?.shutdownCommand) ? { shutdownCommand: record!.shutdownCommand as string } : {}),
      ...(record?.claudeCodeEntrypoint === "claude-vscode" ? { claudeCodeEntrypoint: "claude-vscode" as const } : {}),
      ...(validPath(record?.directoryBrowserHome) ? { directoryBrowserHome: record!.directoryBrowserHome as string } : {}),
      ...(validProxyUrl(record?.codexProxyUrl) ? { codexProxyUrl: record!.codexProxyUrl as string } : {}),
      ...(validProxyUrl(record?.proxyUrl) ? { proxyUrl: record!.proxyUrl as string } : {}),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function validProxyUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /\s|\u0000/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\u0000");
}

export function savePrefs(prefs: WorkbenchPrefs): void {
  const path = prefsPath();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
