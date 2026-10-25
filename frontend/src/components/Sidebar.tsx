import { t } from "../i18n";
import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { AgentKind, SessionRecord } from "../types";
import { relativeTime, relativeTimeShort, sessionTitle } from "../format";
import { AgentIcon } from "./AgentIcon";
import { isInlineSvg } from "../pages";
import { store, type Store } from "../store";
import { projectDisplayPath, selectSidebarSections, selectProjectSessions, sidebarStatusDot } from "../sidebar-sessions";
import { lockSidebarSwipe, normalizeSidebarTitle, sidebarSwipeOffset } from "../sidebar-menu";
import { SidebarActionMenu, type SidebarMenuItem } from "./SidebarActionMenu";
import { useStore } from "../useStore";
import { LauncherMenu } from "./LauncherMenu";
import { SettingsMenu } from "./SettingsMenu";
import { HostSwitcher } from "./HostSwitcher";
import { HistoryView } from "./HistoryView";
import { PageView } from "./PageView";
import { isUpcomingReset } from "./CodexResets";
import { SidebarResize } from "./SidebarResize";
import { shortSessionTitle, SidebarSessionTitle } from "./SessionTitle";
import { PermanentDeleteConfirm } from "./PermanentDeleteConfirm";

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
};

const STATUS_LABELS: Record<string, string> = {
  starting: t("ui.Sidebar.starting"),
  idle: t("ui.common.idle"),
  running: t("ui.Sidebar.busy"),
  dead: t("ui.Sidebar.ended"),
  error: t("ui.Sidebar.error"),
};

/** 五状态一句「你现在可以……」说明：左栏状态文字的 hover title 用。 */
const STATUS_HINTS: Record<string, string> = {
  starting: t("ui.Sidebar.starting_the_agent_process_is_launching_wait"),
  idle: t("ui.Sidebar.idle_the_agent_is_ready_send_a"),
  running: t("ui.Sidebar.busy_the_agent_is_executing_send_another"),
  error: t("ui.Sidebar.error_the_session_encountered_an_error_read"),
  dead: t("ui.Sidebar.ended_the_process_has_exited_create_a"),
};

const selectSessions = (value: Store) => value.sessions;
const selectNow = (value: Store) => value.now;
const selectMeta = (value: Store) => value.meta;
const selectHistoryOpen = (value: Store) => value.historyOpen;
const selectHistoryNewCwd = (value: Store) => value.historyOpen ? value.historyCwdFilter : "";
const selectCurrentId = (value: Store) => value.currentId;
const selectPendingSignature = (value: Store) =>
  value.sessions.map((session) => `${session.id}:${value.pendingCountFor(session)}`).join("|");

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  returnToSession?: boolean;
  /** 手机列表页并进顶栏同一行的面板开关（文件/终端/派单）；桌面由 CSS 隐藏 */
  mobileActions?: ReactNode;
}

