import { memo, useMemo } from "react";
import type { AgentKind, HistoryMessage } from "../types";
import { focusVisible, type ExternalHistoryBlock } from "../render-items";
import { historyRenderItems } from "../history-render-cache";
import { MarkdownMessage } from "./MarkdownMessage";
import { ReadOnlyToolGroup, ThoughtBlockView, ToolCard, UserBlockView } from "./StreamItems";
import type { Store } from "../store";
import { useStore } from "../useStore";

const selectFocusView = (value: Store) => value.focusView;

export const HistoryTimeline = memo(function HistoryTimeline({ messages: all, agent, cwd, sessionId }: { messages: HistoryMessage[]; agent: AgentKind; cwd: string; sessionId?: string }) {
  // Focus view：历史区同样只留用户与助手文字
  const focusView = useStore(selectFocusView);
  const grouped = useMemo(() => historyRenderItems(all, agent, cwd), [all, agent, cwd]);
  const items = useMemo(() => focusView ? grouped.filter(focusVisible) : grouped, [grouped, focusView]);
  return <div className="history-timeline">{items.map((item, index) => {
    if (item.kind === "user") return <UserBlockView key={item.key} item={item} />;
    const next = items[index + 1];
    const continues = Boolean(next && next.kind !== "user");
    if (item.kind === "tool-group") return <ReadOnlyToolGroup key={item.key} item={item} agent={agent} cwd={cwd} continues={continues} />;
    return <div key={item.key} className={`timeline-item${continues ? " timeline-continues" : ""}${item.kind === "tool" ? ` timeline-${item.status}` : ""}`}>
      {item.kind === "tool" ? <ToolCard item={item} agent={agent} cwd={cwd} />
        : item.kind === "thought" ? <ThoughtBlockView item={item} />
        : item.kind === "text" && <div className="text-block"><MarkdownMessage text={item.text} cwd={cwd} sessionId={sessionId} /></div>}
    </div>;
  })}</div>;
});

export function ExternalHistoryView({ item, agent, cwd, sessionId }: { item: ExternalHistoryBlock; agent: AgentKind; cwd: string; sessionId?: string }) {
  return <section className="session-history" aria-label="在别处继续的对话">
    <p className="session-history-note">以下在 VSCode / 终端 / 手机上继续</p>
    {item.truncated && <p className="session-history-note">部分较早内容或工具正文因大小限制已省略。</p>}
    <HistoryTimeline messages={item.messages} agent={agent} cwd={cwd} sessionId={sessionId} />
    <div className="session-history-divider" role="separator" />
  </section>;
}
