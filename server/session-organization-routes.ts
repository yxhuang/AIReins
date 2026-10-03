import type { SessionManager } from "./session-manager.js";
import { SessionOrganizationError } from "./session-organization.js";

interface OrganizationResponse { status: number; data: Record<string, unknown> }

/** 由 index 的受访问控制 HTTP 分支调用，也可无端口验证实际接口契约。 */
export function organizationRoute(manager: SessionManager, method: string, pathname: string, body?: unknown): OrganizationResponse | undefined {
  if (pathname === "/api/session-groups") {
    if (method === "GET") return { status: 200, data: { groups: manager.listGroups() } };
    if (method === "POST") return { status: 201, data: { group: manager.createGroup(body) } };
    return undefined;
  }
  const groupMatch = pathname.match(/^\/api\/session-groups\/([^/]+)$/);
  if (groupMatch) {
    const id = decodeId(groupMatch[1]);
    if (method === "PATCH") return { status: 200, data: { group: manager.renameGroup(id, body) } };
    if (method === "DELETE") { manager.removeGroup(id); return { status: 200, data: { groups: manager.listGroups() } }; }
    return undefined;
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "PATCH" && sessionMatch) {
    return { status: 200, data: { session: manager.updateOrganization(decodeId(sessionMatch[1]), body) } };
  }
  return undefined;
}

function decodeId(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new SessionOrganizationError("无效的资源 id"); }
}
