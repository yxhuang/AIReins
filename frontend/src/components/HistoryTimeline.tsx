import type { AgentKind, HistoryMessage } from "../types";
import type { ExternalHistoryBlock, ToolView } from "../render-items";
import { MarkdownMessage } from "./MarkdownMessage";
import { ToolCard, UserBlockView } from "./StreamItems";

const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? null);

export function HistoryTimeline({ messages, agent, cwd }: { messages: HistoryMessage[]; agent: AgentKind; cwd: string }) {
  return <div className="history-timeline">{messages.map((message, index) => {
    const key = message.role === "tool" ? `tool:${message.tool.id}` : `${message.role}:${message.timestamp}:${index}`;
    if (message.role === "user") return <UserBlockView key={key} item={{ kind: "user", key, seq: index, text: message.text }} />;
    const continues = messages[index + 1] && messages[index + 1]!.role !== "user";
    let tool: ToolView | undefined;
    if (message.role === "tool") tool = {
      kind: "tool", key, seq: index, turn: 0, toolCallId: message.tool.id,
      toolName: message.tool.name, baseToolName: message.tool.name,
      input: display(message.tool.input), rawInput: message.tool.input,
      result: message.tool.result ?? "", rawResult: message.tool.rawResult, status: message.tool.status,
    };
    return <div key={key} className={`timeline-item${continues ? " timeline-continues" : ""}${tool ? ` timeline-${tool.status}` : ""}`}>
      {tool ? <ToolCard item={tool} agent={agent} cwd={cwd} /> : message.role === "assistant" && <div className="text-block"><MarkdownMessage text={message.text} /></div>}
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
