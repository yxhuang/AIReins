import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const AGENTS = ["claude", "codex", "kimi"] as const;
export type AgentKind = (typeof AGENTS)[number];

export const EVENT_TYPES = [
  "session_created",
  "config_update_started",
  "user_message",
  "agent_text_delta",
  "thought_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "permission_request",
  "permission_resolved",
  "commands_updated",
  "config_updated",
  "usage_updated",
  "turn_completed",
  "session_error",
  "process_exited",
  "raw_event",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export type PermissionDecision = "allow" | "deny" | "always";
export type QuestionAnswers = Record<string, string>;

export const CONFIG_OPTION_IDS = ["model", "effort", "permissionMode"] as const;
export type ConfigOptionId = (typeof CONFIG_OPTION_IDS)[number];

export interface SessionConfig {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
}

export type EffectiveConfigSource = "session" | "settings" | "init";

export interface EffectiveConfigValue {
  value: string | null;
  source: EffectiveConfigSource | null;
}

export interface EffectiveConfigUpdate {
  model?: EffectiveConfigValue;
  effort?: EffectiveConfigValue;
}

export interface ConfigOptionValue {
  value: string | null;
  label: string;
  description?: string;
}

export interface DriverConfigOption {
  id: ConfigOptionId;
  name: string;
  values: ConfigOptionValue[];
  default: string | null;
  mutable: boolean;
  mutableVia?: "restart";
}

export interface DriverConfigSchema {
  options: DriverConfigOption[];
  source: string;
}

export interface UnifiedCommand {
  name: string;
  description: string;
  argHint?: string;
  source: AgentKind;
}

export interface FileMention {
  type: "file";
  path: string;
  name?: string;
}

export interface CommandInvocation {
  name: string;
  arguments?: string;
}

export interface UserMessageInput {
  text?: string;
  command?: CommandInvocation;
  mentions?: FileMention[];
}

export interface UnifiedEvent {
  type: EventType;
  sessionId: string;
  agentId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  agent: AgentKind;
  agentId: string;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  seq: number;
  transcriptPath: string;
  nativeSessionId?: string;
  nativeTranscriptPath?: string;
  snapshotPath?: string;
  resumedFrom?: {
    agent: AgentKind;
    nativeSessionId: string;
    messageCount?: number;
  };
  processId?: number;
  model?: string | null;
  effort?: string | null;
  effectiveModel?: string | null;
  effectiveEffort?: string | null;
  effectiveModelSource?: EffectiveConfigSource | null;
  effectiveEffortSource?: EffectiveConfigSource | null;
  permissionMode?: string | null;
  config: SessionConfig;
  riskyMode: boolean;
}

export interface DriverCapabilities {
  streaming: boolean;
  thoughts: boolean;
  toolCalls: boolean;
  permissions: boolean;
  permissionSuggestions: boolean;
  updatedInput: boolean;
  usage: "detailed" | "context" | false;
  interrupt: boolean;
  resume: boolean;
  commands: boolean;
  mentions: boolean;
  terminal?: boolean;
  fsWrite?: boolean;
  finalApprovalGates?: string[];
}

export interface DriverCallbacks {
  emit(type: EventType, payload?: Record<string, unknown>): UnifiedEvent | undefined;
  metadata(metadata: {
    nativeSessionId?: string;
    nativeTranscriptPath?: string;
    config?: SessionConfig;
    effectiveConfig?: EffectiveConfigUpdate;
  }): void;
  commands(commands: UnifiedCommand[]): void;
  status(status: SessionStatus): void;
  exited(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
}

export interface DriverOptions {
  sessionId: string;
  cwd: string;
  config: SessionConfig;
  resumeSessionId?: string;
  callbacks: DriverCallbacks;
}

export interface Driver {
  readonly kind: AgentKind;
  readonly child?: ChildProcessWithoutNullStreams;
  start(): Promise<void>;
  getConfigSchema(): DriverConfigSchema;
  setConfig(config: SessionConfig): Promise<SessionConfig>;
  sendUserMessage(message: UserMessageInput): Promise<void>;
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
    questionAnswers?: QuestionAnswers,
  ): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSessionInput {
  agent: AgentKind;
  cwd: string;
  snapshot?: "auto" | "skip";
  agentId?: string;
  config?: SessionConfig;
  /** @deprecated Use config.model. */
  model?: string;
  resumeSessionId?: string;
  /** @deprecated Use config.permissionMode. */
  kimiMode?: "default" | "plan" | "auto" | "yolo";
  initialMessage?: string;
}
