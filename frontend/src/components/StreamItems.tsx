import { forwardRef, useState } from "react";
import type {
  GateView,
  RawBlock,
  SystemBlock,
  TextBlock,
  ThoughtBlock,
  ToolView,
  UserBlock,
} from "../render-items";
import { store } from "../store";

export function UserBlockView({ item }: { item: UserBlock }) {
  return (
    <div className="user-block">
      <span className="user-tag">你</span>
      <span className="user-text">{item.text}</span>
    </div>
  );
}

export function TextBlockView({ item, streaming }: { item: TextBlock; streaming: boolean }) {
  return (
    <div className="text-block">
      {item.text}
      {streaming && <span className="cursor" aria-hidden="true">▍</span>}
    </div>
  );
}

export function ThoughtBlockView({ item }: { item: ThoughtBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought-block">
      <button type="button" className="thought-head" onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        思考 · {item.text.length} 字
      </button>
      {open && <div className="thought-body">{item.text}</div>}
    </div>
  );
}

export function ToolCard({ item }: { item: ToolView }) {
  const [open, setOpen] = useState(false);
  const statusLabel = item.status === "running" ? "进行中" : item.status === "ok" ? "成功" : "失败";
  return (
    <div className={`tool-card tool-${item.status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name mono">{item.toolName}</span>
        <span className="tool-summary mono">{summarize(item.input)}</span>
        <span className={`tool-status tool-status-${item.status}`}>{statusLabel}</span>
      </button>
      {open && (
        <div className="tool-body">
          {item.input && <pre className="code-block">{item.input}</pre>}
          {item.result && (
            <>
              <div className="tool-result-label">{item.status === "error" ? "错误输出" : "结果"}</div>
              <pre className="code-block">{item.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 签名元素：闸门块。暖色边框 + 暖色浅底 + 直角，与圆角卡片形成硬边对比。
export const GateBlock = forwardRef<HTMLDivElement, { item: GateView; sessionId: string; disabled: boolean }>(
  function GateBlock({ item, sessionId, disabled }, ref) {
    const [detailOpen, setDetailOpen] = useState(false);
    const [contentOpen, setContentOpen] = useState(false);

    const decide = (decision: "allow" | "deny" | "always") => {
      // 「允许并记住」：把第一条 permissionSuggestion 作为 updatedInput 原样回传。
      const updatedInput =
        decision === "always" && item.suggestions.length > 0 ? item.suggestions[0] : undefined;
      store.resolvePermission(sessionId, item.requestId, decision, updatedInput);
    };

    if (item.decision) {
      const label =
        item.decision === "allow" ? "已允许" : item.decision === "always" ? "已允许（记住）" : "已拒绝";
      return (
        <div className="gate-block gate-resolved" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} 要执行 <span className="mono">{item.toolName}</span> —— {label}
          </span>
        </div>
      );
    }

    const isEdit = Boolean(item.removed || item.added);
    const addedText = isEdit ? item.added : item.content;
    const addedCount = countLines(addedText);
    const removedCount = countLines(item.removed);

    return (
      <div className="gate-block" ref={ref}>
        <div className="gate-title">
          {item.agent} 要执行 <span className="mono">{item.toolName}</span>
          {item.finalGate && <span className="gate-final-tag">最终闸门</span>}
        </div>
        {item.label !== item.toolName && <div className="gate-label">{item.label}</div>}

        {item.command && <pre className="code-block gate-command">{item.command}</pre>}
        {item.path && <div className="gate-path mono">{item.path}</div>}
        {(isEdit || item.content) && (
          <div className="gate-content">
            <button type="button" className="gate-fold" onClick={() => setContentOpen((v) => !v)}>
              <span className="chevron">{contentOpen ? "▾" : "▸"}</span>
              {isEdit
                ? `改动 · +${addedCount} -${removedCount} 行`
                : `写入内容 · +${addedCount} 行`}
            </button>
            {contentOpen && (
              <pre className="code-block diff-block">
                {isEdit && item.removed &&
                  splitLines(item.removed).map((line, i) => (
                    <span key={`d${i}`} className="diff-line diff-del">{`- ${line}`}</span>
                  ))}
                {addedText &&
                  splitLines(addedText).map((line, i) => (
                    <span key={`a${i}`} className="diff-line diff-add">{`+ ${line}`}</span>
                  ))}
              </pre>
            )}
          </div>
        )}
        {!item.command && !item.path && !isEdit && !item.content && item.detail && (
          <div className="gate-content">
            <button type="button" className="gate-fold" onClick={() => setDetailOpen((v) => !v)}>
              <span className="chevron">{detailOpen ? "▾" : "▸"}</span>
              完整入参
            </button>
            {detailOpen && <pre className="code-block">{item.detail}</pre>}
          </div>
        )}

        <div className="gate-actions">
          <button type="button" className="btn btn-gate" disabled={disabled} onClick={() => decide("allow")}>
            允许
          </button>
          {item.suggestions.length > 0 && (
            <button
              type="button"
              className="btn btn-gate"
              disabled={disabled}
              onClick={() => decide("always")}
            >
              允许并记住
            </button>
          )}
          <button type="button" className="btn btn-danger" disabled={disabled} onClick={() => decide("deny")}>
            拒绝
          </button>
        </div>
      </div>
    );
  },
);

export function SystemLine({ item }: { item: SystemBlock }) {
  return <div className={`system-line${item.tone === "error" ? " system-error" : ""}`}>{item.text}</div>;
}

export function RawLine({ item }: { item: RawBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-line">
      <button type="button" className="raw-head" onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        调试事件
      </button>
      {open && <pre className="code-block">{item.text}</pre>}
    </div>
  );
}

// 工具入参摘要：单行截断，全文展开看。
function summarize(input: string): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

// 行数统计：去掉末尾换行后按 \n 计。
function countLines(text: string): number {
  if (!text) return 0;
  return splitLines(text).length;
}

function splitLines(text: string): string[] {
  return text.replace(/\n+$/, "").split("\n");
}
