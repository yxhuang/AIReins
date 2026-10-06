import React, { createContext, memo, isValidElement, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { mentionSegments } from "../mentions";
import { highlightCode, highlightLanguage } from "../code-highlight";
import { resolveLocalFileLink } from "../file-preview";
import { createStreamingTextThrottle } from "../streaming-text";
import { store } from "../store";

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

export const MarkdownCommitContext = createContext<(() => void) | undefined>(undefined);
const StreamingContext = createContext(false);
const FileLinkContext = createContext<{ cwd: string; sessionId?: string } | undefined>(undefined);

function MessageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const context = useContext(FileLinkContext);
  const path = href ? resolveLocalFileLink(href, context?.cwd) : null;
  if (context && path) return <a href={href} title={`打开文件：${path}`} onClick={event => {
    event.preventDefault();
    const root = path.startsWith(`${context.cwd.replace(/\/$/, "")}/`) ? context.cwd : path.slice(0, path.lastIndexOf("/")) || "/";
    void store.openFilePreview({ path, root, sessionId: context.sessionId });
  }}>{children}</a>;
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const streaming = useContext(StreamingContext);
  const text = codeText(children);
  const code = React.Children.toArray(children).find((child) => isValidElement(child));
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : undefined;
  const language = highlightLanguage(className, text);
  const [highlighted, setHighlighted] = useState<{ text: string; language: string; html: string } | null>(null);
  useEffect(() => {
    // 整轮流式输出结束后才处理；加载失败保持纯文本，过期结果不覆盖新内容。
    if (streaming || !language) return;
    let cancelled = false;
    highlightCode(text, language).then((html) => {
      if (!cancelled) setHighlighted({ text, language, html });
    }).catch(() => { /* 保留纯文本 */ });
    return () => { cancelled = true; };
  }, [text, language, streaming]);
  const html = !streaming && highlighted?.text === text && highlighted.language === language ? highlighted.html : null;
  return (
    <div className="markdown-code-block">
      <button type="button" className="markdown-copy" onClick={(event) => copyCode(event.currentTarget, text)}>复制</button>
      <pre>{html === null ? children : <code className={className} dangerouslySetInnerHTML={{ __html: html }} />}</pre>
    </div>
  );
}

// 保持组件身份稳定，流式 token 更新不会卸载并重建代码块。
const markdownComponents: React.ComponentProps<typeof Markdown>["components"] = {
  a: MessageLink,
  table: ({ children, node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props}>{children}</table></div>,
  pre: MarkdownCodeBlock,
};

const ParsedMarkdownMessage = memo(function ParsedMarkdownMessage({ text, streaming = false, cwd, sessionId }: { text: string; streaming?: boolean; cwd?: string; sessionId?: string }) {
  return (
    <div className="markdown-message">
      <StreamingContext value={streaming}>
      <FileLinkContext value={cwd ? { cwd, sessionId } : undefined}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={(url, key) => key === "href" && cwd && resolveLocalFileLink(url, cwd) ? url : defaultUrlTransform(url)}
      >{text}</Markdown>
      </FileLinkContext>
      </StreamingContext>
    </div>
  );
});

export const MarkdownMessage = memo(function MarkdownMessage(props: { text: string; streaming?: boolean; cwd?: string; sessionId?: string }) {
  const onCommit = useContext(MarkdownCommitContext);
  const [text, setText] = useState(props.text);
  const throttle = useRef<ReturnType<typeof createStreamingTextThrottle> | null>(null);
  if (!throttle.current) throttle.current = createStreamingTextThrottle(setText);
  useEffect(() => { throttle.current!.update(props.text, props.streaming === true); }, [props.text, props.streaming]);
  useEffect(() => () => throttle.current!.cancel(), []);
  const displayedText = props.streaming ? text : props.text;
  useLayoutEffect(() => { onCommit?.(); }, [displayedText, onCommit]);
  return <ParsedMarkdownMessage {...props} text={displayedText} />;
});

export function UserMessageText({ text }: { text: string }) {
  return <span className="user-text">{mentionSegments(text).map((part, index) =>
    part.mention ? <span className="mention-tag" key={index}>{part.text}</span> : part.text,
  )}</span>;
}
