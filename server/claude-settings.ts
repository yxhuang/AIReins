import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeEffectiveSettings {
  model: string | null;
  effort: string | null;
}

/** Resolve one Claude session's layered settings without launching Claude. */
export function readClaudeEffectiveSettings(
  cwd: string,
  userHome: string = homedir(),
): ClaudeEffectiveSettings {
  const effective: ClaudeEffectiveSettings = { model: null, effort: null };
  const paths = [
    join(userHome, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];

  for (const path of paths) {
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
  }

  return effective;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
