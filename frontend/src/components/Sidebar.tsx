import { t, dictionaries } from "../i18n";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MouseEvent, type ReactNode, type SetStateAction } from "react";
import type { AgentKind, ConfigOptionId, DriverConfigOption, SessionGroup, SessionRecord } from "../types";
import { relativeTime, relativeTimeShort, sessionTitle } from "../format";
import { AgentIcon } from "./AgentIcon";
import { isInlineSvg } from "../pages";
import type { CreateSessionInput } from "../api";
import { store, type Store } from "../store";
import { selectSidebarSections, sidebarStatusDot } from "../sidebar-sessions";
import { lockSidebarSwipe, normalizeSidebarTitle, sidebarSwipeOffset } from "../sidebar-menu";
import { SidebarActionMenu, type SidebarMenuItem } from "./SidebarActionMenu";
import { useStore } from "../useStore";
import { LauncherMenu } from "./LauncherMenu";
import { SettingsMenu } from "./SettingsMenu";
import { HostSwitcher } from "./HostSwitcher";
import { ConfigPills, type MenuGroup } from "./ConfigMenu";
import { configOptionsForModel, modelConfigPatch, newSessionConfig, pillText } from "../config-view";
import { DirectoryContents } from "./DirectoryBrowser";
import { normalizeDirectoryPath } from "../directory-path";
import { HistoryView } from "./HistoryView";
import { PageView } from "./PageView";
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

const CWD_STORAGE_KEY = "workbench-last-cwd";

const selectSessions = (value: Store) => value.sessions;
const selectNow = (value: Store) => value.now;
const selectMeta = (value: Store) => value.meta;
const selectHistoryOpen = (value: Store) => value.historyOpen;
const selectHistoryNewCwd = (value: Store) => value.historyOpen ? value.historyCwdFilter : "";
const selectCurrentId = (value: Store) => value.currentId;
const selectPendingSignature = (value: Store) =>
  value.sessions.map((session) => `${session.id}:${value.pendingCount(session.id)}`).join("|");

