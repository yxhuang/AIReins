import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AgentKind, ConfigOptionId, DriverConfigOption, SessionRecord } from "../types";
import { relativeTime, sessionTitle } from "../format";
import { isInlineSvg } from "../pages";
import type { CreateSessionInput } from "../api";
import { store, type Store } from "../store";
import { useStore } from "../useStore";
import { SettingsMenu } from "./SettingsMenu";
import { ConfigPills, type MenuGroup } from "./ConfigMenu";
import { pillText } from "../config-view";
import { DirectoryBrowser } from "./DirectoryBrowser";

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
};

export const STATUS_LABELS: Record<string, string> = {
  starting: "启动中",
  idle: "空闲",
  running: "忙",
  dead: "已结束",
  error: "出错",
};

/** 五状态一句「你现在可以……」说明：左栏状态文字与会话头的 hover title 共用（SessionView 也导入）。 */
export const STATUS_HINTS: Record<string, string> = {
  starting: "启动中：会话正在拉起 agent 进程。你现在可以等它就绪，或切去别的会话。",
  idle: "空闲：agent 就绪。你现在可以发消息、用 / 命令或 @ 引用文件。",
  running: "忙：agent 正在执行。你现在可以继续发消息，或点「中断」停掉当前执行。",
  error: "出错：会话遇到错误。你现在可以看错误条里的原因，或「新建会话并续接」恢复上下文。",
  dead: "已结束：进程已退出。你现在可以「新建会话并续接」，或点行右 × 从工作台移除（原生记录保留）。",
};

const CWD_STORAGE_KEY = "workbench-last-cwd";

const selectSessions = (value: Store) => value.sessions;
const selectNow = (value: Store) => value.now;
const selectMeta = (value: Store) => value.meta;
const selectHistoryOpen = (value: Store) => value.historyOpen;
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
  /** meta.capabilities.terminal === true 才显示终端入口（按请求入口由后端计算） */
  terminalCapable: boolean;
  termOpen: boolean;
  onToggleTerm: () => void;
}

export function Sidebar({ collapsed, onToggle, newOpen, onNewOpenChange, terminalCapable, termOpen, onToggleTerm }: SidebarProps) {
  const sessionRecords = useStore(selectSessions);
  const now = useStore(selectNow);
  const currentId = useStore(selectCurrentId);
  // pendingGates 是可变 Map；用可比较的原始字符串捕获“总数相同但分布换了会话”的变化。
  useStore(selectPendingSignature);
  const [deadExpanded, setDeadExpanded] = useState(false);
  // 稳定排序：按 createdAt 倒序（最新建的在最上），行序不随事件流抖动（此前按 lastActivityAt，正要点的那行会被挤走）。
  const byCreated = (a: SessionRecord, b: SessionRecord) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt);
  // 有未决闸门的会话抽到顶部「等待处理」区（天然总览）；dead 会话沉底折叠。
  // 防御性兜底：万一 dead 会话仍带未决计数，也只进等待处理区——未决闸门绝不许被折叠藏起。
  const waiting = sessionRecords.filter((s) => store.pendingCount(s.id) > 0).sort(byCreated);
  const active = sessionRecords
    .filter((s) => store.pendingCount(s.id) === 0 && s.status !== "dead")
    .sort(byCreated);
  const dead = sessionRecords
    .filter((s) => store.pendingCount(s.id) === 0 && s.status === "dead")
    .sort(byCreated);
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
        pending={store.pendingCount(session.id)}
        active={session.id === currentId}
        now={now}
      />
    </li>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">workbench</span>
        {/* Chrome --app 窗口和主屏幕 PWA 没有地址栏和刷新键 */}
        <button
          type="button"
          className="icon-btn sidebar-reload"
          title="刷新页面"
          aria-label="刷新页面"
          onClick={() => location.reload()}
        >
          ↻
        </button>
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
          className="icon-btn sidebar-toggle"
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
            aria-expanded={newOpen}
            onClick={() => onNewOpenChange(!newOpen)}
          >
            {/* 收起即卸载表单、丢掉未提交的输入，所以叫「取消」而不是「收起」 */}
            {newOpen ? "× 取消新建" : "+ 新建会话"}
          </button>
          {newOpen && <NewSessionForm onDone={() => onNewOpenChange(false)} />}
          <ul className="session-list">
            {waiting.length > 0 && (
              // 分区标题复用 .page-nav-title 的中性小字语言；暖色仍只出现在行内闸门徽标上
              <li className="page-nav-title" role="presentation">
                等待处理（{waiting.length}）
              </li>
            )}
            {waiting.map(renderRow)}
            {active.map(renderRow)}
            {dead.length > 0 && (
              <li>
                <button
                  type="button"
                  className="session-dead-toggle"
                  aria-expanded={deadExpanded}
                  title={deadExpanded ? "收起已结束会话" : "展开已结束会话"}
                  onClick={() => setDeadExpanded((v) => !v)}
                >
                  {deadExpanded ? "▾" : "▸"} {dead.length} 个已结束会话
                </button>
              </li>
            )}
            {deadExpanded && dead.map(renderRow)}
            {totalSessions === 0 && <li className="session-list-empty">还没有会话</li>}
          </ul>
        </>
      )}
      <div className="sidebar-foot">
        <HistoryNav collapsed={collapsed} />
        <PageNav collapsed={collapsed} />
        {terminalCapable && (
          <TerminalNav collapsed={collapsed} open={termOpen} onToggle={onToggleTerm} />
        )}
        <SettingsMenu />
      </div>
    </aside>
  );
}

