import { useCallback, useEffect, useState } from "react";
import { fetchSessionInfo } from "../api";
import { contextPercent } from "../context-usage";
import type { SessionRecord } from "../types";
import { type Store } from "../store";
import { useStore } from "../useStore";

export function ContextUsage({ session }: { session: SessionRecord }) {
  const selectUsage = useCallback((value: Store) => value.data.get(session.id)?.latestUsage, [session.id]);
  const latestUsage = useStore(selectUsage) ?? session.snapshotState?.latestUsage;
  const model = session.config?.model;
  const [claudeContext, setClaudeContext] = useState<{ id: string; model: typeof model; payload: unknown } | null>(null);
  // 只查询已有 worker；不为显示圆环唤醒已释放或已结束会话。
  const canQuery = session.agent === "claude" && Boolean(session.processId) && !session.released
    && session.status !== "starting" && session.status !== "dead";
  useEffect(() => {
    if (!canQuery) return;
    const controller = new AbortController();
    // 初次打开和回合用量更新时各查一次，与扩展使用同一只读接口；不轮询。
    fetchSessionInfo(session.id, "context", controller.signal).then(payload => {
      if (!controller.signal.aborted) setClaudeContext({ id: session.id, model, payload });
    }).catch(() => {
      if (!controller.signal.aborted) setClaudeContext(null);
    });
    return () => controller.abort();
  }, [session.id, model, canQuery, latestUsage]);

  const payload = session.agent === "claude"
    ? claudeContext?.id === session.id && claudeContext.model === model ? claudeContext.payload : undefined
    : latestUsage;
  const percent = contextPercent(session.agent, payload);
  const label = percent === null ? "上下文用量暂不可用" : `上下文已用约 ${Math.round(percent)}%`;
  return (
    <span className={`context-usage${percent === null ? " unknown" : ""}`} tabIndex={0}
      role="img" aria-label={label} data-tooltip={label}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="8" strokeWidth="2" />
        {percent !== null && <circle className="context-usage-fill" cx="10" cy="10" r="8" strokeWidth="2"
          pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 10 10)" />}
        {percent === null && <text x="10" y="13" textAnchor="middle" fill="currentColor" fontSize="9">?</text>}
      </svg>
    </span>
  );
}
