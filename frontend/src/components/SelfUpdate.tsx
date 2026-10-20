import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyUpdate, fetchUpdateStatus, type UpdateResult, type UpdateStatus } from "../api";
import { modalKeyDown } from "./useAnchoredMenu";

type Phase = "checking" | "confirm" | "applying" | "done" | "failed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提交摘要或改动列表；服务端各最多给 20 条，total 超出时注明还有多少。 */
function LogList({ items, total }: { items: string[]; total: number }) {
  return <pre className="self-update-log">{items.join("\n")}{total > items.length ? `\n${t("ui.SelfUpdate.more", { p0: total - items.length })}` : ""}</pre>;
}

/** 设置里的「更新 {product}」：先与远端对比，按结果确认拉取（并构建）或提交推送。 */
export function SelfUpdate({ dialogOpen, onDialogOpenChange, onRestart }: {
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
  onRestart: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (dialogOpen) dialog.current?.focus();
  }, [dialogOpen]);
  useEffect(() => {
    // 执行中按钮都禁用，焦点放回弹窗本身，键盘事件仍经过 modalKeyDown。
    if (phase === "checking" || phase === "applying") dialog.current?.focus();
    else dialog.current?.querySelector<HTMLElement>("input, .dir-actions button:last-child")?.focus();
  }, [phase]);

  const check = async () => {
    if (pending.current) return;
    pending.current = true;
    setPhase("checking");
    setStatus(null);
    setResult(null);
    setError("");
    try {
      setStatus(await fetchUpdateStatus());
      setPhase("confirm");
    } catch (reason) {
      setError(errorMessage(reason));
      setPhase("failed");
    } finally {
      pending.current = false;
    }
  };

  const open = () => {
    setMessage("");
    onDialogOpenChange(true);
    void check();
  };

  const close = () => {
    if (phase === "applying") return;
    onDialogOpenChange(false);
    // 等设置面板的 inert 移除后，把焦点交回发起按钮。
    requestAnimationFrame(() => button.current?.focus());
  };

  const apply = async () => {
    if (!status || pending.current) return;
    pending.current = true;
    setPhase("applying");
    setError("");
    try {
      setResult(await applyUpdate(status, message));
      setPhase("done");
    } catch (reason) {
      setError(errorMessage(reason));
      setPhase("failed");
    } finally {
      pending.current = false;
    }
  };

  const action = status?.action;
  const title = phase === "done" ? (result?.action === "pull" ? t("ui.SelfUpdate.pulled") : t("ui.SelfUpdate.pushed"))
    : action === "pull" ? t("ui.SelfUpdate.pull_title")
    : action === "push" ? t("ui.SelfUpdate.commit_and_push")
    : action === "diverged" ? t("ui.SelfUpdate.diverged_title")
    : action === "none" ? t("ui.SelfUpdate.up_to_date") : t("ui.SelfUpdate.update");
  const needsMessage = action === "push" && (status?.changes.length ?? 0) > 0;

  return <>
    <button type="button" className="settings-action" ref={button} aria-haspopup="dialog" onClick={open}>{t("ui.SelfUpdate.update")}</button>
    {dialogOpen && createPortal(
      <div className="dir-overlay storage-overlay" onKeyDown={(event) => modalKeyDown(event, dialog.current, close)}>
        <div className="dir-dialog storage-dialog" ref={dialog} tabIndex={-1} role="dialog"
          aria-modal="true" aria-labelledby="self-update-title" aria-busy={phase === "checking" || phase === "applying"}>
          <div className="dir-heading">
            <h2 id="self-update-title">{title}</h2>
          </div>
          {phase === "checking" && <p className="settings-hint" role="status">{t("ui.SelfUpdate.checking")}</p>}
          {status && phase !== "done" && <>
            {action === "none" && <p>{t("ui.SelfUpdate.none", { p0: status.branch, p1: status.upstream })}</p>}
            {action === "pull" && <>
              <p>{t("ui.SelfUpdate.behind", { p0: status.branch, p1: status.upstream, p2: status.behind })}</p>
              <LogList items={status.behindLog} total={status.behind} />
              {status.changes.length > 0 && <p className="settings-hint">{t("ui.SelfUpdate.keep_changes", { p0: status.changes.length })}</p>}
            </>}
            {action === "diverged" && <>
              <p>{t("ui.SelfUpdate.diverged", { p0: status.upstream, p1: status.ahead, p2: status.behind })}</p>
              <LogList items={status.aheadLog} total={status.ahead} />
              <LogList items={status.behindLog} total={status.behind} />
            </>}
            {action === "push" && <>
              {status.ahead > 0 && <>
                <p>{t("ui.SelfUpdate.ahead", { p0: status.upstream, p1: status.ahead })}</p>
                <LogList items={status.aheadLog} total={status.ahead} />
              </>}
              {needsMessage && <>
                <p>{t("ui.SelfUpdate.changes", { p0: status.changes.length })}</p>
                <LogList items={status.changes} total={status.changes.length} />
                <label className="new-field">
                  {t("ui.SelfUpdate.commit_message")}
                  <input value={message} placeholder={status.defaultMessage} maxLength={500} disabled={phase === "applying"} onChange={(event) => setMessage(event.target.value)} />
                </label>
              </>}
            </>}
          </>}
          {phase === "applying" && <p className="settings-hint" role="status">{action === "pull" ? t("ui.SelfUpdate.pulling") : t("ui.SelfUpdate.pushing")}</p>}
          {phase === "done" && result && <>
            {result.output && <pre className="self-update-log">{result.output}</pre>}
            {result.action === "pull" && <p className="settings-hint">{result.restart ? t("ui.SelfUpdate.restart_needed") : t("ui.SelfUpdate.refresh_hint")}</p>}
          </>}
          {error && <p className="new-error" role="alert">{error}</p>}
          <div className="dir-actions">
            <button type="button" className="btn" disabled={phase === "applying"} onClick={close}>
              {phase === "confirm" && (action === "pull" || action === "push") ? t("ui.common.cancel") : t("ui.common.close")}
            </button>
            {phase === "failed" && <button type="button" className="btn" onClick={() => void check()}>{t("ui.SelfUpdate.check_again")}</button>}
            {(phase === "confirm" || phase === "applying") && (action === "pull" || action === "push") && (
              <button type="button" className="btn" disabled={phase === "applying"} onClick={() => void apply()}>
                {action === "pull" ? t("ui.SelfUpdate.pull_and_build") : t("ui.SelfUpdate.commit_and_push")}
              </button>
            )}
            {phase === "done" && result?.action === "pull" && <>
              {result.restart && <button type="button" className="btn" onClick={() => { onDialogOpenChange(false); onRestart(); }}>{t("ui.SettingsMenu.restart")}</button>}
              <button type="button" className="btn" onClick={() => window.location.reload()}>{t("ui.SelfUpdate.refresh")}</button>
            </>}
          </div>
        </div>
      </div>, document.body,
    )}
  </>;
}
