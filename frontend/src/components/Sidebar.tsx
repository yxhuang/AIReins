import { useState } from "react";
import type { AgentKind } from "../types";
import { relativeTime, sessionTitle } from "../format";
import { store } from "../store";
import { useStore } from "../useStore";
import { SettingsMenu } from "./SettingsMenu";

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
};

const STATUS_LABELS: Record<string, string> = {
  starting: "启动中",
  idle: "空闲",
  running: "忙",
  dead: "已结束",
  error: "出错",
};

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
}

export function Sidebar({ collapsed, onToggle, newOpen, onNewOpenChange }: SidebarProps) {
  const store = useStore();
  const sessions = [...store.sessions].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
  // 收起态仍要能看到全局待审批压力：全部会话未决闸门总数。
  const totalPending = sessions.reduce((sum, session) => sum + store.pendingCount(session.id), 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">workbench</span>
        {collapsed && totalPending > 0 && (
          <button
            type="button"
            className="gate-badge gate-badge-btn"
            title={`${totalPending} 个闸门等待处理，点击展开会话列表`}
            onClick={onToggle}
          >
            {totalPending}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title={collapsed ? "展开会话列表" : "收起会话列表"}
          onClick={onToggle}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {!collapsed && (
        <>
          <button
            type="button"
            className="btn btn-new"
            onClick={() => onNewOpenChange(!newOpen)}
          >
            + 新建会话
          </button>
          {newOpen && <NewSessionForm onDone={() => onNewOpenChange(false)} />}
          <ul className="session-list">
            {sessions.map((session) => {
              const pending = store.pendingCount(session.id);
              const data = store.data.get(session.id);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`session-row agent-${session.agent}${
                      session.id === store.currentId ? " active" : ""
                    }${session.status === "dead" ? " dead" : ""}`}
                    onClick={() => store.navigate(session.id)}
                  >
                    <span className="row-title-line">
                      <span className="row-title">{sessionTitle(session, data?.events)}</span>
                      {pending > 0 && (
                        <span className="gate-badge" title={`${pending} 个闸门等待处理`}>
                          {pending}
                        </span>
                      )}
                    </span>
                    <span className="row-meta">
                      <span className={`status-dot status-${session.status}`} />
                      <span className="row-meta-text">
                        {AGENT_LABELS[session.agent]} · {STATUS_LABELS[session.status] ?? session.status} · {relativeTime(session.lastActivityAt, store.now)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {sessions.length === 0 && <li className="session-list-empty">还没有会话</li>}
          </ul>
        </>
      )}
      <div className="sidebar-foot">
        <SettingsMenu />
      </div>
    </aside>
  );
}

function NewSessionForm({ onDone }: { onDone: () => void }) {
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [cwd, setCwd] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await store.create({
        agent,
        cwd: cwd.trim(),
        ...(message.trim() ? { initialMessage: message.trim() } : {}),
      });
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
      className="new-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="new-agents" role="radiogroup" aria-label="选择 agent">
        {(Object.keys(AGENT_LABELS) as AgentKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`new-agent agent-${kind}${agent === kind ? " selected" : ""}`}
            onClick={() => setAgent(kind)}
          >
            {AGENT_LABELS[kind]}
          </button>
        ))}
      </div>
      <label className="new-field">
        <span>工作目录（绝对路径）</span>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/home/you/project"
          className="mono"
          required
        />
      </label>
      <label className="new-field">
        <span>首条消息（可选）</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="创建后立即发给 agent"
        />
      </label>
      {error && <p className="new-error">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !cwd.trim()}>
        {busy ? "创建中…" : "创建并进入"}
      </button>
    </form>
  );
}
