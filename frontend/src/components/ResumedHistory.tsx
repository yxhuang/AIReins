import { t } from "../i18n";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AgentKind, SessionRecord } from "../types";
import { HistoryTimeline } from "./HistoryTimeline";
import { fetchHistoryMessages } from "../api";
import {
  HISTORY_PAGE_SIZE,
  fetchInitialHistoryPage,
  initialHistoryPage,
  prependHistoryPage,
  type HistoryPageState,
} from "../resumed-history";

type Phase = "loading" | "ready" | "error";

/** Imported history and preview share the same latest-first reader.
 * 历史区异步加载、插在实时流上方，载入后同样滚到底，进会话停在最新消息。 */
export const ResumedHistory = memo(function ResumedHistory({ session, streamRef }: { session: SessionRecord; streamRef: RefObject<HTMLDivElement | null> }) {
  if (!session.resumedFrom) return null;
  return <PagedHistory key={`${session.resumedFrom.agent}:${session.resumedFrom.nativeSessionId}`}
    agent={session.resumedFrom.agent} nativeSessionId={session.resumedFrom.nativeSessionId}
    cwd={session.cwd} sessionId={session.id} streamRef={streamRef} imported startAtEnd initialCursor={session.resumedFrom.historyCursor} />;
}, (previous, next) => previous.streamRef === next.streamRef && previous.session.cwd === next.session.cwd
  && previous.session.resumedFrom?.agent === next.session.resumedFrom?.agent
  && previous.session.resumedFrom?.nativeSessionId === next.session.resumedFrom?.nativeSessionId
  && previous.session.resumedFrom?.historyCursor === next.session.resumedFrom?.historyCursor);

export const PagedHistory = memo(function PagedHistory({ agent, nativeSessionId, cwd, sessionId, streamRef, imported = false, startAtEnd = false, initialCursor }: {
  agent: AgentKind; nativeSessionId: string; cwd: string;
  sessionId?: string;
  streamRef: RefObject<HTMLDivElement | null>; imported?: boolean;
  /** 首页加载后滚到底（历史页预览：首屏是最后几轮） */
  startAtEnd?: boolean;
  /** 导入时刻的截止 cursor：首页截止在导入前；缺省从最新一页开始（历史页预览不传） */
  initialCursor?: string;
}) {
  const pendingEnd = useRef(startAtEnd);
  const [state, setState] = useState<HistoryPageState | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * prepend 补偿基线：fetch 前采样历史区底部参照节点（分隔线）的 offsetTop。
   * 不采样 scrollHeight——fetch 等待期间实时流往下方追加会撑大 scrollHeight，
   * 而底部节点只被 prepend 推动，补偿量恰好等于新增高度。
   */
  const dividerTopBefore = useRef<number | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  /** 请求代次：resumedFrom 变化（组件按会话 key 重挂载，正常不会变）时作废旧响应 */
  const reqGen = useRef(0);

  const loadLatest = useCallback(async () => {
    const gen = ++reqGen.current;
    setPhase("loading");
    setError(null);
    setState(null);
    try {
      const page = await fetchInitialHistoryPage(
        (opts) => fetchHistoryMessages(agent, nativeSessionId, opts),
        initialCursor,
        HISTORY_PAGE_SIZE,
      );
      if (gen !== reqGen.current) return; // 过期响应丢弃
      setState(initialHistoryPage(page));
      setPhase("ready");
    } catch (e) {
      if (gen !== reqGen.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [agent, nativeSessionId, initialCursor]);

  // 进入会话即默认加载最近一页
  useEffect(() => {
    void loadLatest();
    return () => { reqGen.current += 1; };
  }, [loadLatest]);

  const loadOlder = async () => {
    const gen = reqGen.current;
    const cursor = state?.nextCursor;
    if (!cursor || loadingMore) return;
    dividerTopBefore.current = dividerRef.current?.offsetTop ?? null;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchHistoryMessages(agent, nativeSessionId, {
        limit: HISTORY_PAGE_SIZE,
        cursor,
      });
      if (gen !== reqGen.current) return;
      // 空页不 prepend（见 prependHistoryPage），messages 条数不变，补偿 effect 不会触发
      if (page.messages.length === 0) dividerTopBefore.current = null;
      setState((prev) => (prev ? prependHistoryPage(prev, page) : initialHistoryPage(page)));
    } catch (e) {
      if (gen !== reqGen.current) return;
      // 翻页失败不丢已加载内容：错误就地显示，可重试（cursor 没变）
      dividerTopBefore.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === reqGen.current) setLoadingMore(false);
    }
  };

  // prepend 完成后补偿滚动位置，用户视线停在原来的消息上。
  // useLayoutEffect 在绘制前执行，避免 useEffect 先画一帧未补偿画面造成的闪烁。
  useLayoutEffect(() => {
    const before = dividerTopBefore.current;
    dividerTopBefore.current = null;
    const container = streamRef.current;
    const divider = dividerRef.current;
    if (before !== null && container && divider) {
      container.scrollTop += divider.offsetTop - before;
    } else if (pendingEnd.current && container && state?.messages.length) {
      pendingEnd.current = false;
      container.scrollTop = container.scrollHeight;
    }
  }, [state?.messages.length, streamRef]);

  return (
    <section className="session-history" aria-label={t("ui.ResumedHistory.conversation_before_import")}>
      <p className="session-history-note">{t("ui.ResumedHistory.native_session_user_assistant_and_tool_calls_sentence", { p0: (agent) })}</p>
      {phase === "loading" && <p className="session-history-note">{t("ui.ResumedHistory.loading_history_messages")}</p>}
      {phase === "error" && (
        <p className="session-history-error" role="alert">{t("ui.ResumedHistory.failed_to_load_history_messages")}{error}
          <button type="button" className="btn" onClick={() => void loadLatest()}>{t("ui.common.retry")}</button>
        </p>
      )}
      {state && state.messages.length === 0 && phase === "ready" && (
        <p className="session-history-note">{t("ui.ResumedHistory.no_history_messages_to_display_in_this")}</p>
      )}
      {state && (
        <>
          <div className="session-history-more">
            {state.nextCursor && (
              <button
                type="button"
                className="btn"
                disabled={loadingMore}
                onClick={() => void loadOlder()}
              >
                {loadingMore ? t("ui.common.loading_2") : t("ui.ResumedHistory.load_earlier_messages")}
              </button>
            )}
            {!state.nextCursor && (
              <span className="session-history-note">{t("ui.ResumedHistory.reached_the_first_message")}</span>
            )}
            {error && phase === "ready" && (
              <span className="session-history-error" role="alert">
                {error}
                <button
                  type="button"
                  className="btn"
                  disabled={loadingMore}
                  onClick={() => void loadOlder()}
                >{t("ui.common.retry")}</button>
              </span>
            )}
          </div>
          {state.truncated && (
            <p className="session-history-note">{t("ui.ResumedHistory.some_pages_exceed_a_single_read_window")}</p>
          )}
          <HistoryTimeline messages={state.messages} agent={agent} cwd={cwd} sessionId={sessionId} />
          <div className="session-history-divider" role="separator" ref={dividerRef}>
            {imported ? t("ui.ResumedHistory.above_conversation_before_import") : t("ui.ResumedHistory.above_native_history")}
          </div>
        </>
      )}
    </section>
  );
});
