import { useEffect, useRef, useState } from "react";
import type { AgentKind, ConfigOptionId } from "../types";
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

const CWD_STORAGE_KEY = "workbench-last-cwd";

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
                      {session.riskyMode && (
                        <span className="risky-mark" title="该会话已关闭 agent 主动询问">
                          !
                        </span>
                      )}
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
  const store = useStore();
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [cwd, setCwdState] = useState(pickInitialCwd);
  // 用户动过 cwd 输入框后不再自动预填（含故意清空）
  const cwdTouched = useRef(false);
  const setCwd = (value: string) => {
    cwdTouched.current = true;
    setCwdState(value);
  };
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 三个配置下拉的已选值；"" = 跟随配置（不传该字段）。切 agent 时整体重置。
  const [configSel, setConfigSel] = useState<Partial<Record<ConfigOptionId, string>>>({});
  const options = store.meta?.drivers[agent]?.options ?? [];

  // meta/会话列表可能晚于表单挂载到达：用户未动手且仍为空时补一次预填
  useEffect(() => {
    if (cwdTouched.current || cwd) return;
    const next = pickInitialCwd();
    if (next) setCwdState(next);
  });

  const submit = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    // 只把非默认（非「跟随配置」）的字段放进 config
    const config = Object.fromEntries(
      Object.entries(configSel).filter(([, value]) => value),
    );
    try {
      const session = await store.create({
        agent,
        cwd: cwd.trim(),
        ...(Object.keys(config).length > 0 ? { config } : {}),
        ...(message.trim() ? { initialMessage: message.trim() } : {}),
      });
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
            onClick={() => {
              setAgent(kind);
              // 选项随 agent 切换，已选值一并重置（别把 claude 的值发给 kimi）
              setConfigSel({});
            }}
          >
            {AGENT_LABELS[kind]}
          </button>
        ))}
      </div>
      {options.map((option) => {
        // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它
        const followLabel = option.values.find((v) => v.value === null)?.label ?? "跟随配置";
        return (
          <label className="new-field" key={option.id}>
            <span>{option.name}</span>
            <select
              value={configSel[option.id] ?? ""}
              onChange={(e) =>
                setConfigSel((prev) => ({ ...prev, [option.id]: e.target.value }))
              }
            >
              <option value="">{followLabel}</option>
              {option.values
                .filter((v): v is { value: string; label: string } => v.value !== null)
                .map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
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
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || !cwd.trim()}
        title={!cwd.trim() ? "请先填写工作目录" : undefined}
      >
        {busy ? "创建中…" : "创建并进入"}
      </button>
      {/* 禁用原因不只靠 title tooltip：直接写在按钮下方 */}
      {!cwd.trim() && <p className="new-hint">请先填写工作目录</p>}
    </form>
  );
}
