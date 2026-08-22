import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKind, HistoryPreview, HistorySession } from "../types";
import { fetchHistory, fetchHistoryPreview } from "../api";
import {
  findImportedSession,
  filterBySource,
  SOURCE_FILTER_LABELS,
  SOURCE_LABELS,
  type SourceFilter,
} from "../history";
import { relativeTime } from "../format";
import { useStore } from "../useStore";

const AGENTS: AgentKind[] = ["claude", "codex", "kimi"];

/** 每页条数：466 条全量下约 3~4 页「加载更多」，不引虚拟滚动库。 */
const PAGE_SIZE = 150;

/** 关键词搜索防抖（spec：~250ms）。 */
const SEARCH_DEBOUNCE_MS = 250;

interface ListState {
  items: HistorySession[];
  nextCursor?: string;
  truncated: boolean;
  skipped: number;
  discovered: number;
}

type ListPhase = "loading" | "ready" | "error";

type PreviewState =
  | { phase: "loading" }
  | { phase: "done"; preview: HistoryPreview }
  | { phase: "error"; message: string };

/**
 * 历史会话浏览视图（#/history）：只读列出三家 CLI 自己保存的历史会话，
 * 预览确认后「导入并续接」（就地续接，不是分叉——代价写在按钮上方）。
 * 分页用 nextCursor +「加载更多」；truncated/skipped 都渲染成中性小字说明，不当错误。
 */
