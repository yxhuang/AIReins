import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { SessionRecord } from "../types";
import { sessionTitle } from "../format";

export function PermanentDeleteConfirm({ session, busy, error, onCancel, onConfirm }: {
  session: SessionRecord; busy: boolean; error: string | null;
  onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const unsupported = session.agent === "claude" ? "Claude 当前没有已核实的单会话彻底删除接口，请使用「移除」。"
    : !session.nativeSessionId ? "此会话尚无原生会话 ID，请使用「移除」。" : null;
  const blocked = !["idle", "dead", "error"].includes(session.status) || Boolean(session.backgroundTasks?.length);
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus(); }, []);
  const content = <div className="dir-overlay permanent-delete-overlay" onPointerDown={(event) => {
    if (!busy && event.target === event.currentTarget) onCancel();
  }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); if (!busy) onCancel(); return; }
    if (event.key !== "Tab") return;
    const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) { event.preventDefault(); dialog.current?.focus(); return; }
    const first = buttons.item(0), last = buttons.item(buttons.length - 1);
    const outside = !dialog.current?.contains(document.activeElement);
    if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
  }}>
    <div className="dir-dialog permanent-delete-dialog" ref={dialog} tabIndex={-1} role="dialog"
      aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
      <div className="dir-heading"><h2 id={titleId}>彻底删除会话</h2></div>
      <div className="permanent-delete-body">
        <p><strong>{sessionTitle(session)}</strong></p>
        <p className="mono">{session.agent} · {session.nativeSessionId ?? "无原生会话 ID"}</p>
        <p id={descriptionId}>确认彻底删除此会话？Workbench 记录、独占附件及此会话的原生本地历史将一并删除，CLI / VS Code 将无法续接。此操作无法恢复。</p>
        {unsupported && <p role="alert">{unsupported}</p>}
        {blocked && <p role="alert">请先停止当前执行及后台任务，等会话空闲或结束后再彻底删除。</p>}
        {error && <p className="session-confirm-error" role="alert">{error}</p>}
      </div>
      <div className="dir-actions">
        <button type="button" className="btn" data-autofocus disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="btn btn-danger" disabled={busy || Boolean(unsupported) || blocked}
          onClick={onConfirm}>{busy ? "彻底删除中…" : "彻底删除"}</button>
      </div>
    </div>
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
