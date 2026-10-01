import type { AgentKind, HistoryMessage } from "../types";
import { buildHistoryRenderItems, focusVisible, groupReadOnlyTools, type ExternalHistoryBlock } from "../render-items";
import { MarkdownMessage } from "./MarkdownMessage";
import { ReadOnlyToolGroup, ThoughtBlockView, ToolCard, UserBlockView } from "./StreamItems";
import type { Store } from "../store";
import { useStore } from "../useStore";

const selectFocusView = (value: Store) => value.focusView;

export function HistoryTimeline({ messages: all, agent, cwd }: { messages: HistoryMessage[]; agent: AgentKind; cwd: string }) {
  // Focus view：历史区同样只留用户与助手文字
  const focusView = useStore(selectFocusView);
  const grouped = groupReadOnlyTools(buildHistoryRenderItems(all), agent, cwd);
  const items = focusView ? grouped.filter(focusVisible) : grouped;
  return <div className="history-timeline">{items.map((item, index) => {
    if (item.kind === "user") return <UserBlockView key={item.key} item={item} />;
    const next = items[index + 1];
    const continues = Boolean(next && next.kind !== "user");
    if (item.kind === "tool-group") return <ReadOnlyToolGroup key={item.key} item={item} agent={agent} cwd={cwd} continues={continues} />;
    return <div key={item.key} className={`timeline-item${continues ? " timeline-continues" : ""}${item.kind === "tool" ? ` timeline-${item.status}` : ""}`}>
      {item.kind === "tool" ? <ToolCard item={item} agent={agent} cwd={cwd} />
        : item.kind === "thought" ? <ThoughtBlockView item={item} />
        : item.kind === "text" && <div className="text-block"><MarkdownMessage text={item.text} /></div>}
    </div>;
  })}</div>;
}

export function ExternalHistoryView({ item, agent, cwd }: { item: ExternalHistoryBlock; agent: AgentKind; cwd: string }) {
  return <section className="session-history" aria-label="在别处继续的对话">
    <p className="session-history-note">以下在 VSCode / 终端 / 手机上继续</p>
    {item.truncated && <p className="session-history-note">部分较早内容或工具正文因大小限制已省略。</p>}
    <HistoryTimeline messages={item.messages} agent={agent} cwd={cwd} />
    <div className="session-history-divider" role="separator" />
  </section>;
}
