import { t } from "../i18n";
import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workFileContentUrl } from "../api";
import { isolatedHtml, parseDelimited } from "../file-preview";
import { store } from "../store";
import type { FilePreviewState } from "../types";

export function FilePreview({ preview, source = false }: { preview: FilePreviewState; source?: boolean }) {
  const { file, target, draft, loading, saving, error } = preview;
  const [failedLoad, setFailedLoad] = useState<number | null>(null);
  const table = useMemo(() => file?.kind === "csv" || file?.kind === "tsv"
    ? parseDelimited(draft, file.kind === "tsv" ? "\t" : ",") : null, [file?.kind, draft]);
  const html = useMemo(() => file?.kind === "html" && !source ? isolatedHtml(draft) : "", [file?.kind, draft, source]);
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
        <button type="button" className="btn" onClick={() => void store.openFilePreview({ ...target, large: true })}>{t("ui.FilePreview.load_anyway")}</button>
      </div> : <div className="file-preview-body">
        {file.text !== undefined && (source || !rich) ?
          <textarea className="file-source mono" aria-label={t("ui.FilePreview.file_source")} value={draft} readOnly={!file.editable || saving} spellCheck={false} wrap="soft"
            onChange={event => store.updateFileDraft(event.target.value)} onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void store.saveFilePreview(); }
            }} /> :
          file.kind === "markdown" ? <div className="markdown-message file-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]}
            components={{ a: ({ href, children }) => <span title={href}>{children}</span>, img: ({ alt }) => <span>{t("ui.FilePreview.image_sentence", { p0: (alt ?? "") })}</span> }}>{draft}</Markdown></div> :
          table ? <div className="file-table-scroll">
            {table.truncated && <p className="new-hint">{t("ui.FilePreview.table_display_has_been_truncated")}</p>}
            {table.error && <p className="new-error" role="alert">{table.error}</p>}
            <table className="file-table"><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>
          </div> :
          file.kind === "html" ? <div className="file-html">
            <iframe sandbox="" referrerPolicy="no-referrer" title={t("ui.FilePreview.isolated_html_preview")} srcDoc={html} />
          </div> :
          file.kind === "image" ? failedLoad === preview.loadId ? <p className="new-error" role="alert">{t("ui.FilePreview.cannot_display_this_image_open_it_externally")}</p> :
            <img className="file-image" src={contentUrl} alt={file.name} onError={() => setFailedLoad(preview.loadId)} /> :
          file.kind === "pdf" ? <div className="file-pdf">
            {inlinePdf ? <iframe title={t("ui.FilePreview.pdf_preview")} src={contentUrl} /> : <p className="new-hint" role="status">{t("ui.FilePreview.this_browser_has_no_enabled_inline_pdf")}</p>}
          </div> : <p className="new-hint">{t("ui.FilePreview.this_file_cannot_be_previewed_in_the")}</p>}
      </div>}
    </>}
  </div>;
}
