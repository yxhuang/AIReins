import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, HistorySession } from "../types";
import { fetchHistory } from "../api";
import {
  findImportedSession,
  filterBySource,
  SOURCE_FILTER_LABELS,
  SOURCE_LABELS,
  type SourceFilter,
} from "../history";
import { relativeTime, relativeTimeShort } from "../format";
import { AgentIcon } from "./AgentIcon";
import { PagedHistory } from "./ResumedHistory";
import { store, type Store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { PanelActions } from "./PanelActions";

const AGENTS: AgentKind[] = ["claude", "codex", "kimi"];

/** 每页条数：466 条全量下约 3~4 页「加载更多」，不引虚拟滚动库。 */
const PAGE_SIZE = 150;

/** 关键词搜索防抖（spec：~250ms）。 */
const SEARCH_DEBOUNCE_MS = 250;

// 代价说明在桌面完整展示；手机折叠两行，但详情里必须保留全文。
const IMPORT_NOTE = "这是就地续接，不是分叉：导入后，工作台里跑的新回合会追写进这个原生会话文件；工作台里跑的 Claude 回合以 VSCode 扩展身份落盘；工作台新建的 Claude 会话可在 VSCode/CLI 的 resume 列表里找到。";

/** 历史行无需跟随别处 running 会话的秒级 tick；30 秒粒度足够表达相对时间。 */
const selectHistoryNow = (value: Store) => Math.floor(value.now / 30_000) * 30_000;
const selectImportedSessionKeys = (value: Store) =>
  value.sessions
    .flatMap((session) =>
      session.nativeSessionId
        ? [`${session.agent}:${session.nativeSessionId}`]
        : [],
    )
    .sort();

interface ListState {
  items: HistorySession[];
  nextCursor?: string;
  truncated: boolean;
  skipped: number;
  empty: number;
  discovered: number;
}

type ListPhase = "loading" | "ready" | "error";

/**
 * 侧栏历史列表（#/history）：只读列出三家 CLI 自己保存的历史会话，
 * 预览确认后「导入并续接」（就地续接，不是分叉——代价写在按钮上方）。
 * 分页用 nextCursor +「加载更多」；扫描未完成时提示并沿游标重试，不当错误。
 */
export function HistoryView() {
  const importedSessionKeys = useStore(selectImportedSessionKeys, shallowEqual);
  const now = useStore(selectHistoryNow);
  const [agentFilter, setAgentFilter] = useState<AgentKind | "">("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<ListState>({
    items: [],
    truncated: false,
    skipped: 0,
    empty: 0,
    discovered: 0,
  });
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const selectedKey = useStore((value) => value.historySelection
    ? `${value.historySelection.agent}:${value.historySelection.nativeSessionId}` : null);
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
        setLoadingMore(false); // 旧查询的翻页作废，别让按钮一直禁用
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
          empty: cursor ? prev.empty + data.empty : data.empty,
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

  const importedKeys = useMemo(
    () => new Set(importedSessionKeys),
    [importedSessionKeys],
  );
  // 来源筛选只作用于已加载条目（接口没有 source 参数）
  const visible = useMemo(
    () => filterBySource(list.items, sourceFilter),
    [list.items, sourceFilter],
  );
  const selectRow = useCallback((key: string) => {
    const item = list.items.find((row) => `${row.agent}:${row.nativeSessionId}` === key);
    if (item) store.selectHistory(item);
  }, [list.items]);

  return (
    <div className="history-view history-sidebar-list">
      <section className="history-list-pane" aria-label="历史会话">
        <div className="history-filters">
          <div className="history-filter-group" role="group" aria-label="按 agent 筛选">
            <button
              type="button"
              className={`history-chip${agentFilter === "" ? " selected" : ""}`}
              aria-pressed={agentFilter === ""}
              onClick={() => setAgentFilter("")}
            >
              全部
            </button>
            {AGENTS.map((agent) => (
              <button
                key={agent}
                type="button"
                className={`history-chip agent-${agent}${agentFilter === agent ? " selected" : ""}`}
                aria-pressed={agentFilter === agent}
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
                aria-pressed={sourceFilter === source}
                onClick={() => setSourceFilter(source)}
              >
                {source === "all" ? "全部来源" : SOURCE_FILTER_LABELS[source]}
              </button>
            ))}
          </div>
          {/* 「加载更多」放在筛选右侧（跨两行），不必滚到列表底（用户 10-02） */}
          {/* 只在当前查询首屏就绪后出现：重拉期间旧 nextCursor 属于旧查询，不能点 */}
          {list.nextCursor && phase === "ready" && (
            <button
              type="button"
              className="btn history-load-more"
              aria-label={loadingMore ? "加载中" : "加载更多"}
              disabled={loadingMore}
              onClick={() => void load(list.nextCursor)}
            >
              {loadingMore ? <>加载<br />中…</> : <>加载<br />更多</>}
            </button>
          )}
          <input
            type="search"
            className="history-search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索标题或目录…"
            aria-label="搜索历史会话"
          />
        </div>
        {phase === "ready" && list.truncated && (
          <p className="history-meta" style={{ fontSize: "var(--detail-font-size)" }}>
            扫描未完成，可<button
              type="button"
              style={{ font: "inherit", color: "inherit", border: 0, padding: 0, background: "none", textDecoration: "underline", cursor: "pointer" }}
              disabled={loadingMore}
              onClick={() => void load(list.nextCursor)}
            >重试</button>
          </p>
        )}
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
                    imported={importedKeys.has(`${item.agent}:${item.nativeSessionId}`)}
                    now={now}
                    onSelect={selectRow}
                  />
                </li>
              ))}
              {phase === "ready" && !list.truncated && visible.length === 0 && (
                <li className="history-list-empty">
                  {list.items.length === 0 ? "没有匹配的历史会话" : "已加载条目里没有该来源的会话"}
                </li>
              )}
              {phase === "loading" && <li className="history-list-empty">加载中…</li>}
            </ul>
            <div className="history-more">
              {!list.nextCursor && !list.truncated && phase === "ready" && list.items.length > 0 && <span className="history-meta">没有更多了</span>}
              {listError && phase === "ready" && (
                <span className="history-error" role="alert">
                  {listError}
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export const HistoryRow = memo(function HistoryRow({
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
  onSelect: (key: string) => void;
}) {
  const key = `${item.agent}:${item.nativeSessionId}`;
  return (
    <button
      type="button"
      className={`history-row agent-${item.agent}${active ? " active" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(key)}
    >
      <span className="history-row-line1">
        <AgentIcon agent={item.agent} label={item.agent} />
        <span className="history-row-title" title={item.title}>
          {item.title}
        </span>
        {item.dispatch && <span className="dispatch-badge" title={`${item.dispatch.name} · ${item.dispatch.runId}`}>工单</span>}
        <span className={`source-badge source-${item.source}`}>
          {SOURCE_LABELS[item.source]}
        </span>
        <span className="history-row-time" title={new Date(item.lastActivityAt).toLocaleString()}>
          {relativeTimeShort(item.lastActivityAt, now)}
        </span>
      </span>
      <span className="history-row-line2">
        <span className="history-row-cwd mono" title={item.cwd}>
          {item.cwd}
        </span>
        {imported && <span className="imported-badge">已在工作台中</span>}
      </span>
    </button>
  );
});

export function HistoryPreviewPane({ item, onBack }: { item: HistorySession | undefined; onBack: () => void }) {
  const now = useStore(selectHistoryNow);
  const selectImportedId = useCallback(
    (value: Store) => (item ? findImportedSession(value.sessions, item)?.id : undefined),
    [item],
  );
  const importedId = useStore(selectImportedId);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    setImporting(false);
    setImportError(null);
  }, [item]);

  const toolbar = <div className="view-panel-actions">
    {item && <button type="button" className="btn history-back" onClick={onBack}>‹ 历史会话</button>}
    <PanelActions />
  </div>;

  if (!item) {
    return (
      <aside className="history-preview-pane" aria-label="会话预览" aria-live="polite">
        {toolbar}
        <div className="history-preview-empty">从左侧选一个会话查看预览</div>
      </aside>
    );
  }

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
    <aside className="history-preview-pane" aria-label="会话预览" aria-live="polite">
      {toolbar}
      <div className="history-preview-head">
        <h2 className="history-preview-title" title={`${item.title} · ${item.nativeSessionId}`}>{item.title}</h2>
        <p className="history-preview-meta">
          {item.agent} · {SOURCE_LABELS[item.source]} ·{" "}
          {relativeTime(item.lastActivityAt, now)}
        </p>
        <p className="history-preview-id mono" title={item.nativeSessionId}>
          {item.nativeSessionId}
        </p>
        <p className="history-preview-cwd mono" title={item.cwd}>
          {item.cwd}
        </p>
      </div>
      <div className="history-preview-body" ref={previewRef}>
        <PagedHistory key={`${item.agent}:${item.nativeSessionId}`} agent={item.agent}
          nativeSessionId={item.nativeSessionId} cwd={item.cwd} streamRef={previewRef} startAtEnd />
      </div>
      <div className="history-actions">
        {importedId ? (
          <>
            <p className="history-note">已在工作台中</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => store.navigate(importedId)}
            >
              打开会话
            </button>
          </>
        ) : (
          <>
            {/* 代价说明不能省：就地续接，不是分叉；措辞中性如实 */}
            <p className="history-note history-import-note">{IMPORT_NOTE}</p>
            <details className="history-import-details" key={`${item.agent}:${item.nativeSessionId}`}>
              <summary>
                <span className="history-note">{IMPORT_NOTE}</span>
                <span className="history-details-show">详情</span>
                <span className="history-details-hide">收起</span>
              </summary>
            </details>
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
