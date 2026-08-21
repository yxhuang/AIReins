import type { AgentKind, Driver, DriverCapabilities, DriverOptions } from "../types.js";
import { CLAUDE_CONFIG_SCHEMA, ClaudeDriver } from "./claude.js";
import { CodexDriver, probeCodexConfigSchema } from "./codex.js";
import { KimiDriver, probeKimiConfigSchema } from "./kimi.js";

export const DRIVER_CAPABILITIES: Record<AgentKind, DriverCapabilities> = {
  claude: {
    streaming: true,
    thoughts: true,
    toolCalls: true,
    permissions: true,
    permissionSuggestions: true,
    updatedInput: true,
    usage: "detailed",
    interrupt: true,
    resume: true,
  },
  codex: {
    streaming: true,
    thoughts: true,
    toolCalls: true,
    permissions: true,
    permissionSuggestions: true,
    updatedInput: false,
    usage: "detailed",
    interrupt: true,
    resume: true,
  },
  kimi: {
    streaming: true,
    thoughts: true,
    toolCalls: true,
    permissions: true,
    permissionSuggestions: true,
    updatedInput: true,
    usage: "context",
    interrupt: true,
    resume: true,
    terminal: true,
    fsWrite: true,
    finalApprovalGates: ["terminal/create", "fs/write_text_file"],
  },
};

export function createDriver(agent: AgentKind, options: DriverOptions): Driver {
  if (agent === "claude") return new ClaudeDriver(options);
  if (agent === "codex") return new CodexDriver(options);
  return new KimiDriver(options);
}

export async function getDriverMetadata(cwd: string): Promise<Record<AgentKind, Record<string, unknown>>> {
  const [codexSchema, kimiSchema] = await Promise.all([
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
