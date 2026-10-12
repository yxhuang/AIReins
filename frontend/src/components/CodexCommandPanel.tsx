import { t } from "../i18n";
import { useEffect, useRef } from "react";

export interface CodexCommandResult {
  name: string;
  data?: Record<string, unknown>;
  error?: string;
}

const labels: Record<string, string> = {
  status: t("ui.common.status"), model: t("ui.CodexCommandPanel.available_models"), mcp: t("ui.CodexCommandPanel.mcp_status"), skills: "Skills",
  compact: t("ui.CodexCommandPanel.compact_context"), review: t("ui.CodexCommandPanel.code_review"), new: t("ui.common.new_session"), interrupt: t("ui.CodexCommandPanel.interrupt_execution"),
};
const rec = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(rec) : [];
const str = (value: unknown) => typeof value === "string" ? value : "";

export function CodexCommandPanel({ result, onClose }: { result: CodexCommandResult; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const data = result.data;
  const entries = data ? rows(result.name === "skills" ? data.skills : data.data) : [];
  return <div className="dir-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dir-dialog info-dialog codex-command-modal" role="dialog" aria-modal="true" aria-label={`Codex · ${labels[result.name]}`}>
      <div className="dir-heading"><h2>Codex · {labels[result.name]}</h2><button ref={closeRef} type="button" className="btn" aria-label={t("ui.common.close")} onClick={onClose}>{t("ui.common.close")}</button></div>
      <div className="dir-list info-body">
        {result.error && <p className="config-error" role="alert">{result.error}</p>}
        {!data && !result.error && <p role="status">{t("ui.common.reading")}</p>}
        {data && ["skills", "model", "mcp"].includes(result.name) && <>
          {entries.length === 0 && <p>{t("ui.CodexCommandPanel.no_entries_available")}</p>}
          {entries.map((entry, i) => <div className="info-row" key={i}>
            <div className="info-name mono">{result.name === "skills" ? "$" : ""}{str(entry.name) || str(entry.displayName) || str(entry.model) || str(entry.id)}</div>
            {entry.description ? <p>{str(entry.description)}</p> : null}
            {result.name === "skills" && <p className="mono">{str(entry.scope)} · {str(entry.path)}</p>}
            {result.name === "mcp" && <>
              <p>{t("ui.CodexCommandPanel.connection_authentication_tools_sentence", { p0: (str(entry.runtimeStatus) || t("ui.CodexCommandPanel.not_reported")), p1: (str(entry.authStatus) || t("ui.CodexCommandPanel.not_reported")), p2: (Object.keys(rec(entry.tools)).length) })}</p>
              {entry.toolsError ? <p className="config-error">{str(entry.toolsError)}</p> : null}
            </>}
          </div>)}
          {result.name === "model" && <p>{t("ui.CodexCommandPanel.use_the_model_menu_below_the_message")}</p>}
          {result.name === "skills" && rows(data.errors).map((error, i) => <p key={i} className="config-error">{str(error.path)}：{str(error.message)}</p>)}
        </>}
        {data && result.name === "status" && <pre className="codex-command-json mono">{JSON.stringify(data, null, 2)}</pre>}
        {data && typeof data.message === "string" && <p role="status">{data.message}</p>}
      </div>
    </div>
  </div>;
}
