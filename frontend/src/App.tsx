import { PRODUCT_NAME, t } from "./i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isTerminalToggleKey } from "./terminal";
import { NewSessionForm } from "./components/NewSessionForm";
import { Sidebar } from "./components/Sidebar";
import { MobilePanelLauncher, PanelActions } from "./components/PanelActions";
import { DispatchPanel } from "./components/DispatchPanel";
import { FilePanel } from "./components/FilePanel";
import { SessionView } from "./components/SessionView";
import { HistoryPreviewPane } from "./components/HistoryView";
// xterm 体积大（~300KB），第一次打开终端才按需加载，别拖慢手机首屏
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
import { sessionTitle } from "./format";
import { store, type Store } from "./store";
import { shallowEqual, useStore } from "./useStore";
import { workbenchWindowTitle } from "./host-connections";
import { CodexResetDialog } from "./components/CodexResets";
import { BrandMark } from "./components/HostSwitcher";

const selectCurrentSession = (value: Store) =>
  value.currentId ? value.session(value.currentId) : undefined;
// 带 sessionId 的错误解析出「agent · 会话标题」上下文（纯字符串，selector 比较友好）；
// 会话已不存在时返回 undefined，toast 退化为不可点击的纯文本。
const selectErrorContext = (value: Store) => {
  const error = value.lastError;
  if (!error?.sessionId) return undefined;
  const session = value.session(error.sessionId);
  if (!session) return undefined;
  return `${session.agent} · ${sessionTitle(session, value.data.get(error.sessionId)?.events)}`;
};
const selectAppUi = (value: Store) =>
  [
    value.dispatchesOpen,
    value.historyOpen,
    value.currentPageId,
    value.historySelection,
    value.lastError,
    selectErrorContext(value),
    value.removalNotice,
    value.newSessionOpen,
  ] as const;
