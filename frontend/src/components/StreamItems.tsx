import { forwardRef, useState } from "react";
import type {
  GateView,
  ExternalHistoryBlock,
  RawBlock,
  SystemBlock,
  TextBlock,
  ThoughtBlock,
  ToolView,
  UserBlock,
} from "../render-items";
import {
  allAnswered,
  buildQuestionAnswers,
  clearOther,
  hasOther,
  setOtherText,
  toggleOption,
  toggleOther,
  type AskOther,
  type AskSelection,
} from "../ask";
import { store } from "../store";

export function UserBlockView({ item }: { item: UserBlock }) {
  return (
    <div className="user-block">
      <span className="user-text">{item.text}</span>
    </div>
  );
}

export function ExternalHistoryView({ item }: { item: ExternalHistoryBlock }) {
  return (
    <section className="session-history" aria-label="在别处继续的对话">
      <p className="session-history-note">以下为在别处（VSCode/CLI 等）继续的对话，仅消息文本，不含工具调用。</p>
      {item.truncated && <p className="session-history-note">原生记录超出单次读取窗口，这里只显示可读取的最新消息。</p>}
      <ul className="session-history-list">
        {item.messages.map((message, index) => (
          <li key={`${item.key}:${index}`} className={`history-msg history-msg-${message.role}`}>
            <span className="history-msg-role">{message.role === "user" ? "用户" : "助手"}</span>
            <span className="history-msg-text">{message.text}</span>
            <span className="history-msg-time mono">{message.timestamp ? new Date(message.timestamp).toLocaleString() : "时间未知"}</span>
          </li>
        ))}
      </ul>
      <div className="session-history-divider" role="separator"><span>以上为在别处继续的对话 · 仅消息文本</span></div>
    </section>
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
// dead 会话里的未决闸门降级为中性「已失效」态：无暖色、不可点击。
export const GateBlock = forwardRef<HTMLDivElement, { item: GateView; sessionId: string; dead: boolean }>(
  function GateBlock({ item, sessionId, dead }, ref) {
    const [detailOpen, setDetailOpen] = useState(false);
    const [contentOpen, setContentOpen] = useState(false);
    // 发送成功才进提交中态：禁用所有决策按钮，直到 permission_resolved 到达；
    // 断线发送失败时不进提交中态（按钮保持可点，错误由全局 lastError 条提示），避免永久卡死。
    const [submitting, setSubmitting] = useState(false);

    const decide = (decision: "allow" | "deny") => {
      if (submitting || dead) return;
      if (store.resolvePermission(sessionId, item.requestId, decision)) setSubmitting(true);
    };

    if (item.decision) {
      const label = item.decision === "deny" ? "已拒绝" : "已允许";
      return (
        <div className="gate-block gate-resolved" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} 要执行 <span className="mono">{item.toolName}</span> —— {label}
          </span>
        </div>
      );
    }

    if (dead) {
      return (
        <div className="gate-block gate-expired" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} 要执行 <span className="mono">{item.toolName}</span> —— 会话已结束，此审批已失效
          </span>
        </div>
      );
    }

    const disabled = submitting;

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
            {submitting ? "提交中…" : "允许"}
          </button>
          <button type="button" className="btn btn-danger" disabled={disabled} onClick={() => decide("deny")}>
            拒绝
          </button>
        </div>
      </div>
    );
  },
);

