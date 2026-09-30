import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isTerminalToggleKey } from "./terminal";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { PageView } from "./components/PageView";
import { HistoryView } from "./components/HistoryView";
// xterm 体积大（~300KB），第一次打开终端才按需加载，别拖慢手机首屏
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
import { sessionTitle } from "./format";
import { store, type Store } from "./store";
import { shallowEqual, useStore } from "./useStore";

const selectCurrentSession = (value: Store) =>
  value.currentId ? value.session(value.currentId) : undefined;
const selectCurrentPage = (value: Store) =>
  value.currentPageId
    ? value.pages.find((page) => page.id === value.currentPageId)
    : undefined;
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
    value.historyOpen,
    value.currentPageId,
    value.lastError,
    selectErrorContext(value),
    value.removalNotice,
  ] as const;
const selectPendingTotal = (value: Store) =>
  value.sessions.reduce((sum, session) => sum + value.pendingCount(session.id), 0);

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // 终端面板：隐藏 = CSS display:none，组件一旦挂载就常驻（xterm 实例与 WS 连接不丢）
  const [termOpen, setTermOpen] = useState(false);
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
      if (!event.repeat) setTermOpen((value) => !value);
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
  const currentPage = useStore(selectCurrentPage);
  const [historyOpen, currentPageId, lastError, errorContext, removalNotice] = useStore(
    selectAppUi,
    shallowEqual,
  );
  const pendingTotal = useStore(selectPendingTotal);
  // 手机窄屏下，列表和主区二选一：有内容要看（会话 / 页面 / 历史）时只显示主区。
  const hasMain = Boolean(historyOpen || currentPageId || current);

  // 标签页标题带上全局未决闸门总数：切走也能看到「有闸门在等你」。
  // 必须写在组件里而不是 store.notify()——store.ts 会被纯 node 测试 import，没有 document。
  useEffect(() => {
    document.title = pendingTotal > 0 ? `(${pendingTotal}) 个闸门待处理 · workbench` : "workbench";
  }, [pendingTotal]);

  return (
    <div
      className={`app${collapsed ? " sidebar-collapsed" : ""}${hasMain ? " has-main" : ""}${termOpen ? " term-open" : ""}`}
    >
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        newOpen={newOpen}
        onNewOpenChange={setNewOpen}
        terminalCapable={terminalCapable}
        termOpen={termOpen}
        onToggleTerm={() => setTermOpen((v) => !v)}
      />
      {/* .workspace 只包一层：.main 内部规则不动；终端开启时右侧追加分隔条 + 面板 */}
      <div className={`workspace${termOpen ? " term-open" : ""}`}>
        <main className="main">
          {hasMain && (
            <div className="mobile-topbar">
              <button type="button" className="btn" onClick={() => store.navigate(null)}>
                ‹ 会话列表
              </button>
              {pendingTotal > 0 && (
                <span className="gate-badge" title={`${pendingTotal} 个闸门等待处理`}>
                  {pendingTotal}
                </span>
              )}
            </div>
          )}
          {historyOpen ? (
            <HistoryView />
          ) : currentPage ? (
            <PageView key={currentPage.id} page={currentPage} />
          ) : currentPageId ? (
            <div className="empty-state">
              <h1>页面不存在</h1>
              <p>
                该页面可能已从 pages/ 移除或 manifest 失效——server 只在启动时扫描一次，
                改动需重启后生效。
              </p>
            </div>
          ) : current ? (
            <SessionView key={current.id} session={current} />
          ) : (
            <div className="empty-state">
              <h1>workbench</h1>
              <p>
                这里是三家 CLI agent（claude / codex / kimi）的调度台。
                左侧选一个会话，或新建一个开始。
              </p>
              <p className="empty-hint">
                暖色只出现在需要你处理的审批上——看到暖色，就说明有 agent 在等你拍板。
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setCollapsed(false);
                  setNewOpen(true);
                }}
              >
                新建会话
              </button>
            </div>
          )}
        </main>
        {terminalCapable && termMounted && (
          <Suspense fallback={null}>
            <TerminalPanel open={termOpen} onClose={() => setTermOpen(false)} />
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
              title="点击跳转到出错的会话"
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
          <button type="button" className="toast-close" onClick={() => store.dismissError()}>
            知道了
          </button>
        </div>
      )}
      {/* 删除成功一次性提示：说清原生记录仍在；路径有则等宽小字附上 */}
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
          >
            知道了
          </button>
        </div>
      )}
    </div>
  );
}