export function Sidebar({ collapsed, onToggle, returnToSession = false, mobileActions }: SidebarProps) {
  const sessionRecords = useStore(selectSessions);
  const projectOrder = useStore((value) => value.projectOrder);
  const meta = useStore(selectMeta);
  const [projectFolds, setProjectFold] = usePersistedProjectFolds();
  const [olderProjectsOpen, setOlderProjectsOpen] = useState(() => {
    try { return localStorage.getItem("aireins-older-projects-open") === "1"; } catch { return false; }
  });
  const [expandedProjects, setExpandedProjects] = useState(() => new Set<string>());
  const toggleOlderProjects = (open: boolean) => {
    setOlderProjectsOpen(open);
    try { localStorage.setItem("aireins-older-projects-open", open ? "1" : "0"); } catch { /* 私密模式保留内存态 */ }
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [previewPaths, setPreviewPaths] = useState<string[] | null>(null);
  const draggedPath = useRef<string | null>(null);
  const dropBeforePath = useRef<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [canDrag, setCanDrag] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 721px)");
    const update = () => setCanDrag(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const now = useStore(selectNow);
  const currentId = useStore(selectCurrentId);
  const panelOpen = useStore((value) => value.historyOpen || value.currentPageId !== null);
  const historyOpen = useStore(selectHistoryOpen);
  const currentPageId = useStore((value) => value.currentPageId);
  const pages = useStore((value) => value.pages);
  const currentPage = pages.find((page) => page.id === currentPageId);
  const pageOpen = useStore((value) => value.currentPageId !== null);
  const sidebarRef = useRef<HTMLElement>(null);
  const closePanel = useCallback(() => {
    const trigger = sidebarRef.current?.querySelector<HTMLButtonElement>('.sidebar-panel-open .page-nav-item');
    store.closeSidebarPanel(window.matchMedia("(max-width: 720px)").matches && !returnToSession);
    trigger?.focus();
  }, [returnToSession]);
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen, closePanel]);
  const preparePanel = () => {
    if (collapsed) onToggle();
  };
  // pendingGates 是可变 Map；用可比较的原始字符串捕获“总数相同但分布换了会话”的变化。
  useStore(selectPendingSignature);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  // 历史目录与组标题 + 都使用同一主页入口。
  const historyCwd = useStore(selectHistoryNewCwd);
  const newSessionIn = (cwd?: string) => store.navigateNew(cwd);
  useEffect(() => {
    if (!swipedId) return;
    const close = (event: Event) => {
      const target = event.target;
      if ((event.type === "pointerdown" || event.type === "touchstart") && target instanceof Element
        && target.closest(".session-swipe-open")) return;
      setSwipedId(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("touchstart", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("touchstart", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [swipedId]);
  // 复用 selectNow 订阅的全局时钟，时间越界也刷新；只筛侧栏，不裁剪完整 sessions。
  // 当前打开的旧非 dead 会话临时留在主列表，切走后恢复 72 小时规则。
  const { waiting, pinned, projects: selectedProjects, olderProjects } = selectSidebarSections({ ...store, sessions: sessionRecords, projectOrder, now, currentId, pendingCount: store.pendingCount.bind(store) }, query);
  const projects = previewPaths ? [...selectedProjects].sort((a, b) => previewPaths.indexOf(a.path) - previewPaths.indexOf(b.path)) : selectedProjects;
  const searching = query.trim().length > 0;
  const dropProject = async (before: string) => {
    const path = draggedPath.current;
    if (!path || path === before) return;
    draggedPath.current = null;
    dropBeforePath.current = null;
    try { await store.moveProject(path, { before }); }
    catch (error) { setOrderError(error instanceof Error ? error.message : String(error)); }
    finally { setPreviewPaths(null); }
  };
  const totalSessions = sessionRecords.length;
  // 收起态仍要能看到全局待审批压力：全部会话未决闸门总数。
  const totalPending = sessionRecords.reduce(
    (sum, session) => sum + store.pendingCountFor(session),
    0,
  );

  const renderRow = (session: SessionRecord) => (
    <li key={session.id}>
      <SessionRow
        session={session}
        pending={store.pendingCountFor(session)}
        active={session.id === currentId}
        now={now}
        windowsPaths={meta?.capabilities.windowsPaths === true}
        swipeOpen={swipedId === session.id}
        onSwipeChange={setSwipedId}
      />
    </li>
  );

  const renderProject = (project: typeof projects[number], index: number, sortable = true) => {
    const working = project.sessions.some(session => session.id === currentId
      || ["running", "starting", "needs-user"].includes(sidebarStatusDot(session, store.pendingCountFor(session), now) ?? ""));
    const folded = !searching && (projectFolds[project.path] ? projectFolds[project.path] === "closed" : !working);
    const expanded = expandedProjects.has(project.path);
    const visible = selectProjectSessions(project.sessions, { now, currentId, pendingCount: store.pendingCount.bind(store), expanded, searching });
    return <li key={project.path} className="sidebar-project" data-project-path={project.path}
      onDragOver={sortable ? (event) => {
        const path = draggedPath.current;
        if (!path) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
        if (path === project.path) return;
        dropBeforePath.current = project.path;
        setPreviewPaths(previous => {
          const next = (previous ?? projects.map(item => item.path)).filter(item => item !== path);
          next.splice(next.indexOf(project.path), 0, path);
          return next;
        });
      } : undefined}
      onDrop={sortable ? (event) => { event.preventDefault(); if (dropBeforePath.current) void dropProject(dropBeforePath.current); } : undefined}>
      <ProjectHeader project={project} collapsed={folded} now={now}
        windowsPaths={meta?.capabilities.windowsPaths === true}
        previous={sortable ? projects[index - 1]?.path : undefined} next={sortable ? projects[index + 1]?.path : undefined}
        onToggle={() => setProjectFold(project.path, folded ? "open" : "closed")} onNew={() => newSessionIn(project.path)}
        sortable={sortable} draggable={sortable && canDrag}
        onDragStart={(event) => {
          draggedPath.current = project.path; dropBeforePath.current = null; setOrderError(null);
          event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", project.path);
        }}
        onDragEnd={() => { if (draggedPath.current) { draggedPath.current = null; dropBeforePath.current = null; setPreviewPaths(null); } }} />
      {!folded && <ul className="session-list project-session-list" id={`project-${encodeURIComponent(project.path)}`}>{visible.sessions.map(renderRow)}
        {!searching && (visible.hiddenCount > 0 || expanded) && <li>
          <button type="button" className="project-show-more" aria-expanded={expanded} onClick={() => setExpandedProjects(previous => {
            const next = new Set(previous);
            if (expanded) next.delete(project.path); else next.add(project.path);
            return next;
          })}>{expanded ? t("ui.common.collapse") : t("ui.Sidebar.show_more_sessions", { count: visible.hiddenCount })}</button>
        </li>}
      </ul>}
    </li>;
  };

  return (
    <aside className={`sidebar${pageOpen && !collapsed ? " sidebar-page-open" : ""}${searchOpen && !collapsed ? " sidebar-search-open" : ""}`} ref={sidebarRef}>
      <div className="sidebar-head">
        <HostSwitcher />
        {/* Chrome --app 窗口和主屏幕 PWA 没有地址栏和刷新键 */}
        <button
          type="button"
          className="icon-btn chrome-icon-btn sidebar-reload"
          title={t("ui.Sidebar.refresh_page")}
          aria-label={t("ui.Sidebar.refresh_page")}
          onClick={() => location.reload()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 12a8 8 0 0 0-2-5" /></svg>
        </button>
        {collapsed && totalPending > 0 && (
          <button
            type="button"
            className="gate-badge gate-badge-btn"
            title={t("ui.Sidebar.approvals_pending_click_to_expand_the_session", { p0: (totalPending) })}
            onClick={onToggle}
          >
            {totalPending}
          </button>
        )}
        <button
          type="button"
          className="icon-btn chrome-icon-btn sidebar-toggle"
          title={collapsed ? t("ui.Sidebar.expand_session_list") : t("ui.Sidebar.collapse_session_list")}
          onClick={onToggle}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{collapsed ? <path d="m5 7 5 5-5 5m8-10 5 5-5 5" /> : <path d="m11 7-5 5 5 5m8-10-5 5 5 5" />}</svg>
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="sidebar-new-row">
            {searchOpen ? <input
              ref={searchRef}
              className="sidebar-search-input"
              type="search"
              aria-label={t("ui.Sidebar.search_sessions")}
              placeholder={t("ui.Sidebar.search_sessions")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => { if (!query.trim()) setSearchOpen(false); }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault(); event.stopPropagation();
                setQuery(""); setSearchOpen(false);
                requestAnimationFrame(() => searchButtonRef.current?.focus());
              }}
            /> : <>
            <button
              type="button"
              className="btn btn-new btn-new-session"
              aria-label={t("ui.common.new_session")}
              onClick={() => newSessionIn(historyCwd || undefined)}
            >
              <svg className="new-session-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span className="new-session-label">{t("ui.common.new_session")}</span>
              <span className="new-session-label-compact" aria-hidden="true">{t("ui.Sidebar.new")}</span>
            </button>
            <button ref={searchButtonRef} type="button" className="btn btn-new sidebar-search" aria-label={t("ui.Sidebar.search_sessions")} title={t("ui.Sidebar.search_sessions")} onClick={() => { if (panelOpen) store.closeSidebarPanel(window.matchMedia("(max-width: 720px)").matches); setSearchOpen(true); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
            </button>
            </>}
          </div>
          {/* 手机列表页右上角的文件 / 终端 / 派单（桌面隐藏）；放在新建行之后，网格里排到最右列 */}
          {mobileActions && <span className="mobile-panel-launcher">{mobileActions}</span>}
        </>
      )}
      <div className="sidebar-body">
        {!collapsed && (
          <div className="sidebar-session-area" inert={panelOpen} aria-hidden={panelOpen || undefined}>
            <ul className="session-list">
              {waiting.length > 0 && (
                // 分区标题复用 .page-nav-title 的中性小字语言；暖色仍只出现在行内闸门徽标上
                <li className="page-nav-title" role="presentation">{t("ui.Sidebar.pending_sentence", { p0: (waiting.length) })}</li>
              )}
              {waiting.map(renderRow)}
              {pinned.length > 0 && <li className="sidebar-section-label" role="presentation"><span>{t("ui.Sidebar.pinned")}</span></li>}
              {pinned.map(renderRow)}
              {projects.map((project, index) => renderProject(project, index))}
              {olderProjects.length > 0 && <li className="sidebar-older-projects">
                <button type="button" className="project-toggle older-projects-toggle"
                  aria-expanded={searching || olderProjectsOpen} aria-controls="older-project-list"
                  onClick={() => toggleOlderProjects(!(searching || olderProjectsOpen))}>
                  <svg className={`older-project-chevron${searching || olderProjectsOpen ? "" : " collapsed"}`} width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  <span>{t("ui.Sidebar.older_projects", { count: olderProjects.length })}</span>
                </button>
                {(searching || olderProjectsOpen) && <ul className="session-list older-project-list" id="older-project-list">
                  {olderProjects.map((project, index) => renderProject(project, index, false))}
                </ul>}
              </li>}
              {orderError && <li className="session-confirm-error" role="alert">{orderError}</li>}
              {searching && <li><button type="button" className="sidebar-history-search" onClick={() => store.navigateHistory(undefined, query.trim())}>{t("ui.Sidebar.search_history", { query: query.trim() })}</button></li>}
              {waiting.length === 0 && pinned.length === 0 && projects.length === 0 && olderProjects.length === 0 && !searching && (
                <li className="session-list-empty">{totalSessions === 0 ? t("ui.Sidebar.no_sessions_yet") : t("ui.Sidebar.no_sessions_in_the_last_3_days")}</li>
              )}
            </ul>
          </div>
        )}
        {panelOpen && !collapsed && (
          <section className="sidebar-panel-expanded" aria-label={historyOpen ? t("ui.Sidebar.session_history_content") : currentPage?.name || t("ui.Sidebar.page_not_found")}>
            {historyOpen ? <div id="sidebar-history-panel" className="sidebar-panel-content"><HistoryView /></div>
              : currentPage ? <div id={`sidebar-page-${currentPage.id}`} className="sidebar-panel-content"><PageView page={currentPage} sidebar onCollapse={closePanel} /></div>
              : <div className="sidebar-panel-content sidebar-panel-missing">{t("ui.Sidebar.this_page_may_have_been_removed_from")}</div>}
          </section>
        )}
        <div className="sidebar-foot">
          <div className="sidebar-foot-pages">
            <HistoryNav collapsed={collapsed} onPrepare={preparePanel} onClose={closePanel} />
            <PageNav collapsed={collapsed} onPrepare={preparePanel} onClose={closePanel} />
          </div>
          <div className="sidebar-foot-actions">
            <SettingsMenu />
            <LauncherMenu collapsed={collapsed} />
          </div>
        </div>
      </div>
      <SidebarResize collapsed={collapsed} usageOpen={currentPageId === "ai-usage" && !collapsed} onToggle={onToggle} />
    </aside>
  );
}

/** 左栏底部「历史会话」入口（页面分区上方，同一套分区语言；收起态只显图标）。 */
function HistoryNav({ collapsed, onPrepare, onClose }: PanelNavProps) {
  const historyOpen = useStore(selectHistoryOpen);
  return (
    <SidebarPanel name={t("ui.common.session_history")} open={historyOpen} collapsed={collapsed} onClose={onClose} header={
      <button
        type="button"
        className={`page-nav-item${historyOpen ? " active" : ""}`}
        title={historyOpen ? t("ui.Sidebar.collapse_session_history") : t("ui.Sidebar.session_history_browse_native_histories_saved_by")}
        aria-label={historyOpen ? t("ui.Sidebar.back_collapse_session_history") : t("ui.common.session_history")}
        aria-expanded={historyOpen}
        aria-controls="sidebar-history-panel"
        onClick={() => {
          onPrepare();
          if (historyOpen) onClose();
          else store.navigateHistory();
        }}
      >
        <span className="page-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {historyOpen ? <path d="M15 5l-7 7 7 7" /> : <>
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              <polyline points="12 7 12 12 15.5 14" />
            </>}
          </svg>
        </span>
        {/* 打开后入口变「‹ 后退」，再点收起回到会话列表（用户 10-02） */}
        {!collapsed && <span className="page-nav-name">{historyOpen ? t("ui.Sidebar.back") : t("ui.Sidebar.history")}</span>}
      </button>
    } />
  );
}

/** manifest icon：emoji 直接文本，内联 SVG 字符串按 HTML 渲染（server 已校验形状）。 */
export function PageIcon({ icon }: { icon: string }) {
  if (isInlineSvg(icon)) {
    return (
      <span className="page-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
    );
  }
  return (
    <span className="page-icon" aria-hidden="true">
      {icon}
    </span>
  );
}

/** 左栏底部扩展页面入口：来自 /api/pages，未知类型跳过并给小字提示。 */
function PageNav({ collapsed, onPrepare, onClose }: PanelNavProps) {
  const pages = useStore((value) => value.pages);
  const skippedPages = useStore((value) => value.skippedPages);
  const resetPending = useStore((value) => !!value.codexResets?.enabled && value.codexResets.pending.some(event => isUpcomingReset(event, value.now)));
  const currentPageId = useStore((value) => value.currentPageId);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 721px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return (
    <>
      {pages.map((page) => (
        <SidebarPanel key={page.id} name={page.name} open={currentPageId === page.id} collapsed={collapsed} onClose={onClose} header={
        <button
          type="button"
          className={`page-nav-item${page.id === "ai-usage" ? " sidebar-foot-usage" : ""}${currentPageId === page.id ? " active" : ""}`}
          title={currentPageId === page.id ? t("ui.Sidebar.back_collapse", { p0: (page.name) }) : collapsed || (desktop && page.id === "ai-usage") ? page.name : page.description || page.name}
          aria-label={currentPageId === page.id ? t("ui.Sidebar.back_collapse", { p0: (page.name) }) : page.name}
          aria-expanded={currentPageId === page.id}
          aria-controls={`sidebar-page-${page.id}`}
          onClick={() => {
            onPrepare();
            if (currentPageId === page.id) onClose();
            else store.navigatePage(page.id);
          }}
        >
          {currentPageId === page.id ? <span className="page-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
          </span> : <PageIcon icon={page.icon} />}
          {page.id === "ai-usage" && resetPending && <span className="codex-reset-dot" role="img" aria-label={t("ui.CodexResets.pending")} />}
          {!collapsed && <span className="page-nav-name">{currentPageId === page.id ? t("ui.Sidebar.back") : page.id === "ai-usage" ? t("ui.Sidebar.allowance") : page.name}</span>}
        </button>
        } />
      ))}
      {currentPageId && !pages.some((page) => page.id === currentPageId) && !collapsed && (
        <SidebarPanel name={t("ui.Sidebar.page_not_found")} open collapsed={false} onClose={onClose} header={
          <button type="button" className="page-nav-item active" aria-expanded="true" onClick={onClose}>{t("ui.Sidebar.page_not_found")}</button>
        } />
      )}
      {!collapsed && skippedPages.length > 0 && (
        <p className="page-nav-skipped">{t("ui.Sidebar.skipped_unsupported_page_types_sentence", { p0: (skippedPages.length), p1: ([...new Set(skippedPages.map((p) => p.type))].join("、")) })}</p>
      )}
    </>
  );
}

interface PanelNavProps {
  collapsed: boolean;
  onPrepare: () => void;
  onClose: () => void;
}

/** 标题始终留在底部入口位置；内容由 Sidebar 的第一行承载。 */
function SidebarPanel({ name, open, collapsed, onClose, header }: {
  name: string;
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  header: ReactNode;
}) {
  return (
    <section className={`page-nav sidebar-panel-slot${open && !collapsed ? " sidebar-panel-open" : ""}`} aria-label={name}>
      <div className="sidebar-panel-head">
        {header}
        {open && !collapsed && <button type="button" className="icon-btn" aria-label={t("ui.Sidebar.collapse", { p0: (name) })} title={t("ui.Sidebar.collapse", { p0: (name) })} onClick={onClose}>⌄</button>}
      </div>
    </section>
  );
}

/** 竖三点「⋮」：行悬停按钮、左滑露出按钮、分组标题按钮共用。 */
function MoreDotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  pending,
  active,
  now,
  windowsPaths,
  swipeOpen,
  onSwipeChange,
}: {
  session: SessionRecord;
  pending: number;
  active: boolean;
  now: number;
  windowsPaths: boolean;
  swipeOpen: boolean;
  onSwipeChange: (id: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [permanently, setPermanently] = useState(false);
  const [busy, setBusy] = useState(false);
  // 主回合已结束但还有后台任务（委派的 codex 等）在跑：仍算「正在工作」
  const backgroundBusy = session.status === "idle" && (session.backgroundTasks?.length ?? 0) > 0;
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // 行菜单（悬停 ⋮ / 右键 / 长按 / 左滑 ⋮ 同一个）：fixed 定位在指针处；长按触发后吞掉随后那次 click
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuClosedAt = useRef(0);
  const longPressTimer = useRef<number | undefined>(undefined);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  // 行内重命名：Enter/失焦保存、Esc 取消；renameGuard 挡住取消/保存成功后卸载引发的那次 blur
  const [renaming, setRenaming] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const renameGuard = useRef(false);
  const data = store.data.get(session.id);
  const title = sessionTitle(session, data?.events);
  const shortTitle = shortSessionTitle(title);
  const [swipeOffset, setSwipeOffset] = useState<number | null>(null);
  const swiping = useRef(false);
  const dot = sidebarStatusDot(session, pending, now);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || confirming || renaming) return;
    let start: { x: number; y: number; initial: number } | null = null;
    let direction: "horizontal" | "vertical" | null = null;
    let offset = 0;
    const begin = (event: TouchEvent) => {
      if (!window.matchMedia("(max-width: 720px)").matches || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      start = { x: touch.clientX, y: touch.clientY, initial: swipeOpen ? -52 : 0 };
      offset = start.initial;
      direction = null;
      swiping.current = false;
      suppressClick.current = false;
    };
    const move = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      // 方向锁定与位移计算是 sidebar-menu.ts 的纯函数：竖向一旦锁定不再转横向
      direction = lockSidebarSwipe(direction, dx, dy, swipeOpen);
      if (direction) clearLongPress();
      if (direction !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      swiping.current = true;
      suppressClick.current = true;
      offset = sidebarSwipeOffset(start.initial, dx);
      setSwipeOffset(offset);
    };
    const finish = (event: TouchEvent) => {
      if (direction === "horizontal") onSwipeChange(event.type !== "touchcancel" && offset <= -26 ? session.id : null);
      setSwipeOffset(null);
      swiping.current = false;
      start = null;
      direction = null;
    };
    row.addEventListener("touchstart", begin, { passive: true });
    // React 的根 touchmove 监听是 passive；只在锁定横向后阻止默认动作。
    row.addEventListener("touchmove", move, { passive: false });
    row.addEventListener("touchend", finish);
    row.addEventListener("touchcancel", finish);
    return () => {
      row.removeEventListener("touchstart", begin);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", finish);
      row.removeEventListener("touchcancel", finish);
      clearLongPress();
    };
  }, [confirming, renaming, swipeOpen, session.id, onSwipeChange]);

  // 进入确认态把焦点收进行内按钮：默认落「取消」，连按 Enter 不会误删
  useEffect(() => {
    if (confirming) cancelBtnRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const closeMenu = useCallback((returnFocus = false) => {
    setMenuAt(null);
    setMenuError(null);
    menuClosedAt.current = Date.now();
    if (returnFocus) rowRef.current?.focus();
  }, []);
  const openMenu = (x: number, y: number) => {
    onSwipeChange(null);
    setMenuError(null);
    // 完整路径可换行；菜单受视口高度限制并可滚动。
    setMenuAt({ x: Math.max(8, Math.min(x, window.innerWidth - 228)), y: Math.max(8, Math.min(y, window.innerHeight - 300)) });
  };
  // ⋮ 按钮的点击与菜单的 pointerdown 外点关闭是同一手势：刚被关掉的那次点击不再重开
  const toggleMenuAt = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (menuAt) { closeMenu(true); return; }
    if (Date.now() - menuClosedAt.current < 250) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(rect.left, rect.bottom + 4);
  };
  const clearLongPress = () => {
    window.clearTimeout(longPressTimer.current);
    longPressStart.current = null;
  };

  // 菜单动作失败留在原处就地报错。
  const runMenuAction = async (action: () => Promise<unknown>) => {
    setMenuError(null);
    try {
      await action();
      closeMenu();
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    }
  };
  const startRename = () => {
    closeMenu();
    setRenameError(null);
    setRenaming(true);
  };
  const saveRename = async () => {
    const input = renameRef.current;
    if (!input || renameBusy) return;
    const customTitle = normalizeSidebarTitle(input.value);
    setRenameBusy(true);
    try {
      // 空串 = 恢复自动标题（服务端删掉 customTitle）
      await store.patchSession(session.id, { customTitle });
      renameGuard.current = true;
      setRenaming(false);
      setRenameError(null);
      requestAnimationFrame(() => rowRef.current?.focus());
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
      setRenameBusy(false);
    }
  };
  const cancelRename = () => {
    renameGuard.current = true;
    setRenaming(false);
    setRenameError(null);
    requestAnimationFrame(() => rowRef.current?.focus());
  };
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.remove(session.id, permanently);
      // 成功后该行随列表一起卸载，无需清状态
    } catch (e) {
      // 失败留在确认态：错误就地显示，可重试或取消
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const cancelConfirm = () => {
    setConfirming(false);
    // 焦点还给这一行（等下一轮渲染后按钮重新挂载）
    requestAnimationFrame(() => rowRef.current?.focus());
  };
  const beginConfirm = (permanent = false) => {
    onSwipeChange(null);
    closeMenu();
    setError(null);
    setPermanently(permanent);
    setConfirming(true);
  };

  const mainItems: SidebarMenuItem[] = [
    { id: "pin", label: session.pinned ? t("ui.Sidebar.unpin") : t("ui.Sidebar.pin"), icon: "pin", shortcut: "P",
      onSelect: () => void runMenuAction(() => store.patchSession(session.id, { pinned: !session.pinned })) },
    { id: "rename", label: t("ui.Sidebar.rename"), icon: "rename", shortcut: "R", onSelect: startRename },
    { id: "delete", label: t("ui.common.remove"), icon: "delete", shortcut: "D", divider: true, onSelect: () => beginConfirm() },
    ...(session.agent === "claude" ? [] : [{ id: "permanent-delete", label: t("ui.common.permanently_delete"), icon: "delete" as const, danger: true, onSelect: () => beginConfirm(true) }]),
  ];
  if (confirming) {
    if (permanently) return <PermanentDeleteConfirm session={session} busy={busy} error={error}
      onCancel={cancelConfirm} onConfirm={() => void confirm()} />;
    const running = session.status === "starting" || session.status === "running";
    return (
      <div
        className="session-confirm"
        onKeyDown={(e) => {
          // 确认态给退路：Esc 取消（焦点在行内按钮上，按键冒泡到此处）
          if (e.key === "Escape") {
            e.preventDefault();
            if (!busy) cancelConfirm();
          }
        }}
      >
        <p className="session-confirm-text">{t("ui.Sidebar.remove_this_session_from_the_workspace")} {t("ui.Sidebar.the_native_conversation_history_will_be_preserved", { p0: AGENT_LABELS[session.agent] })}{running && t("ui.Sidebar.this_session_is_still_running_removing_it")}
        </p>
        {error && <p className="session-confirm-error">{error}</p>}
        <div className="session-confirm-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t("ui.Sidebar.removing") : t("ui.Sidebar.confirm_removal")}
          </button>
          <button
            type="button"
            className="btn"
            ref={cancelBtnRef}
            disabled={busy}
            title={t("ui.common.cancel_esc")}
            onClick={cancelConfirm}
          >{t("ui.common.cancel")}</button>
        </div>
      </div>
    );
  }

  if (renaming) {
    return (
      <div className="session-item session-renaming">
        <div className={`session-row agent-${session.agent}${active ? " active" : ""} session-row-editing`}>
          <AgentIcon agent={session.agent} label={AGENT_LABELS[session.agent]} />
          <input
            ref={renameRef}
            className="session-title-input"
            defaultValue={session.customTitle ?? title}
            aria-label={t("ui.Sidebar.rename_session", { p0: (shortTitle) })}
            disabled={renameBusy}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") { e.preventDefault(); void saveRename(); }
              if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
            }}
            onBlur={() => {
              if (renameGuard.current) { renameGuard.current = false; return; }
              void saveRename();
            }}
          />
        </div>
        {renameError && <p className="session-confirm-error">{renameError}</p>}
      </div>
    );
  }

  return (
    <div className={`session-item${swipeOpen ? " session-swipe-open" : ""}${swipeOffset !== null ? " session-swiping" : ""}${menuAt ? " session-menu-open" : ""}`}>
      <button
        type="button"
        className="session-swipe-more"
        tabIndex={swipeOpen ? 0 : -1}
        aria-hidden={!swipeOpen}
        aria-label={t("ui.Sidebar.actions_for_session", { p0: (shortTitle) })}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          openMenu(rect.left, rect.bottom + 4);
        }}
      >
        <MoreDotsIcon />
      </button>
      <button
        type="button"
        ref={rowRef}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onContextMenu={(e) => {
          // 鼠标右键、Android 长按、键盘菜单键 / Shift+F10 都走这里
          e.preventDefault();
          clearLongPress();
          if (e.clientX === 0 && e.clientY === 0) {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left + 24, r.bottom);
          } else {
            openMenu(e.clientX, e.clientY);
          }
        }}
        onPointerDown={(e) => {
          // iOS Safari 长按不发 contextmenu：触屏自己计时 500ms
          if (e.pointerType !== "touch") return;
          longPressStart.current = { x: e.clientX, y: e.clientY };
          const { clientX, clientY } = e;
          longPressTimer.current = window.setTimeout(() => {
            suppressClick.current = true;
            openMenu(clientX, clientY);
          }, 500);
        }}
        onPointerMove={(e) => {
          const start = longPressStart.current;
          if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearLongPress();
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        className={`session-row agent-${session.agent}${
          active ? " active" : ""
        }${session.status === "dead" ? " dead" : ""}`}
        style={swipeOffset !== null ? { transform: `translateX(${swipeOffset}px)` } : undefined}
        onClick={() => {
          if (swiping.current) return;
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (swipeOpen) { onSwipeChange(null); return; }
          store.navigate(session.id);
        }}
      >
        {/* 单行：身份图标 · 标题 ……… 闸门徽标 · ! · 状态灯 · 时间。状态文字不再常显，放进状态灯的 title */}
        <AgentIcon agent={session.agent} label={AGENT_LABELS[session.agent]} />
        <SidebarSessionTitle text={title} />
        <span className="row-meta">
          {session.worktree?.branch && <span className="worktree-branch" title={session.cwd}>{session.worktree.branch}</span>}
          {pending > 0 && (
            <span className="gate-badge" title={t("ui.Sidebar.approvals_pending", { p0: (pending) })}>
              {pending}
            </span>
          )}
          {session.riskyMode && (
            <span className="risky-mark" title={t("ui.Sidebar.this_session_uses_a_mode_with_no")}>
              !
            </span>
          )}
          {dot && (
            <span
              className={`status-dot status-${dot}`}
              role="img"
              aria-label={backgroundBusy ? t("ui.Sidebar.background_tasks", { p0: (session.backgroundTasks!.length) }) : STATUS_LABELS[session.status] ?? session.status}
              title={backgroundBusy
                ? t("ui.Sidebar.background_tasks_2", { p0: (session.backgroundTasks!.length), p1: (session.backgroundTasks!.map((task) => task.description || task.type).join("；")) })
                : STATUS_HINTS[session.status] ?? session.status}
            />
          )}
          <span className="row-time" title={relativeTime(session.lastActivityAt, now)}>
            {relativeTimeShort(session.lastActivityAt, now)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="session-row-more"
        aria-label={t("ui.Sidebar.actions_for_session", { p0: (shortTitle) })}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={toggleMenuAt}
      >
        <MoreDotsIcon />
      </button>
      {menuAt && (
        <SidebarActionMenu
          position={menuAt}
          label={t("ui.Sidebar.actions_for_session", { p0: (shortTitle) })}
          items={mainItems}
          description={projectDisplayPath(session.cwd, windowsPaths)}
          error={menuError}
          onClose={(returnFocus) => closeMenu(returnFocus === true)}
        >
        </SidebarActionMenu>
      )}
    </div>
  );
});

