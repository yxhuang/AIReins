import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SessionRecord } from "../types";
import { fetchHistoryMessages } from "../api";
import {
  HISTORY_MAX_MESSAGES,
  HISTORY_PAGE_SIZE,
  historyCapReached,
  initialHistoryPage,
  prependHistoryPage,
  type HistoryPageState,
} from "../resumed-history";

type Phase = "loading" | "ready" | "error";

/**
 * 续接会话的历史消息区：渲染在实时事件流上方，进入会话默认加载最近一页，
 * 顶部「加载更早的消息」按 nextCursor 向更早翻页（prepend，不一次拉全）。
 * 与实时区视觉可区分：弱化底色 + 底部分隔线「以上为导入前的历史对话」；默认展开，不折叠。
 * 历史消息没有工具调用/思考块（后端归一时已丢弃），只渲染用户/助手两态，文本原样。
 */
export function ResumedHistory({
  session,
  streamRef,
}: {
  session: SessionRecord;
  streamRef: RefObject<HTMLDivElement | null>;
}) {
  const resumedFrom = session.resumedFrom;
  const [state, setState] = useState<HistoryPageState | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** prepend 前的滚动高度：加载更早一页后补偿 scrollTop，视图不跳动 */
  const prevScrollHeight = useRef<number | null>(null);
  /** 请求代次：resumedFrom 变化（组件按会话 key 重挂载，正常不会变）时作废旧响应 */
  const reqGen = useRef(0);

  const agent = resumedFrom?.agent ?? session.agent;
  const nativeSessionId = resumedFrom?.nativeSessionId ?? "";

  const loadLatest = useCallback(async () => {
    const gen = ++reqGen.current;
    setPhase("loading");
    setError(null);
    try {
      const page = await fetchHistoryMessages(agent, nativeSessionId, {
        limit: HISTORY_PAGE_SIZE,
      });
      if (gen !== reqGen.current) return; // 过期响应丢弃
      setState(initialHistoryPage(page));
      setPhase("ready");
    } catch (e) {
      if (gen !== reqGen.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [agent, nativeSessionId]);

  // 进入会话即默认加载最近一页
  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  const loadOlder = async () => {
    const cursor = state?.nextCursor;
    if (!cursor || loadingMore) return;
    prevScrollHeight.current = streamRef.current?.scrollHeight ?? null;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchHistoryMessages(agent, nativeSessionId, {
        limit: HISTORY_PAGE_SIZE,
        cursor,
      });
      setState((prev) => (prev ? prependHistoryPage(prev, page) : initialHistoryPage(page)));
    } catch (e) {
      // 翻页失败不丢已加载内容：错误就地显示，可重试（cursor 没变）
      prevScrollHeight.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // prepend 完成后补偿滚动位置，用户视线停在原来的消息上
  useEffect(() => {
    const container = streamRef.current;
    if (prevScrollHeight.current !== null && container) {
      container.scrollTop += container.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = null;
    }
  }, [state?.messages.length, streamRef]);

  if (!resumedFrom) return null;

  const capped = state ? historyCapReached(state) : false;

  return (
    <section className="session-history" aria-label="导入前的历史对话">
      <p className="session-history-note">
        此会话续接自 {resumedFrom.agent} 原生会话（
        <span className="mono">{resumedFrom.nativeSessionId}</span>
        {typeof resumedFrom.messageCount === "number" &&
          `，约 ${resumedFrom.messageCount} 条消息`}
        ）。以下为导入前的历史消息，只含用户与助手文本。
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
      {state && state.messages.length > 0 && (
        <>
          <div className="session-history-more">
            {state.nextCursor && !capped && (
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
            {capped && (
              <span className="session-history-note">
                为控制页面长度，最多加载最近 {HISTORY_MAX_MESSAGES} 条；更早的内容在原生会话文件中。
              </span>
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
          <ul className="session-history-list">
            {state.messages.map((message, index) => (
              <li key={index} className={`history-msg history-msg-${message.role}`}>
                <span className="history-msg-role">
                  {message.role === "user" ? "用户" : "助手"}
                </span>
                <span className="history-msg-text">{message.text}</span>
                <span className="history-msg-time mono">
                  {message.timestamp
                    ? new Date(message.timestamp).toLocaleString()
                    : "时间未知"}
                </span>
              </li>
            ))}
          </ul>
          <div className="session-history-divider" role="separator">
            {/* 必须如实说明省略了什么：历史只有消息文本，看不到工具调用。
                否则用户向上翻看到「已写入。」这类回复，会以为 agent 凭空声称做了事。 */}
            <span>以上为导入前的历史对话 · 仅消息文本，不含工具调用与思考过程</span>
          </div>
        </>
      )}
    </section>
  );
}
