import { t } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { sendTaildrop, workFileContentUrl } from "../api";
import { mentionQueryAt } from "../mentions";
import { store, type FileTab } from "../store";
import type { SessionRecord, WorkFileTarget } from "../types";
import { useStore } from "../useStore";
import { DirectoryContents } from "./DirectoryBrowser";
import { FILE_WIDTH_OPTIONS, PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";
import { FilePreview } from "./FilePreview";
import { Segmented } from "./Segmented";
import { TaildropMenu } from "./TaildropMenu";

const PREVIEW_OPTIONS = [{ value: "preview", label: t("ui.FilePanel.preview"), title: t("ui.FilePanel.view_the_rendered_document") }, { value: "source", label: t("ui.FilePanel.source"), title: t("ui.FilePanel.view_or_edit_the_document_source") }] as const;
const TABLE_OPTIONS = [{ value: "preview", label: t("ui.FilePanel.table"), title: t("ui.FilePanel.view_data_as_a_table") }, { value: "source", label: t("ui.FilePanel.source"), title: t("ui.FilePanel.view_or_edit_raw_data") }] as const;
const ACTION_PATHS = {
  back: "m15 18-6-6 6-6",
  mention: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  copy: "M9 9h12v12H9z M15 5V3H3v12h2",
  open: "M15 3h6v6 M21 3 10 14 M10 3H3v18h18v-7",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4",
  save: "M3 3h15l3 3v15H3z M7 3v6h10V3 M7 21v-8h10v8",
  send: "M22 2 11 13 M22 2l-7 20-4-9-9-4Z",
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
  if (!session) return { path: null, reason: t("ui.FilePanel.no_current_session_to_reference_this_file") };
  if (session.status === "dead") return { path: null, reason: t("ui.FilePanel.this_session_has_ended_use_copy_path") };
  if (!mentionsSupported) return { path: null, reason: t("ui.FilePanel.the_current_driver_does_not_support_references") };
  const root = absolutePath(session.cwd);
  const file = absolutePath(path);
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!root || !file || !file.startsWith(prefix) || file === root) {
    return { path: null, reason: t("ui.FilePanel.this_file_is_outside_the_session_working") };
  }
  const relative = file.slice(prefix.length);
  if (/\s/u.test(relative)) return { path: null, reason: t("ui.FilePanel.the_relative_path_contains_whitespace_which_truncates") };
  return { path: relative, reason: null };
}

/** 复用 mentionQueryAt 的边界判定，避免另存一份标点表。 */
export function insertFileMention(text: string, cursor: number, path: string): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(text.length, cursor));
  const needsSpace = at > 0 && mentionQueryAt(`${text.charAt(at - 1)}@`, 2)?.start !== 1;
  const token = `${needsSpace ? " " : ""}@${path} `;
  return { text: text.slice(0, at) + token + text.slice(at), cursor: at + token.length };
}

const SHOW_HIDDEN_STORAGE_KEY = "workbench-file-show-hidden";

