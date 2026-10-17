import type { SessionManager } from "./session-manager.js";
import { SessionOrganizationError } from "./session-organization.js";

interface OrganizationResponse { status: number; data: Record<string, unknown> }

/** 由 index 的受访问控制 HTTP 分支调用，也可无端口验证实际接口契约。 */
export function organizationRoute(manager: SessionManager, method: string, pathname: string, body?: unknown): OrganizationResponse | undefined {
  if (method === "GET" && pathname === "/api/project-order") {
    return { status: 200, data: { paths: manager.listProjectOrder() } };
  }
  if (method === "POST" && pathname === "/api/project-order/move") {
    return { status: 200, data: { paths: manager.moveProject(body) } };
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
