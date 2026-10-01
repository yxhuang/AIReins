import type { AgentKind, Driver, DriverCapabilities, DriverOptions } from "../types.js";
import { CLAUDE_CONFIG_SCHEMA, ClaudeDriver, probeClaudeModelLabels } from "./claude.js";
import { CodexDriver, probeCodexConfigSchema } from "./codex.js";
import { KimiDriver, probeKimiConfigSchema } from "./kimi.js";

export const DRIVER_CAPABILITIES: Record<AgentKind, DriverCapabilities> = {
  claude: {
    usage: "detailed",
    interrupt: true,
    commands: true,
    mentions: true,
  },
  codex: {
    usage: "detailed",
    interrupt: true,
    commands: true,
    mentions: true,
  },
  kimi: {
    usage: "context",
    interrupt: true,
    commands: true,
    mentions: true,
  },
};

export function createDriver(agent: AgentKind, options: DriverOptions): Driver {
  if (agent === "claude") return new ClaudeDriver(options);
  if (agent === "codex") return new CodexDriver(options);
  return new KimiDriver(options);
}

export async function getDriverMetadata(cwd: string): Promise<Record<AgentKind, Record<string, unknown>>> {
  const [, codexSchema, kimiSchema] = await Promise.all([
    probeClaudeModelLabels(cwd).catch(() => undefined),
    probeSchema(() => probeCodexConfigSchema(cwd), "Codex app-server model/list and v2 protocol schema"),
    probeSchema(() => probeKimiConfigSchema(cwd), "Kimi ACP session/new.configOptions"),
  ]);
  return {
    claude: { ...DRIVER_CAPABILITIES.claude, ...CLAUDE_CONFIG_SCHEMA },
    codex: { ...DRIVER_CAPABILITIES.codex, ...codexSchema },
    kimi: { ...DRIVER_CAPABILITIES.kimi, ...kimiSchema },
  };
}

async function probeSchema(
  probe: () => Promise<{ options: unknown[]; source: string }>,
  source: string,
): Promise<Record<string, unknown>> {
  try {
    return await probe();
  } catch (error) {
    return {
      options: [],
      source,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
