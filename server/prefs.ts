import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workbenchHome } from "./persistence.js";

export interface WorkbenchPrefs {
  /** 空闲自动释放 worker 的分钟数；0 = 关闭 */
  idleReleaseMinutes: number;
  /** 会话保留天数：最后活动早于此的会话在启动时清掉（对标 Claude 的 cleanupPeriodDays）；0 = 不清 */
  retentionDays: number;
}

const MAX_IDLE_RELEASE_MINUTES = 1_440;
const MAX_RETENTION_DAYS = 3_650;
export const DEFAULT_PREFS: WorkbenchPrefs = { idleReleaseMinutes: 30, retentionDays: 30 };

export function prefsPath(): string {
  return join(workbenchHome, "prefs.json");
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
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: WorkbenchPrefs): void {
  const path = prefsPath();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
