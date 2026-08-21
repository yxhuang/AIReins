import type { AgentKind, Driver, DriverCapabilities, DriverOptions } from "../types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { KimiDriver } from "./kimi.js";

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
