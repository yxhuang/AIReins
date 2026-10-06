import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { workFileContentUrl } from "../api";
import { mentionQueryAt } from "../mentions";
import { store } from "../store";
import type { SessionRecord } from "../types";
import { useStore } from "../useStore";
import { DirectoryContents } from "./DirectoryBrowser";
import { FILE_WIDTH_OPTIONS, PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";
import { FilePreview } from "./FilePreview";
import { Segmented } from "./Segmented";

const PREVIEW_OPTIONS = [{ value: "preview", label: "预览", title: "查看渲染后的文档" }, { value: "source", label: "源码", title: "查看或编辑文档源码" }] as const;
const TABLE_OPTIONS = [{ value: "preview", label: "表格", title: "按表格查看数据" }, { value: "source", label: "源码", title: "查看或编辑原始数据" }] as const;
const ACTION_PATHS = {
  back: "m15 18-6-6 6-6",
  mention: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  copy: "M9 9h12v12H9z M15 5V3H3v12h2",
  open: "M15 3h6v6 M21 3 10 14 M10 3H3v18h18v-7",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4",
  save: "M3 3h15l3 3v15H3z M7 3v6h10V3 M7 21v-8h10v8",
};
function FileActionIcon({ kind }: { kind: keyof typeof ACTION_PATHS }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ACTION_PATHS[kind]} /></svg>;
}

function absolutePath(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** 纯判定：只产生 cwd 内可作为完整 @ token 的相对路径。 */
export function planFileMention(session: Pick<SessionRecord, "cwd" | "status"> | undefined, mentionsSupported: boolean, path: string):
  { path: string; reason: null } | { path: null; reason: string } {
  if (!session) return { path: null, reason: "没有当前会话，无法引用。可用“复制路径”。" };
  if (session.status === "dead") return { path: null, reason: "会话已结束，无法引用。可用“复制路径”。" };
  if (!mentionsSupported) return { path: null, reason: "当前 driver 不支持 @ 引用。可用“复制路径”。" };
  const root = absolutePath(session.cwd);
  const file = absolutePath(path);
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!root || !file || !file.startsWith(prefix) || file === root) {
    return { path: null, reason: "文件不在会话 cwd 之下，无法引用。可用“复制路径”。" };
  }
  const relative = file.slice(prefix.length);
  if (/\s/u.test(relative)) return { path: null, reason: "相对路径含空白字符，@ 引用会被截断。请用“复制路径”。" };
  return { path: relative, reason: null };
}

/** 复用 mentionQueryAt 的边界判定，避免另存一份标点表。 */
export function insertFileMention(text: string, cursor: number, path: string): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(text.length, cursor));
  const needsSpace = at > 0 && mentionQueryAt(`${text.charAt(at - 1)}@`, 2)?.start !== 1;
  const token = `${needsSpace ? " " : ""}@${path} `;
  return { text: text.slice(0, at) + token + text.slice(at), cursor: at + token.length };
}