export function FilePanel({ onClose }: { onClose: () => void }) {
  // 默认显示隐藏项；按浏览器记住。
  const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) !== "0"; } catch { return true; } });
  const toggleHidden = () => setShowHidden(value => {
    try { localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, value ? "0" : "1"); } catch { /* 仅本页生效 */ }
    return !value;
  });
  const session = useStore((value) => value.currentId ? value.session(value.currentId) : undefined);
  const preview = useStore(value => value.filePreview);
  const tabs = useStore(value => value.fileTabs);
  const tabId = useStore(value => value.fileTabId);
  const fileDirectory = useStore(value => value.fileDirectory);
  // 浏览中的路径由 DirectoryContents 自己维护；宿主通知不应再次初始化并读取同一目录。
  const sessionDirectory = () => store.fileDirectory && store.fileDirectory.sessionId === (session?.id ?? null) ? store.fileDirectory.path : null;
  const directoryInitialPath = useMemo(() => sessionDirectory() ?? session?.cwd ?? "", [preview, tabId, session?.id, session?.cwd]);
  // 各标签成功访问过的目录，供侧键返回；随面板卸载清空，与单标签时一致。
  const tabHistories = useRef(new Map<number, string[]>());
  const directoryHistory = useMemo(() => {
    const history = tabHistories.current.get(tabId) ?? [];
    tabHistories.current.set(tabId, history);
    return { current: history };
  }, [tabId]);
  const tabPath = (tab: FileTab) => {
    const live = tab.id === tabId;
    const shown = live ? preview : tab.preview;
    if (shown) return { path: shown.target.path, folder: false };
    const directory = live ? fileDirectory : tab.directory;
    return { path: directory && directory.sessionId === (session?.id ?? null) ? directory.path : session?.cwd ?? "", folder: true };
  };
  const registerBrowserBack = useCallback((back: () => boolean) => {
    store.fileBrowserBack = back;
    return () => { if (store.fileBrowserBack === back) store.fileBrowserBack = null; };
  }, []);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [width, setWidth] = useSidePanelWidth(FILE_WIDTH_OPTIONS);
  const [navSlot, setNavSlot] = useState<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<{ path: string; copied: boolean | null; reason: string | null } | null>(null);
  const taildrop = useStore(value => value.meta?.capabilities.taildrop === true);
  const folderTaildrop = useStore(value => value.meta?.capabilities.folderTaildrop === true);
  const copyId = useRef(0);
  useEffect(() => () => { copyId.current += 1; }, []);
  const source = preview !== null && sourcePath === preview.target.path;
  const rich = preview?.file && ["markdown", "csv", "tsv", "html"].includes(preview.file.kind);
  const downloadOnly = preview?.file && ["text", "markdown", "csv", "tsv"].includes(preview.file.kind);
  const dirty = preview?.file?.editable && preview.draft !== preview.file.text;
  const confirmDownload = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!window.confirm(t("ui.FilePanel.download_this_file_cancel_to_stay_in"))) event.preventDefault();
  };

  const referenceFile = (path: string) => {
    copyId.current += 1;
    // 点击时读当前状态，继续沿用 cwd/driver/会话状态边界。
    const current = store.currentId ? store.session(store.currentId) : undefined;
    const supported = current ? store.meta?.drivers[current.agent]?.mentions === true : false;
    const plan = planFileMention(current, supported, path);
    if (current && plan.path !== null) {
      store.requestFileMention(current.id, path);
      setNotice({ path, copied: null, reason: t("ui.FilePanel.referenced_in_the_current_session") });
    } else setNotice({ path, copied: null, reason: plan.reason });
  };
  const [sendMenu, setSendMenu] = useState<{ target: WorkFileTarget; name: string; folder: boolean; row: boolean; x: number; y: number } | null>(null);
  // 菜单约 240 宽；纵向留给设备列表，别贴出视口。row = 目录行菜单，多一项「在新标签页内打开」。
  const openSendMenu = (target: WorkFileTarget, name: string, folder: boolean, x: number, y: number, row = false) =>
    setSendMenu({ target, name, folder, row, x: Math.max(8, Math.min(x, window.innerWidth - 248)), y: Math.max(8, Math.min(y, window.innerHeight - 248)) });
  const sendFile = (target: WorkFileTarget, name: string, folder: boolean, ip: string, device: string) => {
    setSendMenu(null);
    copyId.current += 1;
    setNotice({ path: target.path, copied: null, reason: t("ui.FilePanel.sending_to", { p0: (folder ? t("ui.FilePanel.zip_and_detail") : ""), p1: (name), p2: (device) }) });
    // 发送结果总要显示，不受后续复制/引用提示的序号约束。
    sendTaildrop(target, ip).then(
      result => setNotice({ path: target.path, copied: null, reason: t("ui.FilePanel.sent_to_check_tailscale_or_the_downloads", { p0: (result.name), p1: (device) }) }),
      (error: Error) => setNotice({ path: target.path, copied: null, reason: error.message }));
  };
  const copyFile = (path: string) => {
    const id = ++copyId.current;
    setNotice({ path, copied: null, reason: t("ui.FilePanel.copying_path") });
    void (async () => {
      let copied = false;
      try { await navigator.clipboard.writeText(path); copied = true; } catch { /* 保留完整路径供手动复制。 */ }
      if (id === copyId.current) setNotice({ path, copied, reason: null });
    })();
  };

  const tabRow = <div className="term-tabs file-tabs">
    <div className="term-tab-list" role="tablist" aria-label={t("ui.FilePanel.file_tabs")} onKeyDown={event => {
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]"));
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (!direction || index < 0) return;
      event.preventDefault();
      items[(index + direction + items.length) % items.length]?.click();
      // 目录标签切换会重挂载 DirectoryContents（标签行随之重建），渲染后再把焦点交回当前标签。
      requestAnimationFrame(() => document.querySelector<HTMLElement>("#file-panel .file-tabs [role=tab][aria-selected=true]")?.focus());
    }}>
      {tabs.map(tab => {
        const active = tab.id === tabId;
        const { path, folder } = tabPath(tab);
        const name = path.split("/").filter(Boolean).pop() ?? "/";
        return <div key={tab.id} className={`term-tab${active ? " active" : ""}`}>
          <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} className="term-tab-select" title={path}
            onClick={() => { if (!active) setNotice(null); store.switchFileTab(tab.id); }}>
            <svg className="term-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={folder ? "M3 7V5h6l2 2h10v13H3Z" : "M14 3H5v18h14V8ZM14 3v5h5"} />
            </svg>
            <span className="term-tab-label">{name}</span>
          </button>
          {tabs.length > 1 && <button type="button" className="term-tab-close" aria-label={t("ui.FilePanel.close", { p0: (name) })} title={t("ui.FilePanel.close_tab")} onClick={() => store.closeFileTab(tab.id)}>×</button>}
        </div>;
      })}
    </div>
    <button type="button" className="term-tab-new" aria-label={t("ui.FilePanel.new_tab")} title={t("ui.FilePanel.new_tab_in_the_session_directory")} onClick={() => { setNotice(null); store.openFileTab(); }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
    </button>
    {!preview && <button type="button" className="term-tab-toggle" aria-pressed={showHidden} onClick={toggleHidden}
      title={showHidden ? t("ui.FilePanel.hidden_files_shown") : t("ui.FilePanel.hidden_files_not_shown")}>{t("ui.FilePanel.hidden_files")}</button>}
  </div>;

  return <>
    <SidePanelResize label={t("ui.common.files")} width={width} setWidth={setWidth} minWidth={FILE_WIDTH_OPTIONS.minWidth} defaultWidth={FILE_WIDTH_OPTIONS.defaultWidth} />
    <div id="file-panel" className="term-panel file-side-panel" role="region" aria-label={t("ui.FilePanel.file_panel")} style={{ width: `${width}px` }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <div className="term-titlebar file-titlebar">
        {!preview && <PanelBackButton onClick={onClose} />}
        <strong className="file-side-title">{t("ui.common.files")}</strong>
        {!preview && <div ref={setNavSlot} className="file-nav" role="toolbar" aria-label={t("ui.FilePanel.directory_navigation")} />}
        {preview && <div className="file-actions" role="toolbar" aria-label={t("ui.common.file_actions")}>
          <button className="file-action" type="button" aria-label={t("ui.common.back")} title={t("ui.FilePanel.back_to_directory")} disabled={preview.saving} onClick={() => {
            if (store.clearFilePreview()) { setNotice(null); setSourcePath(null); }
          }}><FileActionIcon kind="back" /><span className="file-action-label">{t("ui.common.back")}</span></button>
          <button className="file-action" type="button" aria-label={t("ui.FilePanel.reference")} title={t("ui.FilePanel.reference_in_session")} onClick={() => referenceFile(preview.target.path)}><FileActionIcon kind="mention" /><span className="file-action-label">{t("ui.FilePanel.reference")}</span></button>
          <button className="file-action" type="button" aria-label={t("ui.FilePanel.copy_path")} title={t("ui.FilePanel.copy_path")} onClick={() => copyFile(preview.target.path)}><FileActionIcon kind="copy" /><span className="file-action-label">{t("ui.FilePanel.copy_path")}</span></button>
          {taildrop && <button className="file-action" type="button" aria-label={t("ui.FilePanel.send_to_device")} title={t("ui.FilePanel.send_to_a_device_on_your_tailnet")} aria-haspopup="menu" aria-expanded={sendMenu !== null} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            openSendMenu(preview.target, preview.file?.name ?? preview.target.path.split("/").pop()!, false, rect.left, rect.bottom + 4);
          }}><FileActionIcon kind="send" /><span className="file-action-label">{t("ui.common.send")}</span></button>}
          {preview.file && preview.file.kind !== "unsupported" && <a className="file-action" aria-label={downloadOnly ? t("ui.FilePanel.download") : t("ui.FilePanel.open_externally")} title={downloadOnly ? t("ui.FilePanel.download") : t("ui.FilePanel.open_externally")}
            href={downloadOnly ? workFileContentUrl(preview.target, true) : `${workFileContentUrl(preview.target)}&v=${preview.loadId}`}
            download={downloadOnly ? preview.file.name : undefined} target={downloadOnly ? undefined : "_blank"} rel={downloadOnly ? undefined : "noopener noreferrer"} onClick={downloadOnly ? confirmDownload : undefined}>
            <FileActionIcon kind={downloadOnly ? "download" : "open"} /><span className="file-action-label">{downloadOnly ? t("ui.FilePanel.download") : t("ui.FilePanel.open_externally")}</span></a>}
          {rich && <Segmented className="file-view-toggle" buttonClassName="file-view-option" ariaLabel={t("ui.FilePanel.file_display_mode")}
            options={["csv", "tsv"].includes(preview.file?.kind ?? "") ? TABLE_OPTIONS : PREVIEW_OPTIONS}
            value={source ? "source" : "preview"} onChange={value => setSourcePath(value === "source" ? preview.target.path : null)} />}
          {preview.file?.editable && <button className="file-action file-action-save" type="button" aria-label={preview.saving ? t("ui.common.saving") : t("ui.FilePanel.save")} title={preview.saving ? t("ui.common.saving") : t("ui.FilePanel.save")} disabled={!dirty || preview.saving} onClick={() => void store.saveFilePreview()}><FileActionIcon kind="save" /><span className="file-action-label">{preview.saving ? t("ui.common.saving") : t("ui.FilePanel.save")}</span></button>}
          {preview.file?.kind === "html" && <a className="file-action" aria-label={t("ui.FilePanel.download")} title={t("ui.FilePanel.download")} href={workFileContentUrl(preview.target, true)} download={preview.file.name} onClick={confirmDownload}><FileActionIcon kind="download" /><span className="file-action-label">{t("ui.FilePanel.download")}</span></a>}
        </div>}
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label={t("ui.FilePanel.collapse_file_panel")} title={t("ui.common.collapse_panel")} onClick={onClose}><PanelRightIcon /></button>
      </div>
      {notice && <div className="file-notice" role="status">
        {notice.reason && <p>{notice.reason}</p>}
        {notice.copied !== null && <p className="dir-copy-status">{notice.copied ? t("ui.FilePanel.path_copied") : <>{t("ui.FilePanel.cannot_copy_automatically_copy_manually")}<span className="mono">{notice.path}</span></>}</p>}
      </div>}
      {preview && tabRow}
      {preview ? <FilePreview key={preview.target.path} preview={preview} source={source} /> : <DirectoryContents key={tabId} initialPath={directoryInitialPath} includeFiles allowWindowsPicker
        navigationHistory={directoryHistory} registerBrowserBack={registerBrowserBack} navTarget={navSlot} afterLocation={tabRow} showHidden={showHidden}
        onPathChange={path => store.setFileDirectory(path)}
        onBrowseHistory={path => store.navigateHistory(path)}
        onSelectFile={path => { setNotice(null); void store.openFilePreview({ path, root: sessionDirectory() ?? session?.cwd ?? "/", sessionId: session?.id }); }}
        onEntryMenu={(entry, x, y) => openSendMenu({ path: entry.path, root: entry.root, sessionId: session?.id }, entry.name, entry.folder, x, y, true)} />}
      {sendMenu && <TaildropMenu enabled={sendMenu.folder ? folderTaildrop : taildrop} position={sendMenu} folder={sendMenu.folder} onClose={() => setSendMenu(null)}
        leadingItems={sendMenu.row ? [{ id: "new-tab", icon: "plus", label: t("ui.FilePanel.open_in_a_new_tab"), onSelect: () => {
          setSendMenu(null); setNotice(null);
          store.openFileTab({ path: sendMenu.target.path, root: sendMenu.target.root, folder: sendMenu.folder });
        } }] : undefined}
        onSend={(ip, device) => sendFile(sendMenu.target, sendMenu.name, sendMenu.folder, ip, device)} />}
    </div>
  </>;
}
