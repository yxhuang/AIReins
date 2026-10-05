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
    {dirty && <p className="new-hint" role="status">未保存修改。</p>}
    {error && <p className="new-error" role="alert">{error}</p>}
    {loading ? <p className="new-hint" role="status">正在读取文件…</p> : file && <>
      {file.reason && <p className="new-hint" role="status">{file.reason}</p>}
      <div className="file-preview-body">
        {file.text !== undefined && (source || !rich) ?
          <textarea className="file-source mono" aria-label="文件源码" value={draft} readOnly={!file.editable || saving} spellCheck={false} wrap="soft"
            onChange={event => store.updateFileDraft(event.target.value)} onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void store.saveFilePreview(); }
            }} /> :
          file.kind === "markdown" ? <div className="markdown-message file-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]}
            components={{ a: ({ href, children }) => <span title={href}>{children}</span>, img: ({ alt }) => <span>[图片：{alt}]</span> }}>{draft}</Markdown></div> :
          table ? <div className="file-table-scroll">
            {table.truncated && <p className="new-hint">表格已截断显示。</p>}
            {table.error && <p className="new-error" role="alert">{table.error}</p>}
            <table className="file-table"><tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>
          </div> :
          file.kind === "html" ? <div className="file-html">
            <iframe sandbox="" referrerPolicy="no-referrer" title="HTML 隔离预览" srcDoc={html} />
          </div> :
          file.kind === "image" ? failedLoad === preview.loadId ? <p className="new-error" role="alert">图片无法显示，请外部打开。</p> :
            <img className="file-image" src={contentUrl} alt={file.name} onError={() => setFailedLoad(preview.loadId)} /> :
          file.kind === "pdf" ? <div className="file-pdf">
            {inlinePdf ? <iframe title="PDF 文件预览" src={contentUrl} /> : <p className="new-hint" role="status">此浏览器未启用内嵌 PDF 查看器，请使用顶栏“外部打开”。</p>}
          </div> : <p className="new-hint">此文件暂不支持面板预览。</p>}
      </div>
    </>}
  </div>;
}
