import { t, getLocale } from "../i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, HistorySession } from "../types";
import { fetchHistory, pickWindowsDirectory } from "../api";
import {
  findImportedSession,
  filterBySource,
  SOURCE_FILTER_LABELS,
  SOURCE_LABELS,
  isHistoryDirectoryInput,
  type SourceFilter,
} from "../history";
import { relativeTime, relativeTimeShort } from "../format";
import { AgentIcon } from "./AgentIcon";
import { PagedHistory } from "./ResumedHistory";
import { store, type Store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { PanelActions } from "./PanelActions";
import { DirectoryBrowser } from "./DirectoryBrowser";

const AGENTS: AgentKind[] = ["claude", "codex", "kimi"];

/** 每页条数：466 条全量下约 3~4 页「加载更多」，不引虚拟滚动库。 */
const PAGE_SIZE = 150;

/** 关键词搜索防抖（spec：~250ms）。 */
const SEARCH_DEBOUNCE_MS = 250;

// 代价说明在桌面完整展示；手机折叠两行，但详情里必须保留全文。
const IMPORT_NOTE = t("ui.HistoryView.this_resumes_the_original_session_without_branching");

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
  const historyRevision = useStore(value => value.historyRevision);
  const cwdFilter = useStore(value => value.historyCwdFilter);
  const searchRequest = useStore(value => value.historySearchRequest);
  const windowsPicker = useStore(value => value.meta?.capabilities?.windowsDirectoryPicker === true);
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
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const selectedKey = useStore((value) => value.historySelection
    ? `${value.historySelection.agent}:${value.historySelection.nativeSessionId}` : null);
  /** 请求代次：agent/q/cwd 变化时自增，过期响应（含旧查询的「加载更多」）直接丢弃 */
  const reqGen = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerGen = useRef(0);
  useEffect(() => () => { pickerGen.current += 1; }, []);

  const applySearchInput = (input: string, submitDirectory = false) => {
    if (submitDirectory && isHistoryDirectoryInput(input)) {
      store.setHistoryCwdFilter(input);
      setQInput("");
      setQ("");
      setDirectoryOpen(false);
      setDirectoryError(null);
      inputRef.current?.focus();
    } else setQInput(input);
  };
  useEffect(() => {
    const input = store.consumeHistorySearch();
    if (input !== undefined) applySearchInput(input, true);
  }, [searchRequest]);

  const selectDirectory = (path: string) => {
    store.setHistoryCwdFilter(path);
    if (isHistoryDirectoryInput(qInput)) { setQInput(""); setQ(""); }
    setDirectoryOpen(false);
    setDirectoryError(null);
    inputRef.current?.focus();
  };
  const browseDirectory = async () => {
    setDirectoryError(null);
    if (!windowsPicker || window.matchMedia("(max-width: 720px)").matches) {
      setDirectoryOpen(true);
      return;
    }
    const gen = ++pickerGen.current;
    setPickerBusy(true);
    try {
      const result = await pickWindowsDirectory(cwdFilter);
      if (gen === pickerGen.current && result.path) selectDirectory(result.path);
    } catch (error) {
      if (gen === pickerGen.current) setDirectoryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (gen === pickerGen.current) { setPickerBusy(false); inputRef.current?.focus(); }
    }
  };

  // 搜索防抖：输入停 250ms 后才真正打到 q 触发重新拉取
  useEffect(() => {
    if (isHistoryDirectoryInput(qInput)) return;
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
          ...(cwdFilter ? { cwd: cwdFilter } : {}),
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
    [agentFilter, q, cwdFilter],
  );

  // agent/q/cwd 变化 → 从头重拉（cursor 作废）；来源筛选是前端侧过滤，不重拉
  useEffect(() => {
    void load();
  }, [load, historyRevision]);

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
      <section className="history-list-pane" aria-label={t("ui.common.session_history")}>
        <div className="history-filters">
          <div className="history-filter-group" role="group" aria-label={t("ui.HistoryView.filter_by_agent")}>
            <button
              type="button"
              className={`history-chip${agentFilter === "" ? " selected" : ""}`}
              aria-pressed={agentFilter === ""}
              onClick={() => setAgentFilter("")}
            >{t("ui.HistoryView.all")}</button>
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
          <div className="history-filter-group" role="group" aria-label={t("ui.HistoryView.filter_by_source")}>
            {(["all", "interactive", "workbench"] as SourceFilter[]).map((source) => (
              <button
                key={source}
                type="button"
                className={`history-chip${sourceFilter === source ? " selected" : ""}`}
                aria-pressed={sourceFilter === source}
                onClick={() => setSourceFilter(source)}
              >
                {source === "all" ? t("ui.HistoryView.all_sources") : SOURCE_FILTER_LABELS[source]}
              </button>
            ))}
          </div>
          {/* 「加载更多」放在筛选右侧（跨两行），不必滚到列表底（用户 10-02） */}
          {/* 只在当前查询首屏就绪后出现：重拉期间旧 nextCursor 属于旧查询，不能点 */}
          {list.nextCursor && phase === "ready" && (
            <button
              type="button"
              className="btn history-load-more"
              aria-label={loadingMore ? t("ui.HistoryView.loading") : t("ui.common.load_more")}
              disabled={loadingMore}
              onClick={() => void load(list.nextCursor)}
            >
              {loadingMore ? <>{t("ui.HistoryView.load")}<br />{t("ui.HistoryView.message")}</> : <>{t("ui.HistoryView.load")}<br />{t("ui.common.more")}</>}
            </button>
          )}
          <div className="history-search">
            <button type="button" className="dir-windows-picker history-directory-picker" aria-label={t("ui.HistoryView.select_a_directory_filter")}
              title={pickerBusy ? t("ui.HistoryView.waiting_for_a_windows_directory_selection") : t("ui.HistoryView.select_a_working_directory_filter")}
              disabled={pickerBusy} aria-busy={pickerBusy} onClick={browseDirectory}>
              {/* 与文件面板地址栏的 Windows 浏览按钮同一图标 */}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5V9" fill="currentColor" fillOpacity=".25" />
                <path d="M3.5 8h17a1.5 1.5 0 0 1 1.5 1.7l-1.2 9A1.5 1.5 0 0 1 19.3 20H4.7a1.5 1.5 0 0 1-1.5-1.3L2 9.7A1.5 1.5 0 0 1 3.5 8Z" fill="currentColor" fillOpacity=".5" />
              </svg>
            </button>
            {cwdFilter && <span className="history-chip history-cwd-chip" title={cwdFilter}>
              <span className="history-cwd-name">{cwdFilter.split("/").filter(Boolean).at(-1) || "/"}</span>
              <button type="button" className="icon-btn" aria-label={t("ui.HistoryView.clear_directory_filter")} onClick={() => store.setHistoryCwdFilter("")}>×</button>
            </span>}
            <input ref={inputRef} type="search" value={qInput}
              onChange={(e) => applySearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && isHistoryDirectoryInput(qInput)) {
                  e.preventDefault();
                  applySearchInput(qInput, true);
                } else if (e.key === "Backspace" && !qInput && cwdFilter) {
                  e.preventDefault();
                  store.setHistoryCwdFilter("");
                }
              }}
              placeholder={t("ui.HistoryView.search_keywords_or_enter_or_select_a")} aria-label={t("ui.HistoryView.search_session_history")} />
          </div>
        </div>
        {directoryError && <p className="history-meta history-error" role="alert">{directoryError}</p>}
        {phase === "ready" && list.truncated && (
          <p className="history-meta" style={{ fontSize: "var(--detail-font-size)" }}>{t("ui.HistoryView.scan_incomplete_you_can")}<button
              type="button"
              style={{ font: "inherit", color: "inherit", border: 0, padding: 0, background: "none", textDecoration: "underline", cursor: "pointer" }}
              disabled={loadingMore}
              onClick={() => void load(list.nextCursor)}
            >{t("ui.common.retry")}</button>
          </p>
        )}
        {phase === "error" ? (
          <div className="history-list-status">
            <p className="history-error" role="alert">{t("ui.HistoryView.failed_to_load_sentence", { p0: (listError ?? "") })}</p>
            <button type="button" className="btn" onClick={() => void load()}>{t("ui.common.retry")}</button>
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
                  {list.items.length === 0 ? t("ui.HistoryView.no_matching_sessions") : t("ui.HistoryView.no_sessions_from_this_source_among_loaded")}
                </li>
              )}
              {phase === "loading" && <li className="history-list-empty">{t("ui.common.loading_2")}</li>}
            </ul>
            <div className="history-more">
              {!list.nextCursor && !list.truncated && phase === "ready" && list.items.length > 0 && <span className="history-meta">{t("ui.HistoryView.no_more_results")}</span>}
              {listError && phase === "ready" && (
                <span className="history-error" role="alert">
                  {listError}
                </span>
              )}
            </div>
          </>
        )}
      </section>
      {directoryOpen && <DirectoryBrowser initialPath={cwdFilter} onSelect={selectDirectory}
        onClose={() => { setDirectoryOpen(false); inputRef.current?.focus(); }} />}
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
        {item.dispatch && <span className="dispatch-badge" title={`${item.dispatch.name} · ${item.dispatch.runId}`}>{t("ui.HistoryView.work_order")}</span>}
        <span className={`source-badge source-${item.source}`}>
          {SOURCE_LABELS[item.source]}
        </span>
        <span className="history-row-time" title={new Date(item.lastActivityAt).toLocaleString(getLocale())}>
          {relativeTimeShort(item.lastActivityAt, now)}
        </span>
      </span>
      <span className="history-row-line2">
        <span className="history-row-cwd mono" title={item.cwd}>
          {item.cwd}
        </span>
        {imported && <span className="imported-badge">{t("ui.HistoryView.already_in_the_workspace")}</span>}
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
    {item && <button type="button" className="btn history-back" onClick={onBack}>{t("ui.HistoryView.session_history")}</button>}
    <PanelActions />
  </div>;

  if (!item) {
    return (
      <aside className="history-preview-pane" aria-label={t("ui.HistoryView.session_preview")} aria-live="polite">
        {toolbar}
        <div className="history-preview-empty">{t("ui.HistoryView.select_a_session_on_the_left_to")}</div>
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
    <aside className="history-preview-pane" aria-label={t("ui.HistoryView.session_preview")} aria-live="polite">
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
            <p className="history-note">{t("ui.HistoryView.already_in_the_workspace")}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => store.navigate(importedId)}
            >{t("ui.HistoryView.open_session")}</button>
          </>
        ) : (
          <>
            {/* 代价说明不能省：就地续接，不是分叉；措辞中性如实 */}
            <p className="history-note history-import-note">{IMPORT_NOTE}</p>
            <details className="history-import-details" key={`${item.agent}:${item.nativeSessionId}`}>
              <summary>
                <span className="history-note">{IMPORT_NOTE}</span>
                <span className="history-details-show">{t("ui.HistoryView.details")}</span>
                <span className="history-details-hide">{t("ui.common.collapse")}</span>
              </summary>
            </details>
            {importError && (
              <p className="history-error" role="alert">{t("ui.HistoryView.import_failed_sentence", { p0: (importError) })}</p>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={importing}
              onClick={() => void doImport()}
            >
              {importing ? t("ui.HistoryView.importing") : t("ui.HistoryView.import_and_resume")}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
