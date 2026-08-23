import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { PageView } from "./components/PageView";
import { HistoryView } from "./components/HistoryView";
import { store, type Store } from "./store";
import { shallowEqual, useStore } from "./useStore";

const selectCurrentSession = (value: Store) =>
  value.currentId ? value.session(value.currentId) : undefined;
const selectCurrentPage = (value: Store) =>
  value.currentPageId
    ? value.pages.find((page) => page.id === value.currentPageId)
    : undefined;
const selectAppUi = (value: Store) =>
  [
    value.historyOpen,
    value.currentPageId,
    value.lastError,
    value.removalNotice,
  ] as const;
const selectPendingTotal = (value: Store) =>
  value.sessions.reduce((sum, session) => sum + value.pendingCount(session.id), 0);

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const current = useStore(selectCurrentSession);
  const currentPage = useStore(selectCurrentPage);
  const [historyOpen, currentPageId, lastError, removalNotice] = useStore(
    selectAppUi,
    shallowEqual,
  );
  const pendingTotal = useStore(selectPendingTotal);

  // 标签页标题带上全局未决闸门总数：切走也能看到「有闸门在等你」。
  // 必须写在组件里而不是 store.notify()——store.ts 会被纯 node 测试 import，没有 document。
  useEffect(() => {
    document.title = pendingTotal > 0 ? `(${pendingTotal}) 个闸门待处理 · workbench` : "workbench";
  }, [pendingTotal]);

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        newOpen={newOpen}
        onNewOpenChange={setNewOpen}
      />
      <main className="main">
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
      {lastError && (
        <div className="toast" role="alert">
          <span>{lastError}</span>
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
