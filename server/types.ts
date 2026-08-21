import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const AGENTS = ["claude", "codex", "kimi"] as const;
export type AgentKind = (typeof AGENTS)[number];

export const EVENT_TYPES = [
  "session_created",
  "user_message",
  "agent_text_delta",
  "thought_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "permission_request",
  "permission_resolved",
  "usage_updated",
  "turn_completed",
  "session_error",
  "process_exited",
  "raw_event",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type SessionStatus = "starting" | "idle" | "running" | "dead" | "error";
export type PermissionDecision = "allow" | "deny" | "always";

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
  processId?: number;
  model?: string;
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
  terminal?: boolean;
  fsWrite?: boolean;
  finalApprovalGates?: string[];
}

export interface DriverCallbacks {
  emit(type: EventType, payload?: Record<string, unknown>): UnifiedEvent | undefined;
  metadata(metadata: { nativeSessionId?: string; nativeTranscriptPath?: string }): void;
  status(status: SessionStatus): void;
  exited(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
}

export interface DriverOptions {
  sessionId: string;
  cwd: string;
  model?: string;
  resumeSessionId?: string;
  kimiMode?: "default" | "plan" | "auto" | "yolo";
  callbacks: DriverCallbacks;
}

export interface Driver {
  readonly kind: AgentKind;
  readonly child?: ChildProcessWithoutNullStreams;
  start(): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: unknown,
  ): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateSessionInput {
  agent: AgentKind;
  cwd: string;
  agentId?: string;
  model?: string;
  resumeSessionId?: string;
  kimiMode?: "default" | "plan" | "auto" | "yolo";
  initialMessage?: string;
}
