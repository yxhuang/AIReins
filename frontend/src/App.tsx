import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { PageView } from "./components/PageView";
import { HistoryView } from "./components/HistoryView";
import { useStore } from "./useStore";

export function App() {
  const store = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const current = store.currentId ? store.session(store.currentId) : undefined;
  const currentPage = store.currentPageId
    ? store.pages.find((p) => p.id === store.currentPageId)
    : undefined;

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        newOpen={newOpen}
        onNewOpenChange={setNewOpen}
      />
      <main className="main">
        {store.historyOpen ? (
          <HistoryView />
        ) : currentPage ? (
          <PageView key={currentPage.id} page={currentPage} />
        ) : store.currentPageId ? (
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
      {store.lastError && (
        <div className="toast" role="alert">
          <span>{store.lastError}</span>
          <button type="button" className="toast-close" onClick={() => store.dismissError()}>
            知道了
          </button>
        </div>
      )}
      {/* 删除成功一次性提示：说清原生记录仍在；路径有则等宽小字附上 */}
      {store.removalNotice && (
        <div className="toast removal-notice" role="status">
          <span>{store.removalNotice.message}</span>
          {store.removalNotice.path && (
            <code className="mono removal-path">{store.removalNotice.path}</code>
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
