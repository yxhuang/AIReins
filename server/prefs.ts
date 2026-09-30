import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workbenchHome } from "./persistence.js";

export interface WorkbenchPrefs {
  /** 空闲自动释放 worker 的分钟数；0 = 关闭 */
  idleReleaseMinutes: number;
}

export const MAX_IDLE_RELEASE_MINUTES = 1_440;
export const DEFAULT_PREFS: WorkbenchPrefs = { idleReleaseMinutes: 30 };

export function prefsPath(): string {
  return join(workbenchHome, "prefs.json");
}

export function isValidIdleReleaseMinutes(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_IDLE_RELEASE_MINUTES;
}

/** 文件缺失、坏 JSON 或字段无效时按默认值处理。 */
export function loadPrefs(): WorkbenchPrefs {
  try {
    const path = prefsPath();
    if (!existsSync(path)) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const value = (parsed as Record<string, unknown> | null)?.idleReleaseMinutes;
    return { idleReleaseMinutes: isValidIdleReleaseMinutes(value) ? value : DEFAULT_PREFS.idleReleaseMinutes };
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