export function HistoryView() {
  const store = useStore();
  const [agentFilter, setAgentFilter] = useState<AgentKind | "">("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<ListState>({
    items: [],
    truncated: false,
    skipped: 0,
    discovered: 0,
  });
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 请求代次：agent/q 变化时自增，过期响应（含旧查询的「加载更多」）直接丢弃 */
  const reqGen = useRef(0);

  // 搜索防抖：输入停 250ms 后才真正打到 q 触发重新拉取
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);

  const load = useCallback(
    async (cursor?: string) => {
      const gen = cursor ? reqGen.current : ++reqGen.current;
      if (cursor) setLoadingMore(true);
      else {
        setPhase("loading");
        setListError(null);
      }
      try {
        const data = await fetchHistory({
          ...(agentFilter ? { agent: agentFilter } : {}),
          ...(q ? { q } : {}),
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        if (gen !== reqGen.current) return; // 过期响应丢弃
        setList((prev) => ({
          items: cursor ? [...prev.items, ...data.sessions] : data.sessions,
          ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
          truncated: data.truncated,
          skipped: data.skipped,
          discovered: data.discovered,
        }));
        setPhase("ready");
        setListError(null);
      } catch (error) {
        if (gen !== reqGen.current) return;
        const message = error instanceof Error ? error.message : String(error);
        if (cursor) setListError(message);
        else {
          setPhase("error");
          setListError(message);
        }
      } finally {
        if (gen === reqGen.current && cursor) setLoadingMore(false);
      }
    },
    [agentFilter, q],
  );

  // agent/q 变化 → 从头重拉（cursor 作废）；来源筛选是前端侧过滤，不重拉
  useEffect(() => {
    void load();
  }, [load]);

  const selected = list.items.find(
    (item) => `${item.agent}:${item.nativeSessionId}` === selectedKey,
  );
  // 来源筛选只作用于已加载条目（接口没有 source 参数）
  const visible = filterBySource(list.items, sourceFilter);

  return (
    <div className="history-view">
      <section className="history-list-pane" aria-label="历史会话列表">
        <header className="history-head">
          <h1 className="history-title">历史会话</h1>
          <p className="history-sub">
            三家 CLI 自己保存的历史会话（只读）。选一个预览，确认后可以导入并续接。
          </p>
        </header>
        <div className="history-filters">
          <div className="history-filter-group" role="group" aria-label="按 agent 筛选">
            <button
              type="button"
              className={`history-chip${agentFilter === "" ? " selected" : ""}`}
              onClick={() => setAgentFilter("")}
            >
              全部
            </button>
            {AGENTS.map((agent) => (
              <button
                key={agent}
                type="button"
                className={`history-chip agent-${agent}${agentFilter === agent ? " selected" : ""}`}
                onClick={() => setAgentFilter(agent)}
              >
                {agent}
              </button>
            ))}
          </div>
          <div className="history-filter-group" role="group" aria-label="按来源筛选">
            {(["all", "interactive", "workbench"] as SourceFilter[]).map((source) => (
              <button
                key={source}
                type="button"
                className={`history-chip${sourceFilter === source ? " selected" : ""}`}
                onClick={() => setSourceFilter(source)}
              >
                {source === "all" ? "全部来源" : SOURCE_FILTER_LABELS[source]}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="history-search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索标题或目录…"
            aria-label="搜索历史会话"
          />
        </div>
        <p className="history-meta">
          已加载 {list.items.length} 条 · 共发现 {list.discovered} 个候选
          {list.skipped > 0 && ` · ${list.skipped} 个损坏或不可读的候选已跳过`}
          {list.truncated && " · 扫描达到时间/数量上限，结果可能不完整，可用关键词缩小范围"}
          {sourceFilter !== "all" && " · 来源筛选只作用于已加载的条目"}
        </p>
        {phase === "error" ? (
          <div className="history-list-status">
            <p className="history-error" role="alert">
              加载失败：{listError}
            </p>
            <button type="button" className="btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : (
          <>
            <ul className="history-list">
              {visible.map((item) => (
                <li key={`${item.agent}:${item.nativeSessionId}`}>
                  <HistoryRow
                    item={item}
                    active={selectedKey === `${item.agent}:${item.nativeSessionId}`}
                    imported={findImportedSession(store.sessions, item) !== undefined}
                    now={store.now}
                    onSelect={() =>
                      setSelectedKey(`${item.agent}:${item.nativeSessionId}`)
                    }
                  />
                </li>
              ))}
              {phase === "ready" && visible.length === 0 && (
                <li className="history-list-empty">
                  {list.items.length === 0 ? "没有匹配的历史会话" : "已加载条目里没有该来源的会话"}
                </li>
              )}
              {phase === "loading" && <li className="history-list-empty">加载中…</li>}
            </ul>
            <div className="history-more">
              {list.nextCursor ? (
                <button
                  type="button"
                  className="btn"
                  disabled={loadingMore}
                  onClick={() => void load(list.nextCursor)}
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              ) : (
                phase === "ready" &&
                list.items.length > 0 && <span className="history-meta">没有更多了</span>
              )}
              {listError && phase === "ready" && (
                <span className="history-error" role="alert">
                  {listError}
                </span>
              )}
            </div>
          </>
        )}
      </section>
      <HistoryPreviewPane item={selected} />
    </div>
  );
}

function HistoryRow({
  item,
  active,
  imported,
  now,
  onSelect,
}: {
  item: HistorySession;
  active: boolean;
  imported: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`history-row agent-${item.agent}${active ? " active" : ""}`}
      onClick={onSelect}
    >
      <span className="history-row-line1">
        <span className="history-row-title" title={item.title}>
          {item.title}
        </span>
        <span className={`source-badge source-${item.source}`}>
          {SOURCE_LABELS[item.source]}
        </span>
      </span>
      <span className="history-row-cwd mono" title={item.cwd}>
        {item.cwd}
      </span>
      <span className="history-row-meta">
        {item.agent} · {relativeTime(item.lastActivityAt, now)}
        {imported && <span className="imported-badge">已在工作台中</span>}
      </span>
    </button>
  );
}

function HistoryPreviewPane({ item }: { item: HistorySession | undefined }) {
  const store = useStore();
  const [state, setState] = useState<PreviewState | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    setImporting(false);
    setImportError(null);
    if (!item) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    fetchHistoryPreview(item.agent, item.nativeSessionId).then(
      (preview) => {
        if (!cancelled) setState({ phase: "done", preview });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item) {
    return (
      <aside className="history-preview-pane" aria-label="会话预览">
        <div className="history-preview-empty">从左侧选一个会话查看预览</div>
      </aside>
    );
  }

  const imported = findImportedSession(store.sessions, item);

  const doImport = async () => {
    if (importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const session = await store.create({
        agent: item.agent,
        cwd: item.cwd,
        resumeSessionId: item.nativeSessionId,
      });
      store.navigate(session.id);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      setImporting(false);
    }
  };

  return (
    <aside className="history-preview-pane" aria-label="会话预览">
      <div className="history-preview-head">
        <h2 className="history-preview-title">{item.title}</h2>
        <p className="history-preview-meta">
          {item.agent} · {SOURCE_LABELS[item.source]} ·{" "}
          {relativeTime(item.lastActivityAt, store.now)}
        </p>
        <p className="history-preview-id mono" title={item.nativeSessionId}>
          {item.nativeSessionId}
        </p>
        <p className="history-preview-cwd mono" title={item.cwd}>
          {item.cwd}
        </p>
      </div>
      <div className="history-preview-body">
        {state?.phase === "loading" && <p className="history-note">读取预览中…</p>}
        {state?.phase === "error" && (
          <p className="history-error" role="alert">
            预览读取失败：{state.message}
          </p>
        )}
        {state?.phase === "done" && (
          <>
            {state.preview.messages.length === 0 ? (
              <p className="history-note">
                该会话暂无可预览的消息（原生消息记录缺失或为空）。
              </p>
            ) : (
              <ul className="history-messages">
                {state.preview.messages.map((message, index) => (
                  <li key={index} className={`history-msg history-msg-${message.role}`}>
                    <span className="history-msg-role">
                      {message.role === "user" ? "用户" : "助手"}
                    </span>
                    <span className="history-msg-text">{message.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {state.preview.truncated && (
              <p className="history-note">
                仅显示开头若干条消息（预览只读取会话文件头部），完整内容在原生会话文件中。
              </p>
            )}
          </>
        )}
      </div>
      <div className="history-actions">
        {imported ? (
          <>
            <p className="history-note">该会话已在工作台中，无需重复导入。</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => store.navigate(imported.id)}
            >
              跳转过去
            </button>
          </>
        ) : (
          <>
            {/* 代价说明不能省：就地续接，不是分叉；措辞中性如实 */}
            <p className="history-note">
              这是就地续接，不是分叉：导入后，工作台里跑的新回合会追写进这个原生会话文件；
              其中 Claude 会话里这些回合以 sdk-cli 身份落盘，与你交互式跑出的回合在文件里身份不同。
            </p>
            {importError && (
              <p className="history-error" role="alert">
                导入失败：{importError}
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={importing}
              onClick={() => void doImport()}
            >
              {importing ? "导入中…" : "导入并续接"}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
