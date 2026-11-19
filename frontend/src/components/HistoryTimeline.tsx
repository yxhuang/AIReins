import { t } from "../i18n";
import { Fragment, memo, useMemo } from "react";
import type { AgentKind, HistoryMessage } from "../types";
import { buildHistoryTurnTimings, focusVisible, type ExternalHistoryBlock } from "../render-items";
import { historyRenderItems } from "../history-render-cache";
import { MarkdownMessage } from "./MarkdownMessage";
import { ReadOnlyToolGroup, ThoughtBlockView, ToolCard, TurnDurationMeta, UserBlockView } from "./StreamItems";
import type { Store } from "../store";
import { useStore } from "../useStore";

const selectFocusView = (value: Store) => value.focusView;

export const HistoryTimeline = memo(function HistoryTimeline({ messages: all, agent, cwd, sessionId }: { messages: HistoryMessage[]; agent: AgentKind; cwd: string; sessionId?: string }) {
  // Focus view：历史区同样只留用户与助手文字
  const focusView = useStore(selectFocusView);
  const grouped = useMemo(() => historyRenderItems(all, agent, cwd), [all, agent, cwd]);
  const turnTimings = useMemo(() => buildHistoryTurnTimings(all), [all]);
  const items = useMemo(() => focusView ? grouped.filter(focusVisible) : grouped, [grouped, focusView]);
  let userTurn = 0;
  return <div className="history-timeline">{items.map((item, index) => {
    const next = items[index + 1];
    if (item.kind === "user") {
      userTurn++;
      // 专注视图下若该回合仅有工具/思考（已隐藏），在用户行后保留该回合总用时。
      const turnEnded = !next || next.kind === "user";
      const timing = turnEnded ? turnTimings.get(userTurn) : undefined;
      const durationNode = timing?.hasResponse
        ? <TurnDurationMeta durationMs={timing.durationMs} startedAtMs={timing.startedAtMs} endedAtMs={timing.endedAtMs} apiDurationMs={timing.apiDurationMs} />
        : null;
      return <Fragment key={item.key}><UserBlockView item={item} />{durationNode}</Fragment>;
    }
    const continues = Boolean(next && next.kind !== "user");
    const timing = !continues && "turn" in item ? turnTimings.get(item.turn) : undefined;
    const durationNode = timing?.hasResponse
      ? <TurnDurationMeta durationMs={timing.durationMs} startedAtMs={timing.startedAtMs} endedAtMs={timing.endedAtMs} apiDurationMs={timing.apiDurationMs} />
      : null;
    const body = item.kind === "tool-group"
      ? <ReadOnlyToolGroup key={item.key} item={item} agent={agent} cwd={cwd} continues={continues} />
      : <div key={item.key} className={`timeline-item${continues ? " timeline-continues" : ""}${item.kind === "tool" ? ` timeline-${item.status}` : ""}${item.kind === "text" ? " timeline-deferred-text" : ""}`}>
          {item.kind === "tool" ? <ToolCard item={item} agent={agent} cwd={cwd} sessionId={sessionId} />
            : item.kind === "thought" ? <ThoughtBlockView item={item} />
            : item.kind === "text" && <div className="text-block"><MarkdownMessage text={item.text} cwd={cwd} sessionId={sessionId} /></div>}
        </div>;
    return <Fragment key={item.key}>{body}{durationNode}</Fragment>;
  })}</div>;
});

export function ExternalHistoryView({ item, agent, cwd, sessionId }: { item: ExternalHistoryBlock; agent: AgentKind; cwd: string; sessionId?: string }) {
  return <section className="session-history" aria-label={t("ui.HistoryTimeline.conversation_continued_elsewhere")}>
    <p className="session-history-note">{t("ui.HistoryTimeline.continued_below_in_vs_code_a_terminal")}</p>
    {item.truncated && <p className="session-history-note">{t("ui.HistoryTimeline.some_older_content_or_tool_output_was")}</p>}
    <HistoryTimeline messages={item.messages} agent={agent} cwd={cwd} sessionId={sessionId} />
    <div className="session-history-divider" role="separator" />
  </section>;
}
