import type { CreateSessionInput, SessionConfig } from "./types.js";

export function cleanSessionConfig(config: SessionConfig = {}): SessionConfig {
  const cleaned: SessionConfig = {};
  if (typeof config.model === "string") cleaned.model = config.model.trim();
  if (typeof config.effort === "string") cleaned.effort = config.effort.trim();
  if (typeof config.permissionMode === "string") cleaned.permissionMode = config.permissionMode.trim();
  return cleaned;
}

export function configFromCreateInput(input: CreateSessionInput): SessionConfig {
  return cleanSessionConfig({
    model: input.config?.model ?? input.model,
    effort: input.config?.effort,
    permissionMode: input.config?.permissionMode
      ?? (input.agent === "kimi" ? input.kimiMode : undefined),
  });
}

export function mergeSessionConfig(current: SessionConfig, update: SessionConfig): SessionConfig {
  return cleanSessionConfig({ ...current, ...update });
}

export function isRiskyConfig(agent: CreateSessionInput["agent"], config: SessionConfig): boolean {
  const mode = config.permissionMode;
  if (agent === "claude") return mode === "bypassPermissions" || mode === "dontAsk";
  if (agent === "kimi") return mode === "yolo";
  return mode === "never";
}