/** 只保存手动选择；无记录时跟随工作状态。隐私模式读写会抛，退回内存态。 */
function usePersistedProjectFolds(): [Record<string, "open" | "closed">, (path: string, state: "open" | "closed") => void] {
  const key = "aireins-project-folds";
  const [value, setValue] = useState<Record<string, "open" | "closed">>(() => {
    try {
      const raw = localStorage.getItem(key);
      const saved: unknown = raw === null ? {} : JSON.parse(raw);
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, "open" | "closed"] => entry[1] === "open" || entry[1] === "closed")) : {};
    } catch { return {}; }
  });
  const setFold = (path: string, state: "open" | "closed") => setValue(previous => {
    const next = { ...previous, [path]: state };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 私密模式保留当前设备内存态 */ }
    return next;
  });
  return [value, setFold];
}

function ProjectHeader({ project, collapsed, onToggle, onNew, previous, next, now, windowsPaths,
  sortable = true, draggable, onDragStart, onDragEnd }: {
  project: ReturnType<typeof selectSidebarSections>["projects"][number];
  collapsed: boolean; onToggle: () => void; onNew: () => void;
  previous?: string; next?: string; now: number; windowsPaths: boolean;
  sortable?: boolean; draggable: boolean; onDragStart: (event: DragEvent<HTMLDivElement>) => void; onDragEnd: () => void;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuClosedAt = useRef(0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pointerType = useRef<string | null>(null);
  const closeMenu = (returnFocus = false) => {
    setMenuAt(null); setMenuError(null); menuClosedAt.current = Date.now();
    if (returnFocus) moreRef.current?.focus();
  };
  const move = async (target: { before: string } | { after: string }) => {
    setMenuError(null);
    try { await store.moveProject(project.path, target); closeMenu(true); }
    catch (error) { setMenuError(error instanceof Error ? error.message : String(error)); }
  };
  const items: SidebarMenuItem[] = [
    ...(sortable ? [{ id: "move-up", label: t("ui.Sidebar.move_up"), icon: "up", disabled: !previous,
      onSelect: () => { if (previous) void move({ before: previous }); } },
    { id: "move-down", label: t("ui.Sidebar.move_down"), icon: "down", disabled: !next,
      onSelect: () => { if (next) void move({ after: next }); } }] satisfies SidebarMenuItem[] : []),
    { id: "history", label: t("ui.Sidebar.directory_history"), icon: "folder", divider: sortable,
      onSelect: () => { closeMenu(); store.navigateHistory(project.path); } },
  ];
  const dots = project.sessions.map(session => sidebarStatusDot(session, store.pendingCountFor(session), now));
  const dot = ["needs-user", "error", "running", "starting"].find(value => dots.includes(value));
  const fullPath = projectDisplayPath(project.path, windowsPaths);
  return <div className="project-header" draggable={draggable} onPointerDown={(event) => { pointerType.current = event.pointerType; }}
    onDragStart={(event) => {
      if (!draggable || pointerType.current === "touch" || (event.target instanceof Element && event.target.closest(".project-actions"))) { event.preventDefault(); return; }
      closeMenu(); onDragStart(event);
    }} onDragEnd={onDragEnd}>
    <button type="button" className="project-toggle" title={fullPath}
      aria-expanded={!collapsed} aria-controls={`project-${encodeURIComponent(project.path)}`} onClick={onToggle}>
      <svg className="project-folder" data-state={collapsed ? "closed" : "open"} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {collapsed ? <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
          : <><path d="M2 10V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v1" /><path d="M2 10h18a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H6a2 2 0 0 1-1.94-1.5L2 10Z" /></>}
      </svg>
      <span className="project-name">{project.label}</span>
      {collapsed && <>
        {dot && <span className={`status-dot status-${dot}`} aria-label={dot === "needs-user" ? t("ui.Sidebar.pending_status") : STATUS_LABELS[dot]} />}
        <span className="project-count" aria-label={t("ui.Sidebar.project_session_count", { count: project.sessions.length })}>{project.sessions.length}</span>
      </>}
    </button>
    <span className="project-actions">
      <button type="button" className="project-action" aria-label={t("ui.Sidebar.new_in_directory", { path: project.label })} title={t("ui.Sidebar.new_in_directory", { path: fullPath })} onClick={onNew}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" ref={moreRef} className="project-action" aria-label={t("ui.Sidebar.directory_actions", { path: project.label })} aria-haspopup="menu" aria-expanded={menuAt !== null}
        onClick={(event) => {
          event.stopPropagation();
          if (menuAt) { closeMenu(true); return; }
          if (Date.now() - menuClosedAt.current < 250) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuAt({ x: Math.max(8, Math.min(rect.left, window.innerWidth - 228)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 220)) });
        }}><MoreDotsIcon /></button>
    </span>
    {menuAt && <SidebarActionMenu position={menuAt} label={t("ui.Sidebar.directory_actions", { path: project.label })}
      description={fullPath} items={items} error={menuError} onClose={closeMenu} />}
  </div>;
}

