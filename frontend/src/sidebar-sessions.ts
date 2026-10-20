import { sessionTitle } from "./format";
import { normalizeProjectPath } from "../../shared/project-path";
import type { Store } from "./store";
import type { SessionRecord } from "./types";

// 同一摘要对象只解析一次；seq 原地推进不影响活动时间。
const activityTimes = new WeakMap<SessionRecord, number>();
function activityTime(session: SessionRecord): number {
  let time = activityTimes.get(session);
  if (time === undefined) {
    time = Date.parse(session.lastActivityAt);
    activityTimes.set(session, time);
  }
  return time;
}
const byActivity = (a: SessionRecord, b: SessionRecord) => activityTime(b) - activityTime(a);

/** 侧栏活跃目录候选取最近 3 天；较早目录另从完整 sessions 中选取。 */
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
      || session.id === value.currentId || activityTime(session) >= cutoff
    )) {
      active.push(session);
    }
  }
  return { waiting: waiting.sort(byActivity), active: active.sort(byActivity) };
}

export const SIDEBAR_WORKING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** 路径身份始终为 POSIX；盘符转换只用于具备 Windows 路径能力的主机。 */
export function projectDisplayPath(path: string, windowsPaths = false): string {
  return windowsPaths ? path.replace(/^\/mnt\/([a-z])(?:\/|$)/i, (_, drive: string) => `${drive.toUpperCase()}:/`) : path;
}

type SidebarValue = Pick<Store, "sessions" | "now" | "currentId" | "pendingCount" | "projectOrder">
  & Partial<Pick<Store, "meta" | "data">>;

/** 活跃目录只取 active；其余非 dead 会话归较早目录，等待/置顶始终独占。 */
export function selectSidebarSections(value: SidebarValue, query = "") {
  const { waiting, active } = selectSidebarSessions(value);
  const waitingIds = new Set(waiting.map(session => session.id));
  const pinned = value.sessions.filter(session => !waitingIds.has(session.id) && session.pinned).sort(byActivity);
  const pinnedIds = new Set(pinned.map(session => session.id));
  const directories = new Map<string, SessionRecord[]>();
  for (const session of active) {
    if (pinnedIds.has(session.id)) continue;
    const path = normalizeProjectPath(session.worktree?.root ?? session.cwd);
    const sessions = directories.get(path) ?? [];
    sessions.push(session);
    directories.set(path, sessions);
  }
  const order = [...new Set((value.projectOrder ?? []).map(normalizeProjectPath))];
  const known = new Set(order);
  const activePaths = [...directories.keys()].filter(path => !known.has(path))
    .concat(order.filter(path => directories.has(path)));
  const olderDirectories = new Map<string, SessionRecord[]>();
  for (const session of [...value.sessions].sort(byActivity)) {
    if (session.status === "dead" || waitingIds.has(session.id) || pinnedIds.has(session.id)) continue;
    const path = normalizeProjectPath(session.worktree?.root ?? session.cwd);
    // 活跃目录仍只显示 active 候选，不把超窗会话混回或再建同路径的较早组。
    if (directories.has(path)) continue;
    const sessions = olderDirectories.get(path) ?? [];
    sessions.push(session);
    olderDirectories.set(path, sessions);
  }
  const paths = [...activePaths, ...olderDirectories.keys()];
  const windowsPaths = value.meta?.capabilities?.windowsPaths === true;
  const home = value.meta?.homeDir ? normalizeProjectPath(value.meta.homeDir) : undefined;
  const parts = paths.map(path => projectDisplayPath(path, windowsPaths).split("/").filter(Boolean));
  const names = paths.map((path, i) => path === home ? "~" : parts[i]!.at(-1) || "/");
  // ponytail: 同名消歧逐项比较；目录很多且变慢时再按末级名建索引。
  const allProjects = paths.map((path, i) => {
    const peers = paths.map((_, j) => j).filter(j => j !== i && names[j] === names[i]);
    let label = names[i]!;
    if (peers.length) {
      const parents = parts[i]!.slice(0, -1);
      let depth = 1;
      const suffix = (j: number) => {
        const parent = parts[j]!.slice(0, -1);
        return `${depth > parent.length ? "/" : ""}${parent.slice(-depth).join("/")}` || "/";
      };
      while (depth <= parents.length && peers.some(j => suffix(j) === suffix(i))) depth++;
      label += ` · ${suffix(i)}`;
    }
    return { path, label, sessions: (directories.get(path) ?? olderDirectories.get(path))! };
  });
  const projects = allProjects.slice(0, activePaths.length);
  const olderProjects = allProjects.slice(activePaths.length);
  const search = query.trim().toLowerCase();
  if (!search) return { waiting, pinned, projects, olderProjects };
  const matches = (session: SessionRecord) => [
    sessionTitle(session, value.data?.get(session.id)?.events), session.cwd, projectDisplayPath(session.cwd, windowsPaths),
    projectDisplayPath(session.worktree?.root ?? "", windowsPaths), session.worktree?.root ?? "", session.worktree?.branch ?? "",
  ].some(text => text.toLowerCase().includes(search));
  const matchingProjects = (items: typeof projects) => items.map(project => ({
    ...project, sessions: project.sessions.filter(matches),
  })).filter(project => project.sessions.length > 0);
  return { waiting, pinned: pinned.filter(matches), projects: matchingProjects(projects), olderProjects: matchingProjects(olderProjects) };
}

/** 普通会话限前 8 个；工作中/待处理/当前会话豁免，搜索或手动展开时全取。 */
export function selectProjectSessions(sessions: SessionRecord[], options: Pick<Store, "now" | "currentId" | "pendingCount"> & {
  expanded: boolean; searching: boolean;
}): { sessions: SessionRecord[]; hiddenCount: number } {
  const sorted = [...sessions].sort(byActivity);
  if (options.expanded || options.searching) return { sessions: sorted, hiddenCount: 0 };
  let ordinaryCount = 0;
  const visible = sorted.filter(session => session.id === options.currentId || (session.backgroundTasks?.length ?? 0) > 0
    || ["running", "starting", "needs-user"].includes(sidebarStatusDot(session, options.pendingCount(session.id), options.now) ?? "")
    || ordinaryCount++ < 8);
  return { sessions: visible, hiddenCount: sorted.length - visible.length };
}

/** 空闲点只表示近期活动；后台工作、错误及未决闸门不受时间影响。 */
export function sidebarStatusDot(session: SessionRecord, pending: number, now: number): string | null {
  if (pending > 0) return 'needs-user';
  if (session.status === 'idle' && (session.backgroundTasks?.length ?? 0) > 0) return 'running';
  if (session.status === 'running' || session.status === 'starting' || session.status === 'error') return session.status;
  if (session.status === 'idle' && activityTime(session) >= now - SIDEBAR_WORKING_WINDOW_MS) return 'idle';
  return null;
}
