import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cleanStorage, fetchStorage } from "../api";
import { store } from "../store";
import type { StorageStats } from "../types";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
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
      setResult(cleaned.freedBytes > 0 ? `已释放 ${formatBytes(cleaned.freedBytes)}` : "没有可清理的内容");
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
      <span className="settings-item-label">存储占用 {storage ? formatBytes(storage.totalBytes) : loading ? "读取中…" : "读取失败"}</span>
      {storage && <span className="settings-hint settings-storage-breakdown">
        会话记录 {formatBytes(storage.categories.transcripts.bytes)} · 附件 {formatBytes(storage.categories.uploads.bytes)} · 日志 {formatBytes(storage.categories.logs.bytes)} · 其他 {formatBytes(storage.categories.other.bytes)}
      </span>}
      {error && !dialogOpen && <span className="new-error" role="alert">{error}</span>}
      {result && <span className="settings-hint" role="status">{result}</span>}
      <button type="button" className="settings-action" ref={cleanButton} aria-haspopup="dialog"
        disabled={cleaning} onClick={() => {
          setIncludeEnded(false);
          setError("");
          onDialogOpenChange(true);
        }}>清理…</button>
    </div>
    {dialogOpen && createPortal(
      <div className="dir-overlay storage-overlay" onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          closeDialog();
          return;
        }
        if (event.key !== "Tab") return;
        const focusables = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!focusables?.length) { event.preventDefault(); dialog.current?.focus(); return; }
        const first = focusables.item(0);
        const last = focusables.item(focusables.length - 1);
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.current?.contains(active))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.current?.contains(active))) {
          event.preventDefault(); first.focus();
        }
      }}>
        <div className="dir-dialog storage-dialog" ref={dialog} tabIndex={-1} role="dialog"
          aria-modal="true" aria-labelledby="storage-clean-title" aria-describedby="storage-clean-description">
          <div className="dir-heading">
            <h2 id="storage-clean-title">清理 Workbench 存储</h2>
            <button type="button" className="btn" onClick={closeDialog} aria-label="关闭清理弹层">关闭</button>
          </div>
          {storage ? <>
            <div className="storage-clean-items">
              <p>日志轮转副本：{storage.cleanable.rotatedLogs.files} 个，{formatBytes(storage.cleanable.rotatedLogs.bytes)}</p>
              <p>孤儿文件：{storage.cleanable.orphans.files} 个，{formatBytes(storage.cleanable.orphans.bytes)}</p>
            </div>
            <label className="storage-ended-option">
              <input type="checkbox" checked={includeEnded} disabled={cleaning}
                onChange={(event) => setIncludeEnded(event.target.checked)} />
              <span>同时移除 {storage.cleanable.ended.sessions} 个已结束会话（{formatBytes(storage.cleanable.ended.bytes)}）</span>
            </label>
            {noCleanableItems && <p className="settings-hint">当前无可清理项。占用来自左栏仍在的 {storage.categories.transcripts.sessions} 个会话的记录和附件，在左栏移除会话才会释放。</p>}
          </> : <p className="settings-hint">{loading ? "正在读取存储统计…" : "存储统计读取失败，请重试。"}</p>}
          <p className="settings-hint" id="storage-clean-description">只删工作台里的副本，CLI 原生记录保留，可在『历史会话』里续接。</p>
          {error && <p className="new-error" role="alert">{error}</p>}
          <div className="dir-actions">
            {!storage && <button type="button" className="btn" disabled={loading} onClick={() => void retry()}>重新读取</button>}
            <button type="button" className="btn" disabled={!storage || cleaning || Boolean(noCleanableItems)} onClick={() => void clean()}>
              {cleaning ? "清理中…" : "确认清理"}
            </button>
          </div>
        </div>
      </div>, document.body,
    )}
  </>;
}
