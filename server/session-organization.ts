import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventClient } from "./event-stream.js";
import { sendWs } from "./event-stream.js";
import type { NativeConversationReader } from "./native-conversation.js";
import type { SessionRecord } from "./types.js";

export class SessionOrganizationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 40070) { super(message); }
}

export interface SessionOrganizationPatch {
  pinned?: boolean;
  customTitle?: string;
  orderKey?: number;
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
  const fields = objectFields(value, ["pinned", "customTitle", "orderKey"]);
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
  if (Object.hasOwn(fields, "orderKey")) patch.orderKey = parseOrderKey(fields.orderKey);
  return patch;
}

function parseOrderKey(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SessionOrganizationError("orderKey 必须是有限数字");
  return value;
}

export function parseSessionMove(value: unknown): { cwd: string; orderKey?: number } {
  const fields = objectFields(value, ["cwd", "orderKey"]);
  const cwd = fields.cwd;
  if (typeof cwd !== "string" || cwd.length > 4096 || !cwd.startsWith("/") || cwd.includes("\0")) {
    throw new SessionOrganizationError("工作目录必须是 4096 字符以内的绝对路径");
  }
  return { cwd, ...(Object.hasOwn(fields, "orderKey") ? { orderKey: parseOrderKey(fields.orderKey) } : {}) };
}

/** Kimi 不理会 session/resume 的 cwd（实测静默留在旧目录），只有 state.json 决定工作目录；调用前 worker 必须已退出。 */
export function rebindKimiCwd(reader: NativeConversationReader, record: SessionRecord, cwd: string): void {
  const wire = reader.transcriptPath(record);
  if (!wire || !reader.hasArchive(record)) throw new SessionOrganizationError("无法核验 Kimi 原生会话，未移动");
  const path = join(dirname(dirname(dirname(wire))), "state.json");
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (typeof state.cwd !== "string") throw new SessionOrganizationError("无法核验 Kimi 原生会话，未移动");
  const temporary = `${path}.aireins-${randomUUID()}`;
  // wx 不跟随符号链接，也不沿用已有文件的权限。
  writeFileSync(temporary, JSON.stringify({ ...state, cwd }), { mode: statSync(path).mode & 0o777, flag: "wx" });
  try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
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
