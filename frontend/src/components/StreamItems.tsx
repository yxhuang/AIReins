import { t } from "../i18n";
import { forwardRef, memo, useState } from "react";
import type {
  GateView,
  RawBlock,
  SystemBlock,
  TextBlock,
  ThoughtBlock,
  ToolGroupView,
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
  selectedOptions,
} from "../ask";
import { store } from "../store";
import { uploadsFileUrl } from "../api";
import type { AgentKind, ImageMention } from "../types";
import { summarizeTool, type ToolSummary } from "../tool-summary";
import { asRecord } from "../format";
import { fileRoot } from "../file-preview";
import { DiffView, lineDiff } from "./DiffView";
import { MarkdownMessage, UserMessageText } from "./MarkdownMessage";

export function UserBlockView({ item }: { item: UserBlock }) {
  const mentions = item.mentions ?? [];
  return (
    <div className="user-block">
      <div className="user-block-body">
        {item.steer && (
          <span className="user-attach-tag" style={{ display: "inline-block", marginBottom: 4 }}
            title={item.queued ? t("ui.StreamItems.kimi_does_not_support_steering_during_execution") : t("ui.StreamItems.added_to_the_current_turn_without_interrupting")}>
            {item.queued ? t("ui.StreamItems.queued_kimi_does_not_support_steering_sends") : t("ui.StreamItems.steering")}
          </span>
        )}
        <UserMessageText text={item.text} />
        {mentions.length > 0 && (
          <div className="user-attach-list">
            {mentions.map((mention, index) =>
              mention.type === "image" ? (
                <MentionImage key={`${mention.path}:${index}`} mention={mention} />
              ) : (
                <span key={`${mention.path}:${index}`} className="user-attach-tag mono" title={mention.path}>
                  {mention.name ?? mentionBasename(mention.path)}
                </span>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function mentionBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 消息内的图片附件：历史消息里的图片可能已被清理或不在 uploads 下，加载失败降级为文件名标签。 */
function MentionImage({ mention }: { mention: ImageMention }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="user-attach-tag mono" title={mention.path}>
        {mention.name ?? mentionBasename(mention.path)}
      </span>
    );
  }
  return (
    <img
      className="user-attach-img"
      src={uploadsFileUrl(mention.path)}
      alt={mention.name ?? mentionBasename(mention.path)}
      title={mention.path}
      onError={() => setFailed(true)}
    />
  );
}

export const TextBlockView = memo(function TextBlockView({ item, streaming, cwd, sessionId }: { item: TextBlock; streaming: boolean; cwd?: string; sessionId?: string }) {
  return (
    <div className="text-block">
      <MarkdownMessage text={item.text} streaming={streaming} cwd={cwd} sessionId={sessionId} />
      {streaming && <span className="cursor" aria-hidden="true">▍</span>}
    </div>
  );
}, (previous, next) => previous.item.text === next.item.text && previous.streaming === next.streaming && previous.cwd === next.cwd && previous.sessionId === next.sessionId);

export const ThoughtBlockView = memo(function ThoughtBlockView({ item }: { item: ThoughtBlock }) {
  const [open, setOpen] = useState(false);
  const hasContent = item.text.length > 0;
  return (
    <div className="thought-block">
      <button type="button" className="thought-head" disabled={!hasContent} aria-expanded={hasContent ? open : undefined} onClick={() => setOpen((v) => !v)}>
        {hasContent && <span className="chevron">{open ? "▾" : "▸"}</span>}{t("ui.StreamItems.reasoning")}{hasContent && t("ui.StreamItems.characters", { p0: (item.text.length) })}
      </button>
      {hasContent && open && <div className="thought-body">{item.text}</div>}
    </div>
  );
}, (previous, next) => previous.item.text === next.item.text);

/** Claude SendUserFile 发给用户的文件：常显，点开在右侧文件面板预览。 */
function SentFilesCard({ files, caption, cwd, sessionId }: { files: string[]; caption: string; cwd: string; sessionId?: string }) {
  return (
    <div className="tool-card sent-files">
      <div className="sent-files-head"><span className="tool-name">{t("ui.StreamItems.sent_files")}</span>{caption && <span className="sent-files-caption">{caption}</span>}</div>
      {files.map((path) => (
        <button key={path} type="button" className="sent-file" title={t("ui.MarkdownMessage.open_file", { p0: path })}
          onClick={() => void store.openFilePreview({ path, root: fileRoot(path, cwd), sessionId })}>
          <span className="sent-file-name">{path.slice(path.lastIndexOf("/") + 1)}</span>
          <span className="sent-file-dir mono">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
        </button>
      ))}
    </div>
  );
}

export const ToolCard = memo(function ToolCard({ item, agent, cwd, sessionId }: { item: ToolView; agent: AgentKind; cwd: string; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (item.baseToolName === "SendUserFile" && item.status !== "error") {
    const input = asRecord(item.rawInput);
    // files 是原始路径而非链接：不剥 #、?、:行号，也不做百分号解码。
    const files = (Array.isArray(input.files) ? input.files : [])
      .filter((file): file is string => typeof file === "string" && file !== "")
      .map((file) => file.startsWith("/") ? file : `${cwd.replace(/\/$/, "")}/${file}`);
    if (files.length) return <SentFilesCard files={files} caption={typeof input.caption === "string" ? input.caption : ""} cwd={cwd} sessionId={sessionId} />;
  }
  const summary = summarizeTool(agent, item, cwd);
  const statusLabel = item.status === "running" ? t("ui.StreamItems.in_progress") : item.status === "ok" ? t("ui.StreamItems.succeeded") : item.status === "error" ? t("ui.StreamItems.failed") : "";
  return (
    <div className={`tool-card tool-${item.status}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name" style={{ flexShrink: 0 }} title={summary.verb}>{summary.verb}</span>
        {summary.target && <span className="tool-summary mono" style={{ flex: "1 1 0" }}>{summary.target}</span>}
        {summary.note && <span className="tool-note">{summary.note}</span>}
        <span className={`tool-status tool-status-${item.status}`}>{statusLabel}</span>
      </button>
      {open && (
        <div className="tool-body">
          <ToolBodyView body={summary.body} status={item.status} showAll={showAll} onShowAll={() => setShowAll(true)} />
        </div>
      )}
    </div>
  );
}, (previous, next) =>
  previous.agent === next.agent &&
  previous.cwd === next.cwd &&
  previous.sessionId === next.sessionId &&
  previous.item.status === next.item.status &&
  previous.item.toolName === next.item.toolName &&
  previous.item.baseToolName === next.item.baseToolName &&
  previous.item.input === next.item.input &&
  previous.item.result === next.item.result &&
  previous.item.rawInput === next.item.rawInput &&
  previous.item.rawResult === next.item.rawResult &&
  previous.item.toolKind === next.item.toolKind &&
  previous.item.locations === next.item.locations &&
  previous.item.terminalOutput === next.item.terminalOutput,
);

const COMMAND_OUTPUT_PREVIEW_LINES = 20;

/** 同组持续追加完成工具时 key 不变，展开状态留在本组件；隐藏子行保留各行自己的状态。 */
export function ReadOnlyToolGroup({ item, agent, cwd, continues }: {
  item: ToolGroupView; agent: AgentKind; cwd: string; continues: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-group">
      <div className={`timeline-item timeline-ok${open || continues ? " timeline-continues" : ""}`}>
        <div className="tool-card">
          <button type="button" className="tool-head tool-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={item.summary}>
            <span className="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="tool-group-summary">
              {item.summaryParts.map(({ verb, count }, index) => (
                <span key={verb}>{index > 0 && " · "}{verb} <span className="tool-group-count">{count}</span></span>
              ))}
            </span>
          </button>
        </div>
      </div>
      <div className="tool-group-items" hidden={!open}>
        {item.tools.map((tool, index) => (
          <div key={tool.key} className={`timeline-item timeline-${tool.status}${index < item.tools.length - 1 || continues ? " timeline-continues" : ""}`}>
            <ToolCard item={tool} agent={agent} cwd={cwd} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolBodyView({ body, status, showAll, onShowAll }: {
  body: ToolSummary["body"];
  status: ToolView["status"];
  showAll: boolean;
  onShowAll: () => void;
}) {
  switch (body.type) {
    case "exec":
      return (
        <>
          {body.calls.map((call, index) => (
            <div key={index}>
              <div className="tool-result-label">{index + 1}. {call.verb}{call.target && ` · ${call.target}`}</div>
              <pre className="code-block">{call.input}</pre>
            </div>
          ))}
          <details>
            <summary>{t("ui.StreamItems.raw_js")}</summary>
            <pre className="code-block">{body.input}</pre>
          </details>
          {body.result && (
            <>
              <div className="tool-result-label">{status === "error" ? t("ui.StreamItems.error_output") : t("ui.StreamItems.result")}</div>
              <pre className="code-block">{body.result}</pre>
            </>
          )}
        </>
      );
    case "command": {
      const lines = body.output ? body.output.replace(/\n+$/, "").split("\n") : [];
      const collapsed = !showAll && lines.length > COMMAND_OUTPUT_PREVIEW_LINES;
      const visible = collapsed ? lines.slice(0, COMMAND_OUTPUT_PREVIEW_LINES).join("\n") : body.output;
      return (
        <>
          {body.command && <pre className="code-block">{body.command}</pre>}
          {body.output && (
            <>
              <div className="tool-result-label">{status === "error" ? t("ui.StreamItems.error_output") : t("ui.StreamItems.output")}</div>
              <pre className="code-block">{visible}</pre>
              {collapsed && (
                <button type="button" className="tool-show-all" onClick={onShowAll}>{t("ui.StreamItems.show_all_lines_sentence", { p0: (lines.length) })}</button>
              )}
            </>
          )}
          {body.truncated && <div className="tool-exit-code">{t("ui.StreamItems.output_was_truncated_because_it_is_too")}</div>}
          {(body.exitCode !== null || body.signal) && (
            <div className="tool-exit-code">
              {body.exitCode !== null && t("ui.StreamItems.exit_code", { p0: (body.exitCode) })}
              {body.signal && t("ui.StreamItems.signal", { p0: (body.signal) })}
            </div>
          )}
        </>
      );
    }
    case "diff":
      return (
        <>
          {body.path && <div className="tool-path mono">{body.path}</div>}
          <DiffView chunks={body.chunks} />
          {body.error && (
            <>
              <div className="tool-result-label">{t("ui.StreamItems.error_output")}</div>
              <pre className="code-block">{body.error}</pre>
            </>
          )}
        </>
      );
    case "read":
      return (
        <>
          <div className="tool-read-summary">
            <span className="mono">{body.path}</span>
            {body.lineCount !== null && t("ui.StreamItems.lines_2", { p0: (body.lineCount) })}
          </div>
          {body.error && (
            <>
              <div className="tool-result-label">{t("ui.StreamItems.error_output")}</div>
              <pre className="code-block">{body.error}</pre>
            </>
          )}
        </>
      );
    default:
      return (
        <>
          {body.input && <pre className="code-block">{body.input}</pre>}
          {body.result && (
            <>
              <div className="tool-result-label">{status === "error" ? t("ui.StreamItems.error_output") : t("ui.StreamItems.result")}</div>
              <pre className="code-block">{body.result}</pre>
            </>
          )}
        </>
      );
  }
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
      const label = item.decision === "deny" ? t("ui.StreamItems.denied") : t("ui.StreamItems.allowed");
      return (
        <div className="gate-block gate-resolved" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} {t("ui.StreamItems.wants_to_run")} <span className="mono">{item.toolName}</span> —— {label}
          </span>
        </div>
      );
    }

    if (dead) {
      return (
        <div className="gate-block gate-expired" ref={ref}>
          <span className="gate-resolved-label">
            {item.agent} {t("ui.StreamItems.wants_to_run")} <span className="mono">{item.toolName}</span>{t("ui.StreamItems.this_session_has_ended_this_approval_is")}</span>
        </div>
      );
    }

    const disabled = submitting;

    const isEdit = Boolean(item.removed || item.added);
    const addedText = isEdit ? item.added : item.content;
    const ops = lineDiff(isEdit ? item.removed : "", addedText);
    const addedCount = ops.filter(([o]) => o === "+").length;
    const removedCount = ops.filter(([o]) => o === "-").length;

    return (
      <div className="gate-block" ref={ref}>
        <div className="gate-title">
          {item.agent} {t("ui.StreamItems.wants_to_run")} <span className="mono">{item.toolName}</span>
          {item.finalGate && <span className="gate-final-tag">{t("ui.StreamItems.final_approval")}</span>}
        </div>
        {item.label !== item.toolName && <div className="gate-label">{item.label}</div>}

        {item.command && <pre className="code-block gate-command">{item.command}</pre>}
        {item.path && <div className="gate-path mono">{item.path}</div>}
        {(isEdit || item.content) && (
          <div className="gate-content">
            <button type="button" className="gate-fold" onClick={() => setContentOpen((v) => !v)}>
              <span className="chevron">{contentOpen ? "▾" : "▸"}</span>
              {isEdit
                ? t("ui.StreamItems.changes_lines", { p0: (addedCount), p1: (removedCount) })
                : t("ui.StreamItems.content_to_write_lines", { p0: (addedCount) })}
            </button>
            {contentOpen && (
              <DiffView chunks={[{ removed: isEdit ? item.removed : "", added: addedText }]} />
            )}
          </div>
        )}
        {!item.command && !item.path && !isEdit && !item.content && item.detail && (
          <div className="gate-content">
            <button type="button" className="gate-fold" onClick={() => setDetailOpen((v) => !v)}>
              <span className="chevron">{detailOpen ? "▾" : "▸"}</span>{t("ui.StreamItems.full_arguments")}</button>
            {detailOpen && <pre className="code-block">{item.detail}</pre>}
          </div>
        )}

        <div className="gate-actions">
          <button type="button" className="btn btn-gate" disabled={disabled} onClick={() => decide("allow")}>
            {submitting ? t("ui.StreamItems.submitting") : t("ui.common.allow")}
          </button>
          <button type="button" className="btn btn-danger" disabled={disabled} onClick={() => decide("deny")}>{t("ui.common.deny")}</button>
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
        ? t("ui.common.skipped")
        : answers.length > 0
          ? t("ui.StreamItems.selected", { p0: (answers.join(" · ")) })
          : t("ui.StreamItems.answered");
      return (
        <div className="gate-block gate-resolved" ref={ref}>
          <span className="gate-resolved-label">{t("ui.StreamItems.asked_sentence", { p0: (item.agent), p1: (label) })}</span>
        </div>
      );
    }

    if (dead) {
      return (
        <div className="gate-block gate-expired" ref={ref}>
          <span className="gate-resolved-label">{t("ui.StreamItems.asked_this_session_has_ended_this_question_sentence", { p0: (item.agent) })}</span>
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
        <div className="gate-title">{t("ui.StreamItems.is_asking_you_sentence", { p0: (item.agent) })}</div>
        {questions.map((q, qi) => {
          const picked = selectedOptions(selection, q);
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
                  <span className="question-option-label">{t("ui.StreamItems.other")}</span>
                  <span className="question-option-desc">{t("ui.StreamItems.write_your_own_answer")}</span>
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
                    placeholder={t("ui.StreamItems.enter_your_answer")}
                    aria-label={t("ui.StreamItems.other_2", { p0: (q.question) })}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--surface)",
                      color: "var(--text)",
                      fontSize: 15,
                      fontFamily: "inherit",
                      padding: "4px 8px",
                      minWidth: 260,
                    }}
                    onChange={(e) => setOther((current) => setOtherText(current, q, e.target.value))}
                  />
                </span>
              )}
              {q.multiSelect && !otherActive && <div className="question-multi-hint">{t("ui.StreamItems.select_multiple")}</div>}
            </div>
          );
        })}
        <div className="question-actions">
          <button
            type="button"
            className="btn btn-gate"
            disabled={submitting || !ready}
            title={ready ? undefined : t("ui.StreamItems.select_at_least_one_option_for_each")}
            onClick={submit}
          >
            {submitting ? t("ui.StreamItems.submitting") : questions.length > 1 ? t("ui.StreamItems.submit_all_answers") : t("ui.StreamItems.submit_answer")}
          </button>
          <button type="button" className="question-skip" disabled={submitting} onClick={skip}>{t("ui.StreamItems.skip_without_answering")}</button>
        </div>
      </div>
    );
  },
);

export function SystemLine({ item }: { item: SystemBlock }) {
  return <div title={item.rawCode} className={`system-line${item.tone === "error" ? " system-error" : ""}${item.text.startsWith(t("ui.StreamItems.session_created_detail")) ? " system-created" : ""}`}>{item.text}</div>;
}

export function RawLine({ item }: { item: RawBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="raw-line">
      <button type="button" className="raw-head" onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>{t("ui.StreamItems.debug_event")}</button>
      {open && <pre className="code-block">{item.text}</pre>}
    </div>
  );
}
