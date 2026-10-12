import { t, getLocale } from "../i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { askSessionSideQuestion, stopSessionTask, type SessionInfoKind, type SideQuestionTurn } from "../api";
import type { SessionRecord } from "../types";

function MenuDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return <div className="dir-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="dir-dialog info-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dir-heading"><h2>{title}</h2><button ref={close} type="button" className="btn" onClick={onClose}>{t("ui.common.close")}</button></div>
      <div className="dir-list info-body">{children}</div>
    </div>
  </div>;
}

export function ClaudeTasksDialog({ session, onClose }: { session: SessionRecord; onClose: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stop = async (taskId: string, description: string) => {
    if (busy.current || !window.confirm(t("ui.ClaudeMenuPanels.stop_background_task", { p0: (description || taskId) }))) return;
    busy.current = true; setPending(taskId); setError(""); setNotice("");
    try {
      await stopSessionTask(session.id, taskId);
      if (alive.current) setNotice(t("ui.ClaudeMenuPanels.stop_requested_the_list_will_update_as"));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; if (alive.current) setPending(null); }
  };
  const locked = session.released || session.status === "dead" || session.status === "starting";
  return <MenuDialog title={t("ui.ClaudeMenuPanels.background_tasks_tasks")} onClose={onClose}>
    {error && <p className="new-error" role="alert">{error}</p>}
    {notice && <p className="new-hint" role="status">{notice}</p>}
    {locked && <p className="new-hint">{t("ui.ClaudeMenuPanels.the_current_worker_is_not_ready_this")}</p>}
    {session.backgroundTasks?.length ? session.backgroundTasks.map(task => <div className="info-row" key={task.id}>
      <div className="info-row-head"><span className="info-name">{task.description || task.id}</span>
        <button type="button" className="btn" disabled={Boolean(locked) || pending !== null}
          onClick={() => void stop(task.id, task.description)}>{pending === task.id ? t("ui.ClaudeMenuPanels.stopping") : t("ui.ClaudeMenuPanels.stop")}</button></div>
      <div className="info-meta">{task.type}</div>
    </div>) : <p className="new-hint">{t("ui.ClaudeMenuPanels.no_background_tasks_are_running")}</p>}
  </MenuDialog>;
}

export function SideQuestionDialog({ sessionId, agent, initialQuestion = "", onClose }: {
  sessionId: string; agent: string; initialQuestion?: string; onClose: () => void;
}) {
  const codex = agent === "codex";
  const [question, setQuestion] = useState(initialQuestion);
  const [thread, setThread] = useState<{ question: string; answer: string; synthetic?: boolean }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const history = useRef<SideQuestionTurn[]>([]);
  const sideId = useRef<string | undefined>(undefined);
  useEffect(() => {
    // 输入框「/btw 问题」直接带问题打开：挂载即提问。延后一拍，StrictMode 的模拟卸载会先清掉定时器，不重复提问。
    const timer = initialQuestion.trim() ? setTimeout(() => void ask(initialQuestion)) : undefined;
    return () => { clearTimeout(timer); controller.current?.abort(); controller.current = null; };
  }, []);
  const ask = async (value = question) => {
    const text = value.trim();
    if (!text || controller.current) return;
    const request = new AbortController(); controller.current = request; setPending(true); setError("");
    try {
      // Codex 侧聊可能读文件、跑检查：服务端回合上限 300 秒
      const result = await askSessionSideQuestion(sessionId, text, history.current, request.signal, codex ? 320_000 : 80_000, sideId.current);
      if (request.signal.aborted) return;
      sideId.current = result.sideId;
      if (result.error) throw new Error(result.error);
      const answer = typeof result.response === "string" && result.response.trim() ? result.response : t("ui.ClaudeMenuPanels.no_answer_returned");
      setThread(value => [...value, { question: text, answer, synthetic: result.synthetic }]);
      // 服务端每个历史字段限 20000 字符；超长回答只显示不进历史，否则之后每次提问都会被拒
      if (result.response && !result.synthetic && result.response.length <= 20000) history.current = [...history.current, { question: text, response: result.response }].slice(-20);
      setQuestion(current => current.trim() === text ? "" : current);
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (controller.current === request) { controller.current = null; setPending(false); } }
  };
  const cancel = () => {
    controller.current?.abort(); controller.current = null; setPending(false); setError(codex ? t("ui.ClaudeMenuPanels.side_conversation_canceled") : t("ui.ClaudeMenuPanels.side_question_canceled"));
  };
  return <MenuDialog title={codex ? t("ui.ClaudeMenuPanels.side_conversation_side") : t("ui.ClaudeMenuPanels.side_question_btw")} onClose={onClose}>
    <p className="new-hint">{codex
      ? t("ui.ClaudeMenuPanels.ask_in_a_temporary_branch_of_this")
      : t("ui.ClaudeMenuPanels.ask_separately_without_adding_to_the_main")}</p>
    {thread.map((turn, index) => <div className="info-row" key={index}>
      <div className="info-name">{turn.question}</div><div className="info-code side-answer">{turn.answer}</div>
      {turn.synthetic && <div className="info-meta">{t("ui.ClaudeMenuPanels.cli_notice")}</div>}
    </div>)}
    <form className="side-question-form" onSubmit={event => { event.preventDefault(); void ask(); }}>
      <label htmlFor={`side-question-${sessionId}`}>{t("ui.ClaudeMenuPanels.question")}</label>
      <textarea id={`side-question-${sessionId}`} value={question} onChange={event => setQuestion(event.target.value)} maxLength={20000}
        rows={3} disabled={pending} placeholder={t("ui.ClaudeMenuPanels.ask_a_quick_question_outside_the_current")} />
      <div className="info-actions"><button type="submit" className="btn" disabled={pending || !question.trim()}>{pending ? t("ui.ClaudeMenuPanels.answering") : t("ui.ClaudeMenuPanels.ask")}</button>
        {pending && <button type="button" className="btn" onClick={cancel}>{t("ui.common.cancel")}</button>}</div>
    </form>
    {error && <p className="new-error" role="alert">{error}</p>}
  </MenuDialog>;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const rows = (value: unknown): Rec[] => Array.isArray(value) ? value.map(rec) : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
const text = (value: unknown): string => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

export function SettingsFileLinks({ files, hooks = false }: { files: unknown; hooks?: boolean }) {
  return <div className="info-group">
    <p className="new-hint">{t("ui.ClaudeMenuPanels.reopen_this_panel_after_saving_to_see_sentence", { p0: (hooks ? t("ui.ClaudeMenuPanels.edit_hooks_in_the_corresponding_settings_json") : t("ui.ClaudeMenuPanels.edit_the_corresponding_settings_json_in_vs")) })}</p>
    <div className="info-actions">{rows(files).map(file => <FileLink key={str(file.path)} file={file}
      label={t("ui.ClaudeMenuPanels.edit", { p0: (str(file.label)), p1: (hooks ? " Hooks" : "") })} />)}</div>
  </div>;
}

function FileLink({ file, label }: { file: Rec; label?: string }) {
  // 仅消费后端生成的协议链接；CLI 文本不能注入 javascript: URL。
  const uri = str(file.uri);
  return uri.startsWith("vscode://")
    ? <a className="btn info-file-link" href={uri} title={str(file.path)}>{label || str(file.label) || str(file.path)}</a>
    : <span className="info-meta mono">{str(file.path)}</span>;
}

export function ClaudeMenuPanel({ kind, data }: { kind: SessionInfoKind; data: Rec }) {
  if (kind === "export") return <ExportConversation data={data} />;
  if (kind === "settings") return <SettingsFileLinks files={data.settingsFiles} />;
  if (kind === "status") return <>{rows(data.sections).map((section, i) => <div className="info-group" key={i}>
    <div className="info-group-head info-name">{str(section.title)}</div>
    {rows(section.rows).map((row, j) => <div className="info-row" key={j}>
      <span className="info-name">{str(row.label)}</span><div className="info-code">{text(row.value)}</div>
    </div>)}
  </div>)}</>;
  if (kind === "usage") {
    const session = rec(data.session);
    const limits = rec(data.rate_limits);
    const names: Record<string, string> = { session: t("ui.ClaudeMenuPanels.current_period"), weekly_all: t("ui.ClaudeMenuPanels.weekly_total_usage"), weekly_opus: t("ui.ClaudeMenuPanels.weekly_opus_usage"), weekly_sonnet: t("ui.ClaudeMenuPanels.weekly_sonnet_usage") };
    return <>
      <div className="info-row">{t("ui.ClaudeMenuPanels.subscription_sentence", { p0: (text(data.subscription_type)) })}</div>
      <div className="info-row">{t("ui.ClaudeMenuPanels.session_cost_sentence", { p0: (text(session.total_cost_usd)) })}</div>
      <div className="info-row">{t("ui.ClaudeMenuPanels.file_changes_sentence", { p0: (text(session.total_lines_added)), p1: (text(session.total_lines_removed)) })}</div>
      {data.rate_limits_available === false && <p className="new-hint">{t("ui.ClaudeMenuPanels.no_usage_allowance_is_available_for_this")}</p>}
      {rows(limits.limits).map((limit, i) => <div className="info-row" key={i}>
        <span className="info-name">{names[str(limit.kind)] || str(limit.kind)}</span>
        <div className="info-meta">{t("ui.ClaudeMenuPanels.used_sentence", { p0: (text(limit.percent)), p1: (str(limit.resets_at) ? t("ui.ClaudeMenuPanels.resets", { p0: (new Date(str(limit.resets_at)).toLocaleString(getLocale())) }) : "") })}</div>
      </div>)}
    </>;
  }
  if (kind === "memory" || kind === "instructions") {
    const files = rows(data.files);
    const memories = rows(data.memories);
    return <>
      {kind === "memory" && <div className="info-row">{t("ui.ClaudeMenuPanels.auto_memory_sentence", { p0: (rec(data.auto_memory).enabled ? t("ui.ClaudeMenuPanels.on") : t("ui.ClaudeMenuPanels.off")) })}</div>}
      {files.map((file, i) => <div className="info-row" key={i}>
        <FileLink file={file} />
        <div className="info-meta mono">{str(file.path)}{file.exists === false ? t("ui.ClaudeMenuPanels.not_created_yet") : ""}</div>
      </div>)}
      {kind === "memory" && <>
        {rows(data.folders).map((file, i) => <div className="info-row" key={i}><FileLink file={file} /></div>)}
        {memories.map((file, i) => <div className="info-row" key={i}><FileLink file={file} /></div>)}
        {memories.length === 0 && <p className="new-hint">{t("ui.ClaudeMenuPanels.no_saved_auto_memory_entries")}</p>}
        <SettingsFileLinks files={data.settingsFiles} />
      </>}
    </>;
  }
  if (kind === "skills") {
    const skills = rows(data.skills);
    const states: Record<string, string> = { on: t("ui.ClaudeMenuPanels.enable"), "name-only": t("ui.ClaudeMenuPanels.name_only"), "user-invocable-only": t("ui.ClaudeMenuPanels.manual_invocation_only"), off: t("ui.ClaudeMenuPanels.disable") };
    return skills.length ? <>{skills.map((skill, i) => <details className="info-row" key={i}>
      <summary><span className="info-name">{str(skill.display_name) || str(skill.name)}</span> · {states[str(skill.state)] || str(skill.state)}</summary>
      <div className="info-meta">{str(skill.source)}</div>
      <div className="info-code">{str(skill.description)}</div>
    </details>)}</> : <p className="new-hint">{t("ui.ClaudeMenuPanels.no_skills_available")}</p>;
  }
  if (kind === "sandbox") {
    const deps = rec(data.dependencies);
    const restrictions = rec(data.restrictions);
    return <>
      <div className="info-row">{t("ui.ClaudeMenuPanels.sandbox_sentence", { p0: (data.enabled ? t("ui.ClaudeMenuPanels.on") : t("ui.ClaudeMenuPanels.off")), p1: (text(data.mode)) })}</div>
      {data.supported === false && <p className="new-hint">{t("ui.ClaudeMenuPanels.this_environment_does_not_support_a_sandbox")}</p>}
      {data.locked === true && <p className="new-hint">{t("ui.ClaudeMenuPanels.sandbox_settings_are_locked_by_organization_policy")}</p>}
      <div className="info-row">{t("ui.ClaudeMenuPanels.allow_fallback_without_a_sandbox_sentence", { p0: (data.unsandboxed_fallback ? t("ui.ClaudeMenuPanels.yes") : t("ui.ClaudeMenuPanels.no")) })}</div>
      {[...(Array.isArray(deps.errors) ? deps.errors : []), ...(Array.isArray(deps.warnings) ? deps.warnings : [])]
        .map((value, i) => <div className="info-row info-code" key={i}>{text(value)}</div>)}
      {Object.entries(restrictions).filter(([, values]) => Array.isArray(values) && values.length > 0).map(([name, values]) =>
        <div className="info-row" key={name}><span className="info-name">{name}</span><div className="info-code mono">{(values as unknown[]).map(text).join("\n")}</div></div>)}
    </>;
  }
  if (kind === "output") return <>
    <div className="info-row">{t("ui.ClaudeMenuPanels.current_style")}<span className="info-name">{text(data.outputStyle)}</span></div>
    <p className="new-hint">{t("ui.ClaudeMenuPanels.change_outputstyle_in_the_settings_file_or")}</p>
    {(Array.isArray(data.availableStyles) ? data.availableStyles : []).map((style, i) => <div className="info-row info-code" key={i}>{text(style)}</div>)}
  </>;
  return null;
}

function ExportConversation({ data }: { data: Rec }) {
  const [notice, setNotice] = useState("");
  const content = str(data.text);
  const filename = str(data.default_filename).split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f<>:"|?*]/g, "_") || "conversation.txt";
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(t("ui.ClaudeMenuPanels.plain_text_conversation_downloaded"));
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setNotice(t("ui.ClaudeMenuPanels.conversation_copied")); }
    catch { setNotice(t("ui.ClaudeMenuPanels.copy_failed_download_the_file_or_select")); }
  };
  if (typeof data.text !== "string") return <p className="new-error" role="alert">{str(data.error) || t("ui.ClaudeMenuPanels.the_cli_returned_no_conversation_text")}</p>;
  return <>
    <p className="new-hint">{t("ui.ClaudeMenuPanels.export_the_current_conversation_as_plain_text")}</p>
    <div className="info-actions">
      <button type="button" className="btn" onClick={download}>{t("ui.ClaudeMenuPanels.download_txt")}</button>
      <button type="button" className="btn" onClick={() => void copy()}>{t("ui.ClaudeMenuPanels.copy_conversation")}</button>
    </div>
    {notice && <p className="new-hint" role="status">{notice}</p>}
    <pre className="info-row info-code menu-export-preview">{content || t("ui.ClaudeMenuPanels.empty_conversation")}</pre>
  </>;
}
