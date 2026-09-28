import React, { isValidElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mentionSegments } from "../mentions";
import { messageRoleLabel } from "../format";
import type { AgentKind, HistoryMessage } from "../types";

function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return codeText(node.props.children);
  return "";
}

function copyCode(button: HTMLButtonElement, text: string) {
  const flash = (label: string) => {
    button.textContent = label;
    setTimeout(() => { button.textContent = "复制"; }, 1500);
  };
  // Clipboard API 只在安全上下文可用（127.0.0.1 与 Tailscale https 都是）；不可用或被拒时给出可见反馈。
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(() => flash("已复制"), () => flash("复制失败"));
}

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-message">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
          table: ({ children, ...props }) => <div className="markdown-table-scroll"><table {...props}>{children}</table></div>,
          pre: ({ children }) => (
            <div className="markdown-code-block">
              <button type="button" className="markdown-copy" onClick={(event) => copyCode(event.currentTarget, codeText(children))}>复制</button>
              <pre>{children}</pre>
            </div>
          ),
        }}
      >{text}</Markdown>
    </div>
  );
}

export function UserMessageText({ text }: { text: string }) {
  return <span className="user-text">{mentionSegments(text).map((part, index) =>
    part.mention ? <span className="mention-tag" key={index}>{part.text}</span> : part.text,
  )}</span>;
}

export function HistoryMessageView({ message, agent, showTime = false }: { message: Pick<HistoryMessage, "role" | "text"> & { timestamp?: string | null }; agent: AgentKind; showTime?: boolean }) {
  return (
    <div className={`history-msg history-msg-${message.role}`}>
      <span className="history-msg-role">{messageRoleLabel(message.role, agent)}</span>
      {message.role === "user"
        ? <div className="user-block"><UserMessageText text={message.text} /></div>
        : <MarkdownMessage text={message.text} />}
      {showTime && <span className="history-msg-time">{message.timestamp ? new Date(message.timestamp).toLocaleString() : "时间未知"}</span>}
    </div>
  );
}
