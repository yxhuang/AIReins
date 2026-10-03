import type { EventClient } from "./event-stream.js";
import { sendWs } from "./event-stream.js";
import type { SessionGroup, SessionRecord } from "./types.js";

export class SessionOrganizationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 40070) { super(message); }
}

export interface SessionOrganizationPatch {
  pinned?: boolean;
  customTitle?: string;
  groupId?: string | null;
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
  const fields = objectFields(value, ["pinned", "customTitle", "groupId"]);
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
  if (Object.hasOwn(fields, "groupId")) {
    if (fields.groupId !== null && (typeof fields.groupId !== "string" || !fields.groupId)) {
      throw new SessionOrganizationError("groupId 必须是非空字符串或 null");
    }
    patch.groupId = fields.groupId as string | null;
  }
  return patch;
}

export function parseGroupName(value: unknown): string {
  const fields = objectFields(value, ["name"]);
  if (typeof fields.name !== "string") throw new SessionOrganizationError("name 必须是字符串");
  const name = fields.name.trim();
  if (!name || [...name].length > 200) throw new SessionOrganizationError("分组名称须为 1 到 200 字符");
  return name;
}

export interface SessionOrganizationFrame {
  type: "session_organization_updated";
  sessions: SessionRecord[];
  groups: SessionGroup[];
}

/** 组织信息属于列表控制帧，不能受会话订阅过滤，也不使用 transcript seq。 */
export function sendOrganizationUpdate(clients: Iterable<EventClient>, frame: SessionOrganizationFrame): void {
  for (const client of clients) sendWs(client, frame);
}