export function FilePanel({ onClose }: { onClose: () => void }) {
  const session = useStore((value) => value.currentId ? value.session(value.currentId) : undefined);
  const preview = useStore(value => value.filePreview);
  // 浏览中的路径由 DirectoryContents 自己维护；宿主通知不应再次初始化并读取同一目录。
  const directoryInitialPath = useMemo(() => store.fileDirectory ?? session?.cwd ?? "", [preview, session?.cwd]);
  const directoryHistory = useRef<string[]>([]);
  const registerBrowserBack = useCallback((back: () => boolean) => {
    store.fileBrowserBack = back;
    return () => { if (store.fileBrowserBack === back) store.fileBrowserBack = null; };
  }, []);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [width, setWidth] = useSidePanelWidth(FILE_WIDTH_OPTIONS);
  const [navSlot, setNavSlot] = useState<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<{ path: string; copied: boolean | null; reason: string | null } | null>(null);
  const copyId = useRef(0);
  useEffect(() => () => { copyId.current += 1; }, []);
  const source = preview !== null && sourcePath === preview.target.path;
  const rich = preview?.file && ["markdown", "csv", "tsv", "html"].includes(preview.file.kind);
  const downloadOnly = preview?.file && ["text", "markdown", "csv", "tsv"].includes(preview.file.kind);
  const dirty = preview?.file?.editable && preview.draft !== preview.file.text;
  const confirmDownload = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!window.confirm("下载当前文件？取消后留在文件预览。")) event.preventDefault();
  };

  const referenceFile = (path: string) => {
    copyId.current += 1;
    // 点击时读当前状态，继续沿用 cwd/driver/会话状态边界。
    const current = store.currentId ? store.session(store.currentId) : undefined;
    const supported = current ? store.meta?.drivers[current.agent]?.mentions === true : false;
    const plan = planFileMention(current, supported, path);
    if (current && plan.path !== null) {
      store.requestFileMention(current.id, path);
      setNotice({ path, copied: null, reason: "已引用到当前会话。" });
    } else setNotice({ path, copied: null, reason: plan.reason });
  };
  const copyFile = (path: string) => {
    const id = ++copyId.current;
    setNotice({ path, copied: null, reason: "正在复制路径…" });
    void (async () => {
      let copied = false;
      try { await navigator.clipboard.writeText(path); copied = true; } catch { /* 保留完整路径供手动复制。 */ }
      if (id === copyId.current) setNotice({ path, copied, reason: null });
    })();
  };

  return <>
    <SidePanelResize label="文件" width={width} setWidth={setWidth} minWidth={FILE_WIDTH_OPTIONS.minWidth} defaultWidth={FILE_WIDTH_OPTIONS.defaultWidth} />
    <div id="file-panel" className="term-panel file-side-panel" role="region" aria-label="文件面板" style={{ width: `${width}px` }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <div className="term-titlebar file-titlebar">
        {!preview && <PanelBackButton onClick={onClose} />}
        <strong className="file-side-title">文件</strong>
        {!preview && <div ref={setNavSlot} className="file-nav" role="toolbar" aria-label="目录导航" />}
        {preview && <div className="file-actions" role="toolbar" aria-label="文件操作">
          <button className="file-action" type="button" aria-label="返回" title="返回目录" disabled={preview.saving} onClick={() => {
            if (store.clearFilePreview()) { setNotice(null); setSourcePath(null); }
          }}><FileActionIcon kind="back" /><span className="file-action-label">返回</span></button>
          <button className="file-action" type="button" aria-label="引用" title="引用到会话" onClick={() => referenceFile(preview.target.path)}><FileActionIcon kind="mention" /><span className="file-action-label">引用</span></button>
          <button className="file-action" type="button" aria-label="复制路径" title="复制路径" onClick={() => copyFile(preview.target.path)}><FileActionIcon kind="copy" /><span className="file-action-label">复制路径</span></button>
          {preview.file && preview.file.kind !== "unsupported" && <a className="file-action" aria-label={downloadOnly ? "下载" : "外部打开"} title={downloadOnly ? "下载" : "外部打开"}
            href={downloadOnly ? workFileContentUrl(preview.target, true) : `${workFileContentUrl(preview.target)}&v=${preview.loadId}`}
            download={downloadOnly ? preview.file.name : undefined} target={downloadOnly ? undefined : "_blank"} rel={downloadOnly ? undefined : "noopener noreferrer"} onClick={downloadOnly ? confirmDownload : undefined}>
            <FileActionIcon kind={downloadOnly ? "download" : "open"} /><span className="file-action-label">{downloadOnly ? "下载" : "外部打开"}</span></a>}
          {rich && <Segmented className="file-view-toggle" buttonClassName="file-view-option" ariaLabel="文件显示方式"
            options={["csv", "tsv"].includes(preview.file?.kind ?? "") ? TABLE_OPTIONS : PREVIEW_OPTIONS}
            value={source ? "source" : "preview"} onChange={value => setSourcePath(value === "source" ? preview.target.path : null)} />}
          {preview.file?.editable && <button className="file-action file-action-save" type="button" aria-label={preview.saving ? "保存中…" : "保存"} title={preview.saving ? "保存中…" : "保存"} disabled={!dirty || preview.saving} onClick={() => void store.saveFilePreview()}><FileActionIcon kind="save" /><span className="file-action-label">{preview.saving ? "保存中…" : "保存"}</span></button>}
          {preview.file?.kind === "html" && <a className="file-action" aria-label="下载" title="下载" href={workFileContentUrl(preview.target, true)} download={preview.file.name} onClick={confirmDownload}><FileActionIcon kind="download" /><span className="file-action-label">下载</span></a>}
        </div>}
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label="收起文件面板" title="收起面板" onClick={onClose}><PanelRightIcon /></button>
      </div>
      {notice && <div className="file-notice" role="status">
        {notice.reason && <p>{notice.reason}</p>}
        {notice.copied !== null && <p className="dir-copy-status">{notice.copied ? "路径已复制。" : <>无法自动复制，请手动复制：<span className="mono">{notice.path}</span></>}</p>}
      </div>}
      {preview ? <FilePreview key={preview.target.path} preview={preview} source={source} /> : <DirectoryContents initialPath={directoryInitialPath} includeFiles allowWindowsPicker
        navigationHistory={directoryHistory} registerBrowserBack={registerBrowserBack} navTarget={navSlot}
        onPathChange={path => { store.fileDirectory = path; }}
        onBrowseHistory={path => store.navigateHistory(path)}
        onSelectFile={path => { setNotice(null); void store.openFilePreview({ path, root: store.fileDirectory ?? session?.cwd ?? "/", sessionId: session?.id }); }} />}
    </div>
  </>;
}
