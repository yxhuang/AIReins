import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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

/** Imported history and preview share the same latest-first reader. */
export function ResumedHistory({ session, streamRef }: { session: SessionRecord; streamRef: RefObject<HTMLDivElement | null> }) {
  if (!session.resumedFrom) return null;
  return <PagedHistory key={`${session.resumedFrom.agent}:${session.resumedFrom.nativeSessionId}`}
    agent={session.resumedFrom.agent} nativeSessionId={session.resumedFrom.nativeSessionId}
    cwd={session.cwd} streamRef={streamRef} imported initialCursor={session.resumedFrom.historyCursor} />;
}

export function PagedHistory({ agent, nativeSessionId, cwd, streamRef, imported = false, startAtEnd = false, initialCursor }: {
  agent: AgentKind; nativeSessionId: string; cwd: string;
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
    <section className="session-history" aria-label="导入前的历史对话">
      <p className="session-history-note">
        {agent} 原生会话 · 用户、助手与工具调用；工具可展开。
      </p>
      {phase === "loading" && <p className="session-history-note">正在加载历史消息…</p>}
      {phase === "error" && (
        <p className="session-history-error" role="alert">
          历史消息加载失败：{error}
          <button type="button" className="btn" onClick={() => void loadLatest()}>
            重试
          </button>
        </p>
      )}
      {state && state.messages.length === 0 && phase === "ready" && (
        <p className="session-history-note">原生会话中没有可显示的历史消息。</p>
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
                {loadingMore ? "加载中…" : "加载更早的消息"}
              </button>
            )}
            {!state.nextCursor && (
              <span className="session-history-note">已到最早的消息</span>
            )}
            {error && phase === "ready" && (
              <span className="session-history-error" role="alert">
                {error}
                <button
                  type="button"
                  className="btn"
                  disabled={loadingMore}
                  onClick={() => void loadOlder()}
                >
                  重试
                </button>
              </span>
            )}
          </div>
          {state.truncated && (
            <p className="session-history-note">
              部分页受单次读取窗口限制，个别消息可能不完整。
            </p>
          )}
          <HistoryTimeline messages={state.messages} agent={agent} cwd={cwd} />
          <div className="session-history-divider" role="separator" ref={dividerRef}>
            {imported ? "以上为导入前的历史对话" : "以上为原生历史记录"}
          </div>
        </>
      )}
    </section>
  );
}
