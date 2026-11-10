import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeEffectiveSettings {
  model: string | null;
  effort: string | null;
  remoteControlAtStartup?: boolean;
}

export interface ClaudeDefaultSettings {
  model: string | null;
  effort: string | null;
  /** 新建表单选了别的模型时，按 modelSettings 解析出的跟随值。 */
  effortByModel: Record<string, string | null>;
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

// CLI initialize 报告的别名 → 完整模型 ID（"default" 即未指定模型时的解析结果）；modelSettings 按完整 ID 记。
let claudeModelIds: Record<string, string> = {};

export function setClaudeModelIds(models: unknown): void {
  if (!Array.isArray(models)) return;
  const ids: Record<string, string> = {};
  for (const item of models) {
    if (item && typeof item === "object" && typeof item.value === "string" && typeof item.resolvedModel === "string") {
      ids[item.value] = item.resolvedModel;
    }
  }
  claudeModelIds = ids;
}

/** 单层设置对某模型的 effort：modelSettings[模型].effortLevel 优先于同层 effortLevel（与 CLI get_settings.applied 一致）。 */
function layerEffort(settings: Record<string, unknown>, model: string | null): string | null {
  const perModel = settings.modelSettings;
  if (perModel && typeof perModel === "object" && !Array.isArray(perModel)) {
    for (const key of [model, claudeModelIds[model ?? "default"]]) {
      if (!key) continue;
      const entry = (perModel as Record<string, unknown>)[key];
      const effort = entry && typeof entry === "object" ? nonEmptyString((entry as Record<string, unknown>).effortLevel) : null;
      if (effort !== null) return effort;
    }
  }
  return nonEmptyString(settings.effortLevel);
}

/** 新建页只读用户级默认值；坏配置不阻塞 meta，也不返回其他设置。 */
export function readClaudeDefaultSettings(userHome = homedir()): ClaudeDefaultSettings {
  try {
    const settings = readUserSettings(userHome);
    const model = nonEmptyString(settings.model);
    const effortByModel: Record<string, string | null> = {};
    for (const alias of Object.keys(claudeModelIds)) effortByModel[alias] = layerEffort(settings, alias);
    return { model, effort: layerEffort(settings, model), effortByModel };
  } catch {
    return { model: null, effort: null, effortByModel: {} };
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
  modelOverride?: string | null,
): ClaudeEffectiveSettings {
  const effective: ClaudeEffectiveSettings = { model: null, effort: null, remoteControlAtStartup: false };
  const paths = [
    join(userHome, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];

  let projectDisabled = false;
  const layers: Record<string, unknown>[] = [];
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

    layers.push(settings);
    const model = nonEmptyString(settings.model);
    if (model !== null) effective.model = model;
    if (index === 0 && settings.remoteControlAtStartup === true) effective.remoteControlAtStartup = true;
    if (index > 0 && settings.remoteControlAtStartup === false) projectDisabled = true;
  }

  if (projectDisabled) effective.remoteControlAtStartup = false;
  // 后层覆盖前层；每层先看所用模型的 modelSettings。
  const model = modelOverride || effective.model;
  for (const settings of layers) effective.effort = layerEffort(settings, model) ?? effective.effort;

  return effective;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
