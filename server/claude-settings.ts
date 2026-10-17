import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeEffectiveSettings {
  model: string | null;
  effort: string | null;
  remoteControlAtStartup?: boolean;
}

export interface ClaudeStartupSettings {
  remoteControlAtStartup: boolean;
}

function readUserSettings(userHome: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(userHome, ".claude", "settings.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude settings.json 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 新建页只读用户级默认值；坏配置不阻塞 meta，也不返回其他设置。 */
export function readClaudeDefaultSettings(userHome = homedir()): Pick<ClaudeEffectiveSettings, "model" | "effort"> {
  try {
    const settings = readUserSettings(userHome);
    return { model: nonEmptyString(settings.model), effort: nonEmptyString(settings.effortLevel) };
  } catch {
    return { model: null, effort: null };
  }
}

/** 用户级开关；项目层的 false 仍由 worker 启动时单独处理。 */
export function readClaudeStartupSettings(userHome = homedir()): ClaudeStartupSettings {
  return { remoteControlAtStartup: readUserSettings(userHome).remoteControlAtStartup === true };
}

export function writeClaudeStartupSettings(enabled: boolean, userHome = homedir()): ClaudeStartupSettings {
  if (typeof enabled !== "boolean") throw new Error("remoteControlAtStartup 必须是布尔值");
  const settings = readUserSettings(userHome);
  settings.remoteControlAtStartup = enabled;
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  // writeFileSync 跟随软链接写入目标；禁止用 rename 覆盖 settings.json 链接。
  writeFileSync(join(userHome, ".claude", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return readClaudeStartupSettings(userHome);
}

/** Resolve one Claude session's layered settings without launching Claude. */
export function readClaudeEffectiveSettings(
  cwd: string,
  userHome: string = homedir(),
): ClaudeEffectiveSettings {
  const effective: ClaudeEffectiveSettings = { model: null, effort: null, remoteControlAtStartup: false };
  const paths = [
    join(userHome, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];

  let projectDisabled = false;
  for (const [index, path] of paths.entries()) {
    let settings: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      settings = parsed as Record<string, unknown>;
    } catch {
      // Missing, unreadable and invalid JSON layers independently fall back.
      continue;
    }

    const model = nonEmptyString(settings.model);
    const effort = nonEmptyString(settings.effortLevel);
    if (model !== null) effective.model = model;
    if (effort !== null) effective.effort = effort;
    if (index === 0 && settings.remoteControlAtStartup === true) effective.remoteControlAtStartup = true;
    if (index > 0 && settings.remoteControlAtStartup === false) projectDisabled = true;
  }

  if (projectDisabled) effective.remoteControlAtStartup = false;

  return effective;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
