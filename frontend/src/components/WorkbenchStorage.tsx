import { t, formatNumber } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanStorage, fetchStorage } from "../api";
import { store } from "../store";
import { modalKeyDown } from "./useAnchoredMenu";
import type { StorageStats } from "../types";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${formatNumber(bytes / 1024 ** 3, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1024 ** 2) return `${formatNumber(bytes / 1024 ** 2, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  return `${formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 设置面板每次打开时挂载，读取一次；清理结果直接提供最新统计。 */
export function WorkbenchStorage({ dialogOpen, onDialogOpenChange }: {
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
}) {
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [includeEnded, setIncludeEnded] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState("");
  const cleanButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cleanPending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchStorage(controller.signal)
      .then((stats) => { if (!controller.signal.aborted) setStorage(stats); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (dialogOpen) dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [dialogOpen]);

  const closeDialog = () => {
    onDialogOpenChange(false);
    // 等设置面板的 inert 移除后，把焦点交回发起按钮。
    requestAnimationFrame(() => cleanButton.current?.focus());
  };

  const retry = async () => {
    setLoading(true);
    setError("");
    try { setStorage(await fetchStorage()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  };

  const clean = async () => {
    if (!storage || cleanPending.current) return;
    cleanPending.current = true;
    setCleaning(true);
    setError("");
    setResult("");
    try {
      const cleaned = await cleanStorage(includeEnded);
      setStorage(cleaned.storage);
      setResult(cleaned.freedBytes > 0 ? t("ui.WorkbenchStorage.freed", { p0: (formatBytes(cleaned.freedBytes)) }) : t("ui.WorkbenchStorage.nothing_to_clean_up"));
      await store.refreshSessions();
      closeDialog();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      cleanPending.current = false;
      setCleaning(false);
    }
  };

  const noCleanableItems = storage && storage.cleanable.bytes === 0
    && storage.cleanable.rotatedLogs.files === 0 && storage.cleanable.orphans.files === 0
    && storage.cleanable.orphans.uploadDirs === 0 && storage.cleanable.ended.sessions === 0;

  return <>
    <div className="settings-item settings-storage">
      <span className="settings-item-label">{t("ui.WorkbenchStorage.storage_usage_sentence", { p0: (storage ? formatBytes(storage.totalBytes) : loading ? t("ui.common.reading_2") : t("ui.common.read_failed")) })}</span>
      <span className="settings-hint settings-storage-breakdown" aria-busy={loading}>
        {storage ? <>{t("ui.WorkbenchStorage.session_records")} {formatBytes(storage.categories.transcripts.bytes)} {t("ui.WorkbenchStorage.attachments")} {formatBytes(storage.categories.uploads.bytes)} {t("ui.WorkbenchStorage.logs")} {formatBytes(storage.categories.logs.bytes)} {t("ui.WorkbenchStorage.other")} {formatBytes(storage.categories.other.bytes)}</>
          : t("ui.WorkbenchStorage.session_records_attachments_logs_other")}
      </span>
      {error && !dialogOpen && <span className="new-error" role="alert">{error}</span>}
      {result && <span className="settings-hint" role="status">{result}</span>}
      <button type="button" className="settings-action" ref={cleanButton} aria-haspopup="dialog"
        disabled={cleaning} onClick={() => {
          setIncludeEnded(false);
          setError("");
          onDialogOpenChange(true);
        }}>{t("ui.WorkbenchStorage.clean_up")}</button>
    </div>
    {dialogOpen && createPortal(
      <div className="dir-overlay storage-overlay" onKeyDown={(event) => modalKeyDown(event, dialog.current, closeDialog)}>
        <div className="dir-dialog storage-dialog" ref={dialog} tabIndex={-1} role="dialog"
          aria-modal="true" aria-labelledby="storage-clean-title" aria-describedby="storage-clean-description">
          <div className="dir-heading">
            <h2 id="storage-clean-title">{t("ui.WorkbenchStorage.clean_up_storage")}</h2>
            <button type="button" className="btn" onClick={closeDialog} aria-label={t("ui.WorkbenchStorage.close_cleanup_dialog")}>{t("ui.common.close")}</button>
          </div>
          {storage ? <>
            <div className="storage-clean-items">
              <p>{t("ui.WorkbenchStorage.rotated_log_copies_sentence", { p0: (storage.cleanable.rotatedLogs.files), p1: (formatBytes(storage.cleanable.rotatedLogs.bytes)) })}</p>
              <p>{t("ui.WorkbenchStorage.orphaned_files_sentence", { p0: (storage.cleanable.orphans.files), p1: (formatBytes(storage.cleanable.orphans.bytes)) })}</p>
            </div>
            <label className="storage-ended-option">
              <input type="checkbox" checked={includeEnded} disabled={cleaning}
                onChange={(event) => setIncludeEnded(event.target.checked)} />
              <span>{t("ui.WorkbenchStorage.also_remove_ended_sessions_sentence", { p0: (storage.cleanable.ended.sessions), p1: (formatBytes(storage.cleanable.ended.bytes)) })}</span>
            </label>
            {noCleanableItems && <p className="settings-hint">{t("ui.WorkbenchStorage.nothing_to_clean_up_storage_belongs_to_sentence", { p0: (storage.categories.transcripts.sessions) })}</p>}
          </> : <p className="settings-hint">{loading ? t("ui.WorkbenchStorage.reading_storage_statistics") : t("ui.WorkbenchStorage.could_not_read_storage_statistics_please_retry")}</p>}
          <p className="settings-hint" id="storage-clean-description">{t("ui.WorkbenchStorage.only_workspace_copies_will_be_deleted_native")}</p>
          {error && <p className="new-error" role="alert">{error}</p>}
          <div className="dir-actions">
            {!storage && <button type="button" className="btn" disabled={loading} onClick={() => void retry()}>{t("ui.WorkbenchStorage.reload")}</button>}
            <button type="button" className="btn" disabled={!storage || cleaning || Boolean(noCleanableItems)} onClick={() => void clean()}>
              {cleaning ? t("ui.WorkbenchStorage.cleaning_up") : t("ui.WorkbenchStorage.confirm_cleanup")}
            </button>
          </div>
        </div>
      </div>, document.body,
    )}
  </>;
}
