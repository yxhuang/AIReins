import type { EventClient } from "./event-stream.js";
import { sendWs } from "./event-stream.js";
import type { SessionRecord } from "./types.js";

export class SessionOrganizationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 40070) { super(message); }
}

export interface SessionOrganizationPatch {
  pinned?: boolean;
  customTitle?: string;
}

function objectFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionOrganizationError("请求体必须是 JSON 对象");
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw new SessionOrganizationError(`未知字段：${key}`);
  }
  return fields;
}

export function parseOrganizationPatch(value: unknown): SessionOrganizationPatch {
  const fields = objectFields(value, ["pinned", "customTitle"]);
  const patch: SessionOrganizationPatch = {};
  if (Object.hasOwn(fields, "pinned")) {
    if (typeof fields.pinned !== "boolean") throw new SessionOrganizationError("pinned 必须是布尔值");
    patch.pinned = fields.pinned;
  }
  if (Object.hasOwn(fields, "customTitle")) {
    if (typeof fields.customTitle !== "string") throw new SessionOrganizationError("customTitle 必须是字符串");
    patch.customTitle = fields.customTitle.trim();
    if ([...patch.customTitle].length > 200) throw new SessionOrganizationError("customTitle 不得超过 200 字符");
  }
  return patch;
}

export function parseProjectMove(value: unknown): { path: string; before?: string; after?: string } {
  const fields = objectFields(value, ["path", "before", "after"]);
  if (Object.hasOwn(fields, "before") === Object.hasOwn(fields, "after")) {
    throw new SessionOrganizationError("before 与 after 必须且只能提供一个");
  }
  for (const key of ["path", Object.hasOwn(fields, "before") ? "before" : "after"]) {
    const path = fields[key];
    if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.includes("\0")) {
      throw new SessionOrganizationError("工作目录必须是 4096 字符以内的绝对路径");
    }
  }
  return fields as { path: string; before?: string; after?: string };
}

export interface SessionOrganizationFrame {
  type: "session_organization_updated";
  sessions: SessionRecord[];
  projectOrder: string[];
}

/** 组织信息属于列表控制帧，不能受会话订阅过滤，也不使用 transcript seq。 */
export function sendOrganizationUpdate(clients: Iterable<EventClient>, frame: SessionOrganizationFrame): void {
  for (const client of clients) sendWs(client, frame);
}