// 提问卡片（Claude AskUserQuestion）：仍是闸门暖色系（它在等人出手），但视觉是
// 「问题卡片」而非「危险操作卡片」——选项是并列可点卡片，没有允许/拒绝二元按钮，
// 跳过出口是小字次按钮。与闸门块共用 .gate-block 的暖色底与 2px 硬边。
export const QuestionBlock = forwardRef<HTMLDivElement, { item: GateView; sessionId: string; dead: boolean }>(
  function QuestionBlock({ item, sessionId, dead }, ref) {
    const questions = item.questions ?? [];
    // 每题选中集合：key 逐字 = 问题原文（回传协议要求），value = 已选 label 数组
    const [selection, setSelection] = useState<AskSelection>({});
    // 「其他…」自由文本：key 逐字 = 问题原文，键存在即选中（与选项互斥，见 ask.ts）
    const [other, setOther] = useState<AskOther>({});
    // 提交后进入提交中态：禁用全部控件，直到 permission_resolved 到达
    const [submitting, setSubmitting] = useState(false);

    if (item.decision) {
      const answers = item.questionAnswers ? Object.values(item.questionAnswers) : [];
      const label = item.decision === "deny"
        ? "已跳过"
        : answers.length > 0
          ? `已选择：${answers.join(" · ")}`
          : "已回答";
      return (
        <div className="gate-block gate-resolved" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} 的提问 —— {label}
          </span>
        </div>
      );
    }

    if (dead) {
      return (
        <div className="gate-block gate-expired" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} 的提问 —— 会话已结束，此提问已失效
          </span>
        </div>
      );
    }

    const submit = () => {
      if (submitting || !allAnswered(questions, selection, other)) return;
      // 发送成功才进提交中态（断线失败时不禁用按钮，错误走全局 lastError 条）
      if (
        store.resolvePermission(
          sessionId,
          item.requestId,
          "allow",
          undefined,
          buildQuestionAnswers(questions, selection, other),
        )
      ) setSubmitting(true);
    };

    const skip = () => {
      if (submitting) return;
      // 跳过 = deny：模型收到「用户拒绝了此操作」，可继续别的路径
      if (store.resolvePermission(sessionId, item.requestId, "deny")) setSubmitting(true);
    };

    const ready = allAnswered(questions, selection, other);

    return (
      <div className="gate-block question-block" ref={ref}>
        <div className="gate-title">{item.agent} 在问你</div>
        {questions.map((q, qi) => {
          const picked = selection[q.question] ?? [];
          const otherActive = hasOther(other, q);
          return (
            <div className="question-item" key={qi}>
              {q.header && <div className="question-header">{q.header}</div>}
              <div className="question-text">{q.question}</div>
              <div className="question-options" role="group" aria-label={q.header ?? q.question}>
                {q.options.map((option) => {
                  const active = picked.includes(option.label);
                  return (
                    <button
                      type="button"
                      key={option.label}
                      className={`question-option${active ? " selected" : ""}`}
                      aria-pressed={active}
                      disabled={submitting}
                      onClick={() => {
                        setSelection((current) => toggleOption(current, q, option.label));
                        // 选项与「其他」互斥（单选语义）：点选项即取消该题的「其他」
                        setOther((current) => clearOther(current, q));
                      }}
                    >
                      <span className="question-option-label">{option.label}</span>
                      {option.description && (
                        <span className="question-option-desc">{option.description}</span>
                      )}
                    </button>
                  );
                })}
                {/* 「其他…」自由文本出口：选项都不合适时用自己的话回答，与选项互斥；
                    协议不收自由文本的题（kimi、codex isOther:false）不给这个出口，免得填了被后端拒 */}
                {q.otherSupported !== false && (
                <button
                  type="button"
                  className={`question-option question-other${otherActive ? " selected" : ""}`}
                  aria-pressed={otherActive}
                  disabled={submitting}
                  onClick={() => {
                    const next = toggleOther(selection, other, q);
                    setSelection(next.selection);
                    setOther(next.other);
                  }}
                >
                  <span className="question-option-label">其他…</span>
                  <span className="question-option-desc">自己输入回答</span>
                </button>
                )}
              </div>
              {otherActive && (
                // 复用 .config-select 控件的紧凑视觉语言；input 没有对应 CSS 规则，
                // 同款令牌（边框/圆角/底色/字号）只能内联。
                <span className="config-select question-other-input">
                  <input
                    type="text"
                    value={other[q.question] ?? ""}
                    disabled={submitting}
                    placeholder="输入你的回答…"
                    aria-label={`${q.question}（其他）`}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--surface)",
                      color: "var(--text)",
                      fontSize: 12,
                      fontFamily: "inherit",
                      padding: "4px 8px",
                      minWidth: 260,
                    }}
                    onChange={(e) => setOther((current) => setOtherText(current, q, e.target.value))}
                  />
                </span>
              )}
              {q.multiSelect && !otherActive && <div className="question-multi-hint">可多选</div>}
            </div>
          );
        })}
        <div className="question-actions">
          <button
            type="button"
            className="btn btn-gate"
            disabled={submitting || !ready}
            title={ready ? undefined : "每题至少选择一项后才能提交"}
            onClick={submit}
          >
            {submitting ? "提交中…" : questions.length > 1 ? "提交全部回答" : "提交回答"}
          </button>
          <button type="button" className="question-skip" disabled={submitting} onClick={skip}>
            跳过（不回答）
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