const selectPendingTotal = (value: Store) =>
  value.sessions.reduce((sum, session) => sum + value.pendingCount(session.id), 0);

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [returnToSession, setReturnToSession] = useState(false);
  const usagePage = useStore((value) => value.pages.find((page) => page.id === "ai-usage"));
  // 终端面板：隐藏 = CSS display:none，组件一旦挂载就常驻（xterm 实例与 WS 连接不丢）
  const termOpen = useStore((value) => value.termOpen);
  const filesOpen = useStore((value) => value.filesOpen);
  const [termMounted, setTermMounted] = useState(false);
  useEffect(() => {
    if (termOpen) setTermMounted(true);
  }, [termOpen]);
  // 能力位按请求入口由后端计算（本机恒 true，远程看 remote.json）；false 时入口与面板都不出现
  const terminalCapable = useStore((value) => value.meta?.capabilities.terminal === true);
  useEffect(() => {
    if (!terminalCapable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalToggleKey(event)) return;
      event.preventDefault();
      if (!event.repeat) store.setTerminalOpen(!store.termOpen);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [terminalCapable]);
  const wasTermOpen = useRef(false);
  useEffect(() => {
    const closed = wasTermOpen.current && !termOpen;
    wasTermOpen.current = termOpen;
    if (!closed) return;
    const raf = requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".main .composer-box textarea:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [termOpen]);
  const current = useStore(selectCurrentSession);
  const [dispatchesOpen, historyOpen, currentPageId, historySelection, lastError, errorContext, removalNotice, newSessionOpen] = useStore(
    selectAppUi,
    shallowEqual,
  );
  const pendingTotal = useStore(selectPendingTotal);
  // 手机主区是否有内容独立于右侧面板，关闭后回到原会话或主页。
  const hasMain = Boolean(historySelection || ((newSessionOpen || current) && !historyOpen && !currentPageId));
  useEffect(() => {
    if (historyOpen || currentPageId) setCollapsed(false);
  }, [historyOpen, currentPageId]);
  useEffect(() => {
    if (!currentPageId) setReturnToSession(false);
  }, [currentPageId]);

  // 标签页标题带上全局未决闸门总数：切走也能看到「有闸门在等你」。
  // 必须写在组件里而不是 store.notify()——store.ts 会被纯 node 测试 import，没有 document。
  useEffect(() => {
    document.title = workbenchWindowTitle(window.location.href, pendingTotal);
  }, [pendingTotal]);

  return (
    <div
      className={`app${collapsed ? " sidebar-collapsed" : ""}${hasMain ? " has-main" : ""}${termOpen || dispatchesOpen || filesOpen ? " term-open" : ""}`}
    >
      <CodexResetDialog />
      <Sidebar
        collapsed={collapsed}
        onToggle={() => {
          if (!collapsed && (historyOpen || currentPageId)) store.closeSidebarPanel();
          setCollapsed((v) => !v);
        }}
        returnToSession={returnToSession}
        mobileActions={hasMain ? undefined : <MobilePanelLauncher />}
      />
      {/* 主会话保持挂载，三个面板互斥占用右侧位置；窄屏沿用终端全屏规则。 */}
      <div className={`workspace${termOpen || dispatchesOpen || filesOpen ? " term-open" : ""}`}>
        <main className="main">
          {historySelection ? (
            <HistoryPreviewPane item={historySelection} onBack={() => store.backToHistoryList()} />
          ) : current ? (
            <SessionView key={current.id} session={current} mobileTail={pendingTotal > 0 ? (
              <span className="gate-badge" title={t("core.000", { p0: pendingTotal })}>{pendingTotal}</span>
            ) : undefined} usage={usagePage && { icon: usagePage.icon, open: () => {
              setReturnToSession(true);
              setCollapsed(false);
              store.navigatePage(usagePage.id);
            } }} />
          ) : (
            <section className="welcome-view">
            <div className="view-panel-actions">
              <button type="button" className="btn mobile-round mobile-back new-session-back"
                aria-label={t("ui.SessionView.back_to_session_list")} onClick={() => store.backFromSession()}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
              <PanelActions />
            </div>
            <div className="empty-state">
              <NewSessionForm>
                <h1 className="empty-logo" aria-label={PRODUCT_NAME}>
                  <span className="empty-logo-mark" aria-hidden="true"><BrandMark /></span>
                  <span className="empty-logo-line" aria-hidden="true" />
                  <span className="empty-logo-name" aria-hidden="true">{PRODUCT_NAME}</span>
                </h1>
                <p>{t("core.001")}</p>
              </NewSessionForm>
            </div>
            </section>
          )}
        </main>
        {dispatchesOpen && <DispatchPanel onClose={() => store.closeDispatches()} />}
        {filesOpen && <FilePanel key={`${current?.id ?? ""}:${current?.cwd ?? ""}`} onClose={() => store.setFilesOpen(false)} />}
        {terminalCapable && termMounted && (
          <Suspense fallback={null}>
            <TerminalPanel open={termOpen} onClose={() => store.setTerminalOpen(false)} />
          </Suspense>
        )}
      </div>
      {lastError && (
        <div className="toast" role="alert">
          {/* 带会话上下文的错误：整体是按钮，点击跳转到出错会话；无 sessionId 或会话已删则退化为纯文本 */}
          {lastError.sessionId && errorContext ? (
            <button
              type="button"
              className="toast-jump"
              title={t("core.003")}
              onClick={() => {
                store.navigate(lastError.sessionId!);
                store.dismissError();
              }}
            >
              {errorContext}：{lastError.message}
            </button>
          ) : (
            <span>{lastError.message}</span>
          )}
          <button type="button" className="toast-close" onClick={() => store.dismissError()}>{t("core.004")}</button>
        </div>
      )}
      {/* 按移除/彻底删除显示真实结果；保留的原生路径有则附上 */}
      {removalNotice && (
        <div className="toast removal-notice" role="status">
          <span>{removalNotice.message}</span>
          {removalNotice.path && (
            <code className="mono removal-path">{removalNotice.path}</code>
          )}
          <button
            type="button"
            className="toast-close"
            onClick={() => store.dismissRemovalNotice()}
          >{t("core.004")}</button>
        </div>
      )}
    </div>
  );
}
