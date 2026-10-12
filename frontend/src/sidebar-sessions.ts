import { t } from "./i18n";
import type { Store } from "./store";
import type { SessionRecord } from "./types";

/** 侧栏常规会话只显示最近 3 天；历史会话仍使用完整 sessions。 */
export const SIDEBAR_RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;

export function selectSidebarSessions(value: Pick<Store, "sessions" | "now" | "currentId" | "pendingCount">) {
  const waiting: SessionRecord[] = [];
  const active: SessionRecord[] = [];
  const cutoff = value.now - SIDEBAR_RECENT_WINDOW_MS;
  for (const session of value.sessions) {
    // 未决闸门先于状态/时间筛选；异常 dead 未决计数也绝不能被藏起来。
    if (value.pendingCount(session.id) > 0) {
      waiting.push(session);
    } else if (session.status !== "dead" && (
      session.status === "running" || session.status === "starting"
      || session.id === value.currentId || Date.parse(session.lastActivityAt) >= cutoff
    )) {
      active.push(session);
    }
  }
  const byActivity = (a: SessionRecord, b: SessionRecord) =>
    Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  return { waiting: waiting.sort(byActivity), active: active.sort(byActivity) };
}

export const SIDEBAR_WORKING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 分区只读取已有全局 now，置顶优先于分组，闸门优先于所有用户整理。 */
export function selectSidebarSections(value: Pick<Store, 'sessions' | 'now' | 'currentId' | 'pendingCount' | 'sessionGroups'>) {
  const { waiting, active } = selectSidebarSessions(value);
  const waitingIds = new Set(waiting.map(session => session.id));
  const byActivity = (a: SessionRecord, b: SessionRecord) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  const pinned = value.sessions.filter(session => !waitingIds.has(session.id) && session.pinned).sort(byActivity);
  const pinnedIds = new Set(pinned.map(session => session.id));
  const groups = (value.sessionGroups ?? []).map(group => ({ ...group, sessions: value.sessions.filter(session =>
    !waitingIds.has(session.id) && !pinnedIds.has(session.id) && session.groupId === group.id).sort(byActivity) }));
  const groupedIds = new Set(groups.flatMap(group => group.sessions.map(session => session.id)));
  const today = new Date(value.now);
  const buckets: { label: string; sessions: SessionRecord[] }[] = [
    { label: t("core.084"), sessions: [] }, { label: t("core.085"), sessions: [] }, { label: t("core.086"), sessions: [] },
  ];
  for (const session of active) {
    if (pinnedIds.has(session.id) || groupedIds.has(session.id)) continue;
    const activity = new Date(session.lastActivityAt);
    const working = session.status === 'running' || session.status === 'starting'
      || activity.getTime() >= value.now - SIDEBAR_WORKING_WINDOW_MS;
    const sameDay = activity.getFullYear() === today.getFullYear() && activity.getMonth() === today.getMonth() && activity.getDate() === today.getDate();
    buckets[working ? 0 : sameDay ? 1 : 2]!.sessions.push(session);
  }
  return { waiting, pinned, groups, sections: buckets.filter(section => section.sessions.length > 0) };
}

/** 空闲点只表示近期活动；后台工作、错误及未决闸门不受时间影响。 */
export function sidebarStatusDot(session: SessionRecord, pending: number, now: number): string | null {
  if (pending > 0) return 'needs-user';
  if (session.status === 'idle' && (session.backgroundTasks?.length ?? 0) > 0) return 'running';
  if (session.status === 'running' || session.status === 'starting' || session.status === 'error') return session.status;
  if (session.status === 'idle' && Date.parse(session.lastActivityAt) >= now - SIDEBAR_WORKING_WINDOW_MS) return 'idle';
  return null;
}