/** 左栏底部「终端」入口（页面分区下方、齿轮上方，同一套分区语言；收起态只显图标）。 */
function TerminalNav({
  collapsed,
  open,
  onToggle,
}: {
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <nav className="page-nav" aria-label="终端">
      <button
        type="button"
        className={`page-nav-item${open ? " active" : ""}`}
        title="终端（Ctrl+`）：工作区级内置终端，切会话不影响"
        aria-label="终端"
        aria-pressed={open}
        onClick={onToggle}
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
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <polyline points="6 9 9 12 6 15" />
            <line x1="12" y1="15" x2="18" y2="15" />
          </svg>
        </span>
        {!collapsed && <span className="page-nav-name">终端</span>}
      </button>
    </nav>
  );
}

/** 左栏底部「历史会话」入口（页面分区上方，同一套分区语言；收起态只显图标）。 */
function HistoryNav({ collapsed }: { collapsed: boolean }) {
  const historyOpen = useStore(selectHistoryOpen);
  return (
    <nav className="page-nav" aria-label="历史会话">
      <button
        type="button"
        className={`page-nav-item${historyOpen ? " active" : ""}`}
        title="历史会话：浏览三家 CLI 自己保存的历史会话并导入续接"
        aria-label="历史会话"
        onClick={() => store.navigateHistory()}
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
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            <polyline points="12 7 12 12 15.5 14" />
          </svg>
        </span>
        {!collapsed && <span className="page-nav-name">历史会话</span>}
      </button>
    </nav>
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

/** 左栏底部「页面」分区（齿轮上方）：来自 /api/pages，未知类型跳过并给小字提示。 */
function PageNav({ collapsed }: { collapsed: boolean }) {
  const pages = useStore((value) => value.pages);
  const skippedPages = useStore((value) => value.skippedPages);
  const currentPageId = useStore((value) => value.currentPageId);
  if (pages.length === 0 && skippedPages.length === 0) return null;
  return (
    <nav className="page-nav" aria-label="扩展页面">
      {!collapsed && <div className="page-nav-title">页面</div>}
      {pages.map((page) => (
        <button
          key={page.id}
          type="button"
          className={`page-nav-item${currentPageId === page.id ? " active" : ""}`}
          title={collapsed ? page.name : page.description || page.name}
          aria-label={page.name}
          onClick={() => store.navigatePage(page.id)}
        >
          <PageIcon icon={page.icon} />
          {!collapsed && <span className="page-nav-name">{page.name}</span>}
        </button>
      ))}
      {!collapsed && skippedPages.length > 0 && (
        <p className="page-nav-skipped">
          已跳过 {skippedPages.length} 个暂不支持的页面类型（
          {[...new Set(skippedPages.map((p) => p.type))].join("、")}）
        </p>
      )}
    </nav>
  );
}

function SessionRow({
  session,
  pending,
  active,
  now,
}: {
  session: SessionRecord;
  pending: number;
  active: boolean;
  now: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // 主回合已结束但还有后台任务（委派的 codex 等）在跑：仍算「正在工作」
  const backgroundBusy = session.status === "idle" && (session.backgroundTasks?.length ?? 0) > 0;
  const [error, setError] = useState<string | null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const data = store.data.get(session.id);
  const title = sessionTitle(session, data?.events);

  // 进入确认态把焦点收进行内按钮：默认落「取消」，连按 Enter 不会误删
  useEffect(() => {
    if (confirming) cancelBtnRef.current?.focus();
  }, [confirming]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.remove(session.id);
      // 成功后该行随列表一起卸载，无需清状态
    } catch (e) {
      // 失败留在确认态：错误就地显示，可重试或取消
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const cancelConfirm = () => {
    setConfirming(false);
    // 焦点还给 ×（等下一轮渲染后按钮重新挂载）
    requestAnimationFrame(() => deleteBtnRef.current?.focus());
  };

  if (confirming) {
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
        <p className="session-confirm-text">
          从工作台移除此会话？{AGENT_LABELS[session.agent]} 自己的对话记录不会被删除。
          {running && "该会话仍在运行，移除会停止它。"}
        </p>
        {error && <p className="session-confirm-error">{error}</p>}
        <div className="session-confirm-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "移除中…" : "确认删除"}
          </button>
          <button
            type="button"
            className="btn"
            ref={cancelBtnRef}
            disabled={busy}
            title="取消（Esc）"
            onClick={cancelConfirm}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="session-item">
      <button
        type="button"
        className={`session-row agent-${session.agent}${
          active ? " active" : ""
        }${session.status === "dead" ? " dead" : ""}`}
        onClick={() => store.navigate(session.id)}
      >
        <span className="row-title-line">
          <span className="row-title">{title}</span>
          {pending > 0 && (
            <span className="gate-badge" title={`${pending} 个闸门等待处理`}>
              {pending}
            </span>
          )}
        </span>
        <span className="row-meta">
          <span className={`status-dot status-${pending > 0 ? "needs-user" : backgroundBusy ? "running" : session.status}`} />
          {session.riskyMode && (
            <span className="risky-mark" title="该会话已关闭 agent 主动询问">
              !
            </span>
          )}
          <span
            className="row-meta-text"
            title={backgroundBusy
              ? `后台任务：${session.backgroundTasks!.map((task) => task.description || task.type).join("；")}`
              : STATUS_HINTS[session.status] ?? session.status}
          >
            {AGENT_LABELS[session.agent]} · {backgroundBusy ? `后台 ${session.backgroundTasks!.length} 个任务` : STATUS_LABELS[session.status] ?? session.status} · {relativeTime(session.lastActivityAt, now)}
          </span>
        </span>
      </button>
      {/* 删除入口在行外右侧：永不挤占/遮挡行内右侧的闸门徽标（徽标优先级更高） */}
      <button
        type="button"
        className="row-delete"
        ref={deleteBtnRef}
        title={`从工作台移除（${AGENT_LABELS[session.agent]} 的对话记录不会被删除）`}
        aria-label={`移除会话 ${title}`}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

function NewSessionForm({ onDone }: { onDone: () => void }) {
  const meta = useStore(selectMeta);
  // 会话列表可能在表单挂载后才到；保留该订阅以触发 cwd 三级回退的补填 effect。
  useStore(selectSessions);
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
  const [browseOpen, setBrowseOpen] = useState(false);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);
  // 三个配置下拉的已选值；"" = 跟随配置（不传该字段）。切 agent 时整体重置。
  const [configSel, setConfigSel] = useState<Partial<Record<ConfigOptionId, string>>>({});
  const options = meta?.drivers[agent]?.options ?? [];

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
    // 不做建会话前快照（2026-09-30 用户定，ROADMAP P1-8）：显式 skip，后端默认值仍是 auto
    const input: CreateSessionInput = {
      snapshot: "skip",
      agent,
      cwd: cwd.trim(),
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
      <div className="new-field">
        <label htmlFor="new-session-cwd">工作目录（绝对路径）</label>
        <div className="cwd-input-row">
          <input
            id="new-session-cwd"
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/home/you/project"
            className="mono"
            required
          />
          <button ref={browseButtonRef} type="button" className="btn" onClick={() => setBrowseOpen(true)}>浏览…</button>
        </div>
      </div>
      {/* 首条消息 + 配置胶囊：与会话输入框同一形态（胶囊直接显示当前值，点开选） */}
      <div className="composer-box">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          aria-label="首条消息（可选）"
          placeholder="首条消息（可选，创建后立即发给 agent）"
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
        title={!cwd.trim() ? "请先填写工作目录" : undefined}
      >
        {busy ? "创建中…" : "创建并进入"}
      </button>
      {/* 禁用原因不只靠 title tooltip：直接写在按钮下方 */}
      {!cwd.trim() && <p className="new-hint">请先填写工作目录</p>}
      {browseOpen && (
        <DirectoryBrowser
          initialPath={cwd}
          onSelect={(path) => { setCwd(path); setBrowseOpen(false); requestAnimationFrame(() => browseButtonRef.current?.focus()); }}
          onClose={() => { setBrowseOpen(false); requestAnimationFrame(() => browseButtonRef.current?.focus()); }}
        />
      )}
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
  const build = (option: DriverConfigOption) => {
    // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它
    const followLabel = option.values.find((v) => v.value === null)?.label ?? "跟随配置";
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
      onSelect: (value) => onChange((prev) => ({ ...prev, [option.id]: value })),
    };
    return { group, text: pillText(option, selected[option.id]) };
  };
  const byId = (id: ConfigOptionId) => options.find((o) => o.id === id);
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
