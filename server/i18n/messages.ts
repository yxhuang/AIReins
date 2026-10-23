import english from "../../frontend/src/i18n/server.en.js";
import { PRODUCT_NAME } from "../../shared/product-name.js";
import messages from "../../frontend/src/i18n/server.zh-CN.js";

export interface MessageDescriptor {
  key: string;
  params?: Record<string, string>;
  localizedParams?: Record<string, MessageDescriptor>;
}
export type MessageMetadata = Record<string, MessageDescriptor | (MessageDescriptor | null)[]>;

const nestedParameterNames: Record<string, string[]> = {
  "server.self_update.push_failed": ["p0"],
  "server.message000": [
    "p0",
    "p1"
  ],
  "server.message007": [
    "p0"
  ],
  "server.message017": [
    "p1"
  ],
  "server.message067": [
    "p0"
  ],
  "server.message068": [
    "p0"
  ],
  "server.message079": [
    "p0"
  ],
  "server.message085": [
    "p0"
  ],
  "server.message090": [
    "p0"
  ],
  "server.message098": [
    "p0"
  ],
  "server.message125": [
    "p0"
  ],
  "server.message134": [
    "p1"
  ],
  "server.message146": [
    "p1"
  ],
  "server.message175": [
    "p0"
  ],
  "server.message177": [
    "p0"
  ],
  "server.message191": [
    "p0"
  ],
  "server.message167": [
    "p0"
  ],
  "server.message214": [
    "p1"
  ],
  "server.message224": [
    "p0"
  ],
  "server.message270": [
    "p0"
  ],
  "server.message271": [
    "p0"
  ],
  "server.message281": [
    "p0"
  ],
  "server.message320": [
    "p0"
  ],
  "server.message423": [
    "p0"
  ],
  "server.message426": [
    "p0"
  ],
  "server.message439": [
    "p0"
  ],
  "server.message440": [
    "p1"
  ],
  "server.message491": [
    "p0"
  ]
};

const exact = new Map(Object.entries(messages).filter(([, text]) => !/\{(?:p\d+|product)\}/.test(text)).map(([key, text]) => [text, key]));
// ponytail: linear lookup over registered templates; emit descriptors at the source if profiling shows this is costly.
const patterns = Object.entries(messages)
  .filter(([, text]) => /\{(?:p\d+|product)\}/.test(text))
  .sort((a, b) => b[1].replace(/\{p\d+\}/g, "").length - a[1].replace(/\{p\d+\}/g, "").length)
  .map(([key, text]) => {
    const names = [...text.matchAll(/\{(p\d+)\}/g)].map(match => match[1]);
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{p\d+\\\}/g, "([\\s\\S]*?)");
    return { key, names, pattern: new RegExp(`^${escaped.replace(/\\\{product\\\}/g, "(?:AIReins|Workbench|workbench|工作台|WB)")}$`) };
  });

/** Match only registered AIReins templates; unknown CLI errors remain verbatim. */
export function describeServerMessage(message: string, depth = 0): MessageDescriptor | undefined {
  const key = exact.get(message);
  if (key) return { key };
  for (const entry of patterns) {
    const match = entry.pattern.exec(message);
    if (!match) continue;
    const params: Record<string, string> = {};
    const localizedParams: Record<string, MessageDescriptor> = {};
    entry.names.forEach((name, index) => {
      const text = match[index + 1];
      params[name] = text;
      // Translate nested errors and server-generated enum labels, preserving paths and user text.
      const nested = depth < 4 && nestedParameterNames[entry.key]?.includes(name)
        ? describeServerMessage(text, depth + 1) : undefined;
      if (nested) localizedParams[name] = nested;
    });
    return { key: entry.key, params, ...(Object.keys(localizedParams).length ? { localizedParams } : {}) };
  }
  return undefined;
}

const protectedEvents = new Set([
  "user_message", "agent_text_delta", "thought_delta", "external_messages_added",
  "tool_call_started", "tool_call_updated", "tool_call_completed",
]);
const protectedFields = new Set([
  "text", "content", "input", "output", "arguments", "updatedInput", "questionAnswers",
  "questions", "answers", "raw", "response", "history", "backgroundTasks", "tasks",
]);
const messageFields = new Set(["msg", "message", "reason", "warning", "error", "configSwitching", "activity", "embedReason"]);

/** Add wire-only metadata, including replay/snapshot events, without rewriting persisted data. */
export function withMessageMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withMessageMetadata);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (typeof source.role === "string" || protectedEvents.has(String(source.type))) return value;
  const result: Record<string, unknown> = {};
  const metadata: MessageMetadata = { ...(source.i18n as MessageMetadata | undefined) };
  for (const [field, child] of Object.entries(source)) {
    if (field === "i18n") continue;
    const schemaField = (field === "label" && ["userSettings", "projectSettings", "localSettings"].includes(String(source.source)))
      || (field === "name" && ["model", "effort", "permissionMode"].includes(String(source.id)))
      || (["label", "description"].includes(field) && Object.hasOwn(source, "value"))
      || (["description", "argHint"].includes(field) && ["claude", "codex", "kimi"].includes(String(source.source)) && typeof source.name === "string");
    if (typeof child === "string" && (messageFields.has(field) || schemaField)) {
      const descriptor = describeServerMessage(child);
      if (descriptor) metadata[field] = descriptor;
    } else if (field === "protocolLimitations" && Array.isArray(child)) {
      const descriptors = child.map(text => typeof text === "string" ? describeServerMessage(text) ?? null : null);
      if (descriptors.some(Boolean)) metadata[field] = descriptors;
    }
    result[field] = protectedFields.has(field) ? child : withMessageMetadata(child);
  }
  if (Object.keys(metadata).length) result.i18n = metadata;
  return result;
}

/** Mark only generated fallback titles, never a user title that happens to use the same words. */
export function fallbackTitleMetadata(session: { customTitle?: string; nativeTitle?: string }, title: string | undefined, key = "server.message316"): { i18n?: MessageMetadata } {
  return title === undefined && !session.customTitle?.trim() && !session.nativeTitle?.trim()
    ? { i18n: { title: { key } } } : {};
}

/** Byte URLs are loaded directly by image/PDF viewers, without the frontend JSON decoder. */
export function localizeContentError(envelope: Record<string, unknown>, locale: string | undefined): Record<string, unknown> {
  if (locale !== "en" || typeof envelope.msg !== "string") return envelope;
  const descriptor = (envelope.i18n as MessageMetadata | undefined)?.msg;
  if (!descriptor || Array.isArray(descriptor)) return envelope;
  return { ...envelope, msg: renderEnglishMessage(descriptor, envelope.msg) };
}

function renderEnglishMessage(descriptor: MessageDescriptor, fallback: string): string {
  const template = english[descriptor.key];
  if (!template) return fallback;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (name === "product") return PRODUCT_NAME;
    const value = descriptor.params?.[name];
    if (value === undefined) return placeholder;
    const nested = descriptor.localizedParams?.[name];
    return nested ? renderEnglishMessage(nested, value) : value;
  });
}