// 隐私模式下 localStorage 访问器本身就会抛异常，与主题读写同一纪律：try/catch 兜底。
function readSavedCwd(): string {
  try {
    return localStorage.getItem(CWD_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

// cwd 预填三级回退：① localStorage 里上次成功建会话的 cwd → ② 最近活跃会话的 cwd → ③ /api/meta 的 defaultCwd
function pickInitialCwd(): string {
  const saved = readSavedCwd();
  if (saved) return saved;
  const latest = [...store.sessions].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  )[0];
  if (latest?.cwd) return latest.cwd;
  return store.meta?.defaultCwd ?? "";
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
  returnToSession?: boolean;
  /** 手机列表页并进顶栏同一行的面板开关（文件/终端/派单）；桌面由 CSS 隐藏 */
  mobileActions?: ReactNode;
}

export function Sidebar({ collapsed, onToggle, newOpen, onNewOpenChange, returnToSession = false, mobileActions }: SidebarProps) {
  const sessionRecords = useStore(selectSessions);
  const sessionGroups = useStore((value) => value.sessionGroups);
  const [collapsedGroups, toggleGroup] = usePersistedSet("workbench-collapsed-session-groups", []);
  const [collapsedSections, toggleSection] = usePersistedSet("workbench-collapsed-time-sections", []);
  const earlierOpen = useStore((value) => value.sidebarEarlierOpen);
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
  const [newCwd, setNewCwd] = useState<string | undefined>();
  // 历史面板已选定目录时，「新建会话」直接以该目录为默认工作目录
  const historyCwd = useStore(selectHistoryNewCwd);
  const newSessionIn = (cwd: string) => {
    setNewCwd(cwd);
    if (window.matchMedia("(max-width: 720px)").matches) store.navigate(null);
    else store.closeSidebarPanel();
    onNewOpenChange(true);
  };
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
  const { waiting, pinned, groups, sections } = selectSidebarSections({ ...store, sessions: sessionRecords, sessionGroups, now, currentId, pendingCount: store.pendingCount.bind(store) });
  const totalSessions = sessionRecords.length;
  // 收起态仍要能看到全局待审批压力：全部会话未决闸门总数。
  const totalPending = sessionRecords.reduce(
    (sum, session) => sum + store.pendingCount(session.id),
    0,
  );

  const renderRow = (session: SessionRecord) => (
    <li key={session.id}>
      <SessionRow
        session={session}
        groups={sessionGroups}
        pending={store.pendingCount(session.id)}
        active={session.id === currentId}
        now={now}
        swipeOpen={swipedId === session.id}
        onSwipeChange={setSwipedId}
      />
    </li>
  );

  return (
    <aside className={`sidebar${pageOpen && !collapsed ? " sidebar-page-open" : ""}${newOpen && !collapsed ? " sidebar-new-open" : ""}`} ref={sidebarRef}>
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
            <button
              type="button"
              className="btn btn-new btn-new-session"
              aria-expanded={newOpen}
              aria-label={newOpen ? t("ui.Sidebar.cancel_creation") : t("ui.common.new_session")}
              onClick={() => {
                if (!newOpen && historyCwd) { newSessionIn(historyCwd); return; }
                if (panelOpen) store.closeSidebarPanel(window.matchMedia("(max-width: 720px)").matches);
                setNewCwd(undefined);
                onNewOpenChange(!newOpen);
              }}
            >
              {/* 收起即卸载表单、丢掉未提交的输入，所以叫「取消」而不是「收起」 */}
              <svg className="new-session-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span className="new-session-label">{newOpen ? t("ui.Sidebar.cancel_creation") : t("ui.common.new_session")}</span>
              <span className="new-session-label-compact" aria-hidden="true">{newOpen ? t("ui.common.cancel") : t("ui.Sidebar.new")}</span>
            </button>
            {/* chatgpt.com 禁止 iframe（X-Frame-Options: SAMEORIGIN），只能开独立窗口；已开就切过去，不重载丢页面 */}
            <button type="button" className="btn btn-new sidebar-chatgpt" aria-label={t("ui.Sidebar.open_chatgpt_on_the_web")} title={t("ui.Sidebar.open_chatgpt_on_the_web_in_a")} onClick={openChatGPT}>
              ChatGPT <span className="sidebar-chatgpt-arrow" aria-hidden="true">↗</span>
            </button>
          </div>
          {/* 手机列表页右上角的文件 / 终端 / 派单（桌面隐藏）；放在新建行之后，网格里排到最右列 */}
          {mobileActions && <span className="mobile-panel-launcher">{mobileActions}</span>}
        </>
      )}
      <div className="sidebar-body">
        {!collapsed && (
          <div className="sidebar-session-area" inert={panelOpen} aria-hidden={panelOpen || undefined}>
            {newOpen && <NewSessionForm initialCwd={newCwd} onDone={() => onNewOpenChange(false)} />}
            <ul className="session-list">
              {waiting.length > 0 && (
                // 分区标题复用 .page-nav-title 的中性小字语言；暖色仍只出现在行内闸门徽标上
                <li className="page-nav-title" role="presentation">{t("ui.Sidebar.pending_sentence", { p0: (waiting.length) })}</li>
              )}
              {waiting.map(renderRow)}
              {pinned.length > 0 && <li className="sidebar-section-label" role="presentation"><span>{t("ui.Sidebar.pinned")}</span></li>}
              {pinned.map(renderRow)}
              {groups.map(group => <li key={group.id} className="sidebar-session-group">
                <SessionGroupHeader group={group} collapsed={collapsedGroups.has(group.id)} onToggle={() => toggleGroup(group.id)} />
                {!collapsedGroups.has(group.id) && <ul className="session-list session-group-list" id={`session-group-${group.id}`}>{group.sessions.map(renderRow)}</ul>}
              </li>)}
              {sections.map(section => {
                // Keep the legacy stored labels stable when the interface language changes.
                const key = ["core.084", "core.085", "core.086"].find(key => t(key) === section.label);
                const storageKey = key ? dictionaries["zh-CN"][key]! : section.label;
                const earlier = key === "core.086";
                const folded = earlier ? !earlierOpen : collapsedSections.has(storageKey);
                return <li className="sidebar-time-section" key={section.label}>
                  <button type="button" className="sidebar-section-toggle" aria-expanded={!folded}
                    aria-controls={`time-section-${section.label}`} onClick={() => earlier ? store.toggleSidebarEarlier() : toggleSection(storageKey)}>
                    <span>{section.label}</span>
                    <svg className={`sidebar-section-chevron${folded ? " collapsed" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                  {!folded && <ul className="session-list" id={`time-section-${section.label}`}>{section.sessions.map(renderRow)}</ul>}
                </li>;
              })}
              {waiting.length === 0 && pinned.length === 0 && groups.every(group => group.sessions.length === 0) && sections.length === 0 && (
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
  const resetPending = useStore((value) => !!value.codexResets?.enabled && value.codexResets.pending.length > 0);
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

function SessionRow({
  session,
  groups,
  pending,
  active,
  now,
  swipeOpen,
  onSwipeChange,
}: {
  session: SessionRecord;
  groups: SessionGroup[];
  pending: number;
  active: boolean;
  now: number;
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
  const [menuScreen, setMenuScreen] = useState<"main" | "group" | "new-group">("main");
  const [menuError, setMenuError] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
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
    setMenuScreen("main");
    setMenuError(null);
    setNewGroupName("");
    menuClosedAt.current = Date.now();
    if (returnFocus) rowRef.current?.focus();
  }, []);
  const openMenu = (x: number, y: number) => {
    onSwipeChange(null);
    setMenuScreen("main");
    setMenuError(null);
    // 别贴出视口：菜单约 220 宽、主屏约 200 高（分组子屏内部滚动）
    setMenuAt({ x: Math.max(8, Math.min(x, window.innerWidth - 228)), y: Math.max(8, Math.min(y, window.innerHeight - 208)) });
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

  // 菜单动作失败就留在菜单里就地报错（pin/移动分组走 PATCH，可能撞 400/404）
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
  const createGroupAndMove = async () => {
    const name = normalizeSidebarTitle(newGroupName);
    if (!name) return;
    await runMenuAction(async () => {
      const group = await store.createSessionGroup(name);
      await store.patchSession(session.id, { groupId: group.id });
    });
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
    { id: "move", label: t("ui.common.move_to_group"), icon: "folder", trailing: "›", onSelect: () => setMenuScreen("group") },
    { id: "delete", label: t("ui.common.remove"), icon: "delete", shortcut: "D", divider: true, onSelect: () => beginConfirm() },
    ...(session.agent === "claude" ? [] : [{ id: "permanent-delete", label: t("ui.common.permanently_delete"), icon: "delete" as const, danger: true, onSelect: () => beginConfirm(true) }]),
  ];
  const groupItems: SidebarMenuItem[] = [
    { id: "back", label: t("ui.common.back"), icon: "back", onSelect: () => setMenuScreen("main") },
    ...groups.map((group) => ({
      id: `group:${group.id}`, label: group.name, icon: "folder" as const,
      onSelect: () => void runMenuAction(() => store.patchSession(session.id, { groupId: group.id })),
    })),
    { id: "new-group", label: t("ui.Sidebar.new_group"), icon: "plus", divider: groups.length > 0, onSelect: () => setMenuScreen("new-group") },
    ...(session.groupId ? [{
      id: "leave-group", label: t("ui.Sidebar.remove_from_group"), icon: "ungroup" as const, divider: true,
      onSelect: () => void runMenuAction(() => store.patchSession(session.id, { groupId: null })),
    }] : []),
  ];
  const newGroupItems: SidebarMenuItem[] = [
    { id: "back", label: t("ui.common.back"), icon: "back", onSelect: () => setMenuScreen("group") },
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
          submenuItems={menuScreen === "group" ? groupItems : menuScreen === "new-group" ? newGroupItems : undefined}
          error={menuError}
          onClose={(returnFocus) => closeMenu(returnFocus === true)}
        >
          {menuScreen === "new-group" && (
            <form
              className="row-menu-newgroup"
              onSubmit={(e) => {
                e.preventDefault();
                void createGroupAndMove();
              }}
            >
              <input
                className="row-menu-input"
                value={newGroupName}
                placeholder={t("ui.Sidebar.group_name_press_enter_to_create_and")}
                aria-label={t("ui.Sidebar.new_group_name")}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </form>
          )}
        </SidebarActionMenu>
      )}
    </div>
  );
}

/** 用户分组标题：整行折叠/展开，右侧 ⋮ 弹分组操作（重命名分组 / 删除分组＝成员移回普通分区）。 */
/** 折叠状态按设备记在 localStorage；隐私模式读写会抛，退回内存态。 */
function usePersistedSet(key: string, fallback: string[]): [Set<string>, (id: string) => void] {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      const saved: unknown = raw === null ? fallback : JSON.parse(raw);
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : fallback);
    } catch { return new Set(fallback); }
  });
  const toggle = (id: string) => setValue(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* 私密模式保留当前设备内存态 */ }
    return next;
  });
  return [value, toggle];
}

function SessionGroupHeader({
  group,
  collapsed,
  onToggle,
}: {
  group: SessionGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuClosedAt = useRef(0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const renameGuard = useRef(false);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const closeMenu = (returnFocus = false) => {
    setMenuAt(null);
    setMenuError(null);
    menuClosedAt.current = Date.now();
    if (returnFocus) moreRef.current?.focus();
  };
  const toggleMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (menuAt) { closeMenu(true); return; }
    if (Date.now() - menuClosedAt.current < 250) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuAt({ x: Math.max(8, Math.min(rect.left, window.innerWidth - 228)), y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 130)) });
  };
  const saveRename = async () => {
    const input = renameRef.current;
    if (!input || busy) return;
    const name = normalizeSidebarTitle(input.value);
    if (!name || name === group.name) { renameGuard.current = true; setRenaming(false); return; }
    setBusy(true);
    try {
      await store.renameSessionGroup(group.id, name);
      renameGuard.current = true;
      setRenaming(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const removeGroup = async () => {
    setMenuError(null);
    try {
      // 只删分组：成员会话移回普通分区（服务端清 groupId），不动会话本身
      await store.deleteSessionGroup(group.id);
      closeMenu();
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    }
  };
  const items: SidebarMenuItem[] = [
    { id: "rename-group", label: t("ui.Sidebar.rename_group"), icon: "rename", onSelect: () => { closeMenu(); setError(null); setRenaming(true); } },
    { id: "delete-group", label: t("ui.Sidebar.delete_group"), icon: "delete", danger: true, divider: true, onSelect: () => void removeGroup() },
  ];

  return (
    <div className="session-group-header">
      {renaming ? (
        <input
          ref={renameRef}
          className="session-title-input session-group-title-input"
          defaultValue={group.name}
          aria-label={t("ui.Sidebar.rename_group_2", { p0: (group.name) })}
          disabled={busy}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); void saveRename(); }
            if (e.key === "Escape") { e.preventDefault(); renameGuard.current = true; setRenaming(false); }
          }}
          onBlur={() => {
            if (renameGuard.current) { renameGuard.current = false; return; }
            void saveRename();
          }}
        />
      ) : (
        <button
          type="button"
          className="session-group-toggle"
          aria-expanded={!collapsed}
          aria-controls={`session-group-${group.id}`}
          onClick={onToggle}
        >
          <svg className={`session-group-chevron${collapsed ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          <span className="session-group-name">{group.name}</span>
        </button>
      )}
      <button
        type="button"
        ref={moreRef}
        className="session-group-more"
        aria-label={t("ui.Sidebar.group_actions_for", { p0: (group.name) })}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={toggleMenu}
      >
        <MoreDotsIcon />
      </button>
      {menuAt && (
        <SidebarActionMenu
          position={menuAt}
          label={t("ui.Sidebar.group_actions_for", { p0: (group.name) })}
          items={items}
          error={menuError}
          onClose={(returnFocus) => closeMenu(returnFocus === true)}
        />
      )}
      {error && <p className="session-confirm-error session-group-error">{error}</p>}
    </div>
  );
}

let chatgptWin: Window | null = null;
function openChatGPT() {
  if (chatgptWin && !chatgptWin.closed) return chatgptWin.focus();
  const w = Math.min(1100, screen.availWidth), h = screen.availHeight;
  chatgptWin = window.open("https://chatgpt.com/", "wb-chatgpt", `popup,width=${w},height=${h},left=${screen.availWidth - w},top=0`);
}

function NewSessionForm({ onDone, initialCwd }: { onDone: () => void; initialCwd?: string }) {
  const meta = useStore(selectMeta);
  // 会话列表可能在表单挂载后才到；保留该订阅以触发 cwd 三级回退的补填 effect。
  useStore(selectSessions);
  const [agent, setAgent] = useState<AgentKind>("claude");
  // startPath 只是内嵌浏览器的起点；cwd 跟随浏览器当前目录
  const [startPath, setStartPath] = useState(() => initialCwd ?? pickInitialCwd());
  const [cwd, setCwd] = useState(startPath);
  // 用户在浏览器里点过/按过键后不再自动改起点
  const cwdTouched = useRef(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // 桌面「创建并进入」最低到侧栏一半高处（用户 10-16）；手机表单可占满列表区（用户 10-17）。
  // 目录列表按剩余空间限高，最少留 6 行：笔记本等矮屏上一半处只够两行，此时表单越过一半（用户 10-16）
  useEffect(() => {
    const form = formRef.current;
    const sidebar = form?.closest<HTMLElement>(".sidebar");
    const area = form?.closest<HTMLElement>(".sidebar-session-area");
    if (!form || !sidebar || !area || typeof ResizeObserver === "undefined") return;
    const mobile = window.matchMedia("(max-width: 720px)");
    const fit = () => {
      const list = form.querySelector<HTMLElement>(".dir-list");
      if (!list) return;
      const box = sidebar.getBoundingClientRect();
      const formBox = form.getBoundingClientRect();
      const bottom = mobile.matches ? area.getBoundingClientRect().bottom - 8 : box.top + box.height / 2;
      const rest = formBox.height - list.getBoundingClientRect().height;
      const row = list.querySelector<HTMLElement>(".dir-entry")?.getBoundingClientRect().height || 29;
      const floor = Math.max(58, row * 6 + 2);
      list.style.maxHeight = `${Math.max(floor, bottom - formBox.top - rest)}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(sidebar);
    observer.observe(form);
    mobile.addEventListener("change", fit);
    return () => { observer.disconnect(); mobile.removeEventListener("change", fit); };
  }, []);
  // 三个配置下拉的已选值；"" = 跟随配置（不传该字段）。切 agent 时整体重置。
  const [configSel, setConfigSel] = useState<Partial<Record<ConfigOptionId, string>>>(() => newSessionConfig("claude"));
  const options = meta?.drivers[agent]?.options ?? [];

  useEffect(() => {
    if (initialCwd && !cwdTouched.current) setStartPath(initialCwd);
  }, [initialCwd]);

  // meta/会话列表可能晚于表单挂载到达：用户未动手且起点仍为空时补一次预填
  useEffect(() => {
    if (cwdTouched.current || startPath) return;
    const next = pickInitialCwd();
    if (next) setStartPath(next);
  });

  const submit = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    // 只把非默认（非「跟随配置」）的字段放进 config
    const config = Object.fromEntries(
      Object.entries(configSel).filter(([, value]) => value),
    );
    // 不做建会话前快照（2026-09-30 用户定）：显式 skip；后端默认值 10-01 起也是 skip
    const input: CreateSessionInput = {
      snapshot: "skip",
      agent,
      cwd: normalizeDirectoryPath(cwd, meta?.capabilities.windowsPaths === true),
      ...(Object.keys(config).length > 0 ? { config } : {}),
      ...(message.trim() ? { initialMessage: message.trim() } : {}),
    };
    try {
      const session = await store.create(input);
      // 记忆本次 cwd，下次新建直接预填（localStorage 不可用就跳过）
      try {
        localStorage.setItem(CWD_STORAGE_KEY, session.cwd);
      } catch {
        /* 仅本次不记忆 */
      }
      store.navigate(session.id);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      ref={formRef}
      className="new-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="new-agents" role="radiogroup" aria-label={t("ui.Sidebar.select_agent")}>
        {(Object.keys(AGENT_LABELS) as AgentKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`new-agent agent-${kind}${agent === kind ? " selected" : ""}`}
            onClick={() => {
              setAgent(kind);
              // 选项随 agent 切换，已选值一并重置（别把 claude 的值发给 kimi）
              setConfigSel(newSessionConfig(kind));
            }}
          >
            {AGENT_LABELS[kind]}
          </button>
        ))}
      </div>
      <div className="new-field new-cwd" onPointerDownCapture={() => { cwdTouched.current = true; }} onKeyDownCapture={() => { cwdTouched.current = true; }}>
        <p className="new-hint">{t("ui.Sidebar.paste_directory")}</p>
        <DirectoryContents initialPath={startPath} includeFiles={false} allowWindowsPicker upIcon onPathChange={setCwd} onPathLost={() => setCwd("")} onSelectFile={() => {}} />
      </div>
      {/* 首条消息 + 配置胶囊：与会话输入框同一形态（胶囊直接显示当前值，点开选） */}
      <div className="composer-box">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={1}
          aria-label={t("ui.Sidebar.first_message_optional")}
          placeholder={t("ui.Sidebar.first_message_optional")}
        />
        <div className="cfg-bar">
          <NewConfigPills options={options} selected={configSel} onChange={setConfigSel} />
        </div>
      </div>
      {error && <p className="new-error">{error}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        ref={submitBtnRef}
        disabled={busy || !cwd.trim()}
        title={!cwd.trim() ? t("ui.Sidebar.enter_a_working_directory_first") : undefined}
      >
        {busy ? t("ui.Sidebar.creating") : t("ui.Sidebar.create_and_open")}
      </button>
      {/* 禁用原因不只靠 title tooltip：直接写在按钮下方 */}
      {!cwd.trim() && <p className="new-hint">{t("ui.Sidebar.enter_a_working_directory_first")}</p>}
    </form>
  );
}

// 新建表单的配置胶囊：""=跟随配置（可选回，建会话时不传该字段）；其余同会话输入框底栏。
function NewConfigPills({
  options,
  selected,
  onChange,
}: {
  options: DriverConfigOption[];
  selected: Partial<Record<ConfigOptionId, string>>;
  onChange: Dispatch<SetStateAction<Partial<Record<ConfigOptionId, string>>>>;
}) {
  const modelOptions = configOptionsForModel(options, selected.model);
  const build = (option: DriverConfigOption) => {
    // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它
    const followLabel = option.values.find((v) => v.value === null)?.label ?? t("ui.common.use_configuration");
    const group: MenuGroup = {
      id: option.id,
      title: option.name,
      selected: selected[option.id] ?? "",
      slider: option.id === "effort",
      items: [
        { value: "", label: followLabel },
        ...option.values
          .filter((v): v is { value: string; label: string } => v.value !== null)
          .map((v) => ({ value: v.value, label: v.label })),
      ],
      onSelect: (value) => onChange((prev) => {
        if (option.id !== "model") return { ...prev, [option.id]: value };
        const patch = modelConfigPatch(options, prev, value || null);
        return { ...prev, model: value, ...(patch.effort === null ? { effort: "" } : {}) };
      }),
    };
    return { group, text: pillText(option, selected[option.id]) };
  };
  const byId = (id: ConfigOptionId) => modelOptions.find((o) => o.id === id);
  const main = [byId("model"), byId("effort")].filter((o): o is DriverConfigOption => Boolean(o)).map(build);
  const perm = byId("permissionMode");
  return (
    <ConfigPills
      main={main}
      perm={perm ? build(perm) : null}
      permMode={selected.permissionMode || perm?.default || ""}
      placement="down"
    />
  );
}
