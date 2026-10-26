import { t } from "../i18n";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { compactSessionContext, fetchSessionInfo } from "../api";
import { contextPercent } from "../context-usage";
import type { SessionRecord } from "../types";
import { type Store } from "../store";
import { useStore } from "../useStore";
import { useAnchoredMenu } from "./useAnchoredMenu";

export function ContextUsage({ session }: { session: SessionRecord }) {
  const selectUsage = useCallback((value: Store) => value.data.get(session.id)?.latestUsage, [session.id]);
  const latestUsage = useStore(selectUsage) ?? session.snapshotState?.latestUsage;
  const pendingGates = useStore(value => value.pendingCountFor(session));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useAnchoredMenu({ open, rootRef, buttonRef, panelRef, initialFocus: "button:not(:disabled)",
    close: returnFocus => { setOpen(false); if (returnFocus) buttonRef.current?.focus(); } });
  const model = session.config?.model;
  const [claudeContext, setClaudeContext] = useState<{ id: string; model: typeof model; payload: unknown } | null>(null);
  // 只查询已有 worker；不为显示圆环唤醒已释放或已结束会话。
  const canQuery = session.agent === "claude" && Boolean(session.processId) && !session.released
    && session.status !== "starting" && session.status !== "dead";
  useEffect(() => {
    if (!canQuery) return;
    const controller = new AbortController();
    // 初次打开和回合用量更新时各查一次，与扩展使用同一只读接口；不轮询。
    fetchSessionInfo(session.id, "context", controller.signal).then(payload => {
      if (!controller.signal.aborted) setClaudeContext({ id: session.id, model, payload });
    }).catch(() => {
      if (!controller.signal.aborted) setClaudeContext(null);
    });
    return () => controller.abort();
  }, [session.id, session.status, model, canQuery, latestUsage]);

  const payload = session.agent === "claude"
    ? claudeContext?.id === session.id && claudeContext.model === model ? claudeContext.payload : undefined
    : latestUsage;
  const percent = contextPercent(session.agent, payload);
  const label = percent === null ? t("ui.ContextUsage.context_usage_is_unavailable") : t("ui.ContextUsage.about_of_context_used", { p0: (Math.round(percent)) });
  const unavailable = session.status !== "idle" || pendingGates > 0 || Boolean(session.backgroundTasks?.length);
  const compact = async () => {
    if (submitting.current || accepted || unavailable) return;
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      await compactSessionContext(session.id);
      setAccepted(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { submitting.current = false; setBusy(false); }
  };
  return (
    <div className="context-usage-wrap" ref={rootRef}>
      <button type="button" ref={buttonRef} className={`context-usage${percent === null ? " unknown" : ""}`}
        aria-label={label} title={label} data-tooltip={open ? undefined : label}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId}
        onClick={() => { setOpen(value => !value); if (!submitting.current) { setAccepted(false); setError(null); } }}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle className="context-usage-track" cx="10" cy="10" r="8" strokeWidth="2" />
          {percent !== null && <circle className="context-usage-fill" cx="10" cy="10" r="8" strokeWidth="2"
            pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 10 10)" />}
          {percent === null && <text x="10" y="13" textAnchor="middle" fill="currentColor" fontSize="9">?</text>}
        </svg>
      </button>
      {open && <div id={menuId} ref={panelRef} className="cfg-menu context-usage-menu" role="dialog"
        aria-label={t("ui.ContextUsage.context")} tabIndex={-1}>
        <strong>{label}</strong>
        <p>{t("ui.ContextUsage.compact_description")}</p>
        {unavailable && <p>{t("ui.ContextUsage.wait_until_idle")}</p>}
        {error && <p className="config-error" role="alert">{error}</p>}
        {accepted && <p role="status">{t("ui.ContextUsage.request_accepted")}</p>}
        <button type="button" className="btn context-compact" disabled={unavailable || busy || accepted}
          aria-busy={busy} onClick={compact}>
          {t(busy ? "ui.ContextUsage.compacting" : "ui.CodexCommandPanel.compact_context")}
        </button>
      </div>}
    </div>
  );
}
