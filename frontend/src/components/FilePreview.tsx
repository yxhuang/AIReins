import { t } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchDirectories, workFileContentUrl } from "../api";
import { imageNeighbors, isolatedHtml, parseDelimited, resolveLocalFileLink } from "../file-preview";
import { FileLinkContext, MessageLink } from "./MarkdownMessage";
import { store } from "../store";
import type { DirectoryEntry, FilePreviewState } from "../types";

// 预览按路径重挂载，切图时沿用上一张的同目录列表，避免左右按钮闪烁。
let imageDirectory: { path: string; files: DirectoryEntry[] } | null = null;
// 触控板一次手势、鼠标快速连滚都是一串 wheel；间隔超过此值才算新一次切换。
const WHEEL_GAP_MS = 200;
let lastWheelAt = 0;

export function FilePreview({ preview, source = false, tabId }: { preview: FilePreviewState; source?: boolean; tabId?: number }) {
  const { file, target, draft, loading, saving, error } = preview;
  const cwd = target.path.slice(0, target.path.lastIndexOf("/")) || "/";
  const isImage = file?.kind === "image";
  const [siblings, setSiblings] = useState(() => imageDirectory?.path === cwd ? imageDirectory.files : []);
  useEffect(() => {
    if (!isImage) return;
    let live = true;
    // 列表失败只是没有左右切换，不影响当前图片。
    fetchDirectories(cwd, true).then(listing => {
      imageDirectory = { path: cwd, files: listing.files ?? [] };
      if (live) setSiblings(imageDirectory.files);
    }, () => {});
    return () => { live = false; };
  }, [isImage, cwd]);
  const neighbors = isImage ? imageNeighbors(siblings, target.path) : null;
  const showImage = (path: string | null) => { if (path) void store.openFilePreview({ path, root: target.root, sessionId: target.sessionId }, tabId); };
  const [failedLoad, setFailedLoad] = useState<number | null>(null);
  const [stoppedScriptsLoadId, setStoppedScriptsLoadId] = useState<number | null>(null);
  const runScripts = stoppedScriptsLoadId !== preview.loadId;
  const table = useMemo(() => !source && (file?.kind === "csv" || file?.kind === "tsv")
    ? parseDelimited(draft, file.kind === "tsv" ? "\t" : ",") : null, [file?.kind, draft, source]);
  const html = useMemo(() => file?.kind === "html" && !source ? isolatedHtml(draft, runScripts) : "", [file?.kind, draft, source, runScripts]);
  const dirty = file?.editable && draft !== file.text;
  const rich = file && ["markdown", "csv", "tsv", "html"].includes(file.kind);
  const contentUrl = `${workFileContentUrl(target)}&v=${preview.loadId}`;
  // 旧浏览器没有该字段时仍尝试原生导航；明确关闭查看器时避免空白框或自动下载。
  const inlinePdf = typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
  return <div className="file-preview">
    {dirty && <p className="new-hint" role="status">{t("ui.FilePreview.unsaved_changes")}</p>}
    {error && <p className="new-error" role="alert">{error}</p>}
    {loading ? <p className="new-hint" role="status">{t("ui.FilePreview.reading_file")}</p> : file && <>
      {file.reason && <p className="new-hint" role="status">{file.reason}</p>}
      {file.large && file.text === undefined ? <div className="file-large">
        <p className="new-hint">{t("ui.FilePreview.large_file_sentence", { p0: (file.size / 1024 / 1024).toFixed(1) })}</p>
        <button type="button" className="btn" onClick={() => void store.openFilePreview({ ...target, large: true }, tabId)}>{t("ui.FilePreview.load_anyway")}</button>
      </div> : <div className="file-preview-body">
        {file.text !== undefined && (source || !rich) ?
          <textarea className="file-source mono" aria-label={t("ui.FilePreview.file_source")} value={draft} readOnly={!file.editable || saving} spellCheck={false} wrap="soft"
            onChange={event => store.updateFileDraft(event.target.value, tabId)} onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void store.saveFilePreview(tabId); }
            }} /> :
          file.kind === "markdown" ? <div className="markdown-message file-markdown"><FileLinkContext value={{ cwd, root: target.root, sessionId: target.sessionId }}><Markdown skipHtml remarkPlugins={[remarkGfm]}
            urlTransform={(url, key) => key === "href" && resolveLocalFileLink(url, cwd, store.meta?.capabilities.windowsPaths === true) ? url : defaultUrlTransform(url)}
            components={{ a: MessageLink, img: ({ alt }) => <span>{t("ui.FilePreview.image_sentence", { p0: (alt ?? "") })}</span> }}>{draft}</Markdown></FileLinkContext></div> :
          table ? <div className="file-table-scroll">
            {table.truncated && <p className="new-hint">{t("ui.FilePreview.table_display_has_been_truncated")}</p>}
            {table.error && <p className="new-error" role="alert">{table.error}</p>}
            <table className="file-table"><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>
          </div> :
          file.kind === "html" ? <div className="file-html">
            <div className="file-html-controls">
              <button type="button" className="btn" aria-pressed={runScripts} onClick={() => setStoppedScriptsLoadId(runScripts ? preview.loadId : null)}>
                {t(runScripts ? "ui.FilePreview.stop_scripts" : "ui.FilePreview.run_scripts")}
              </button>
              <span className="new-hint">{t(runScripts ? "ui.FilePreview.scripts_running" : "ui.FilePreview.scripts_disabled")}</span>
            </div>
            <iframe key={runScripts ? "interactive" : "static"} sandbox={runScripts ? "allow-scripts" : ""} allowFullScreen={runScripts}
              referrerPolicy="no-referrer" title={t("ui.FilePreview.isolated_html_preview")} srcDoc={html}
              onLoad={event => { if (runScripts && event.currentTarget.getClientRects().length) event.currentTarget.contentWindow?.focus(); }} />
          </div> :
          file.kind === "image" ? <div className="file-image-view">
            <div className="file-image-scroll" onWheel={event => {
              const gap = event.timeStamp - lastWheelAt;
              lastWheelAt = event.timeStamp;
              // Ctrl+滚轮留给浏览器缩放；长图先滚到底/顶，停一下再滚才切换。
              if (!neighbors || event.ctrlKey || !event.deltaY || gap < WHEEL_GAP_MS) return;
              const el = event.currentTarget;
              const down = event.deltaY > 0;
              if (down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return;
              showImage(down ? neighbors.next : neighbors.prev);
            }}>
              {failedLoad === preview.loadId ? <p className="new-error" role="alert">{t("ui.FilePreview.cannot_display_this_image_open_it_externally")}</p> :
                <img className="file-image" src={contentUrl} alt={file.name} onError={() => setFailedLoad(preview.loadId)} />}
            </div>
            {neighbors && <>
              <button type="button" className="file-image-nav file-image-prev" aria-label={t("ui.FilePreview.previous_image")} title={t("ui.FilePreview.previous_image")}
                disabled={!neighbors.prev} onClick={() => showImage(neighbors.prev)}>‹</button>
              <button type="button" className="file-image-nav file-image-next" aria-label={t("ui.FilePreview.next_image")} title={t("ui.FilePreview.next_image")}
                disabled={!neighbors.next} onClick={() => showImage(neighbors.next)}>›</button>
              <span className="file-image-count">{t("ui.FilePreview.image_position", { p0: neighbors.index + 1, p1: neighbors.total })}</span>
            </>}
          </div> :
          file.kind === "pdf" ? <div className="file-pdf">
            {inlinePdf ? <iframe title={t("ui.FilePreview.pdf_preview")} src={contentUrl} /> : <p className="new-hint" role="status">{t("ui.FilePreview.this_browser_has_no_enabled_inline_pdf")}</p>}
          </div> : <p className="new-hint">{t("ui.FilePreview.this_file_cannot_be_previewed_in_the")}</p>}
      </div>}
    </>}
  </div>;
}
