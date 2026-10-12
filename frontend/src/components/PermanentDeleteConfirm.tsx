import { t } from "../i18n";
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
  const unsupported = session.agent === "claude" ? t("ui.PermanentDeleteConfirm.claude_has_no_verified_api_to_permanently")
    : !session.nativeSessionId ? t("ui.PermanentDeleteConfirm.this_session_has_no_native_session_id") : null;
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
      <div className="dir-heading"><h2 id={titleId}>{t("ui.PermanentDeleteConfirm.permanently_delete_session")}</h2></div>
      <div className="permanent-delete-body">
        <p><strong>{sessionTitle(session)}</strong></p>
        <p className="mono">{session.agent} · {session.nativeSessionId ?? t("ui.PermanentDeleteConfirm.no_native_session_id")}</p>
        <p id={descriptionId}>{t("ui.PermanentDeleteConfirm.permanently_delete_this_session_the_record_its")}</p>
        {unsupported && <p role="alert">{unsupported}</p>}
        {blocked && <p role="alert">{t("ui.PermanentDeleteConfirm.stop_execution_and_background_tasks_first_wait")}</p>}
        {error && <p className="session-confirm-error" role="alert">{error}</p>}
      </div>
      <div className="dir-actions">
        <button type="button" className="btn" data-autofocus disabled={busy} onClick={onCancel}>{t("ui.common.cancel")}</button>
        <button type="button" className="btn btn-danger" disabled={busy || Boolean(unsupported) || blocked}
          onClick={onConfirm}>{busy ? t("ui.PermanentDeleteConfirm.permanently_deleting") : t("ui.common.permanently_delete")}</button>
      </div>
    </div>
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
