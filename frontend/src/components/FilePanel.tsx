import { t } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type DragEvent, type ReactNode } from "react";
import { openWorkPathInSystem, sendTaildrop, workFileContentUrl } from "../api";
import { mentionQueryAt } from "../mentions";
import { store } from "../store";
import { buildTermTabs } from "../terminal";
import type { SessionRecord, WorkFileTarget } from "../types";
import { shallowEqual, useStore } from "../useStore";
import { DirectoryContents } from "./DirectoryBrowser";
import { FILE_WIDTH_OPTIONS, PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";
import { FilePreview } from "./FilePreview";
import { Segmented } from "./Segmented";
import { TaildropMenu } from "./TaildropMenu";
import { SidebarActionMenu, type SidebarMenuItem } from "./SidebarActionMenu";

const PREVIEW_OPTIONS = [{ value: "preview", label: t("ui.FilePanel.preview"), title: t("ui.FilePanel.view_the_rendered_document") }, { value: "source", label: t("ui.FilePanel.source"), title: t("ui.FilePanel.view_or_edit_the_document_source") }] as const;
const TABLE_OPTIONS = [{ value: "preview", label: t("ui.FilePanel.table"), title: t("ui.FilePanel.view_data_as_a_table") }, { value: "source", label: t("ui.FilePanel.source"), title: t("ui.FilePanel.view_or_edit_raw_data") }] as const;
const ACTION_PATHS = {
  back: "m15 18-6-6 6-6",
  refresh: "M21 4v6h-6 M20.5 10a9 9 0 1 0-2.1 8.4",
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

const FILE_TAB_DRAG_TYPE = "application/x-aireins-file-tab";
const WORKSPACE_TAB_DRAG_TYPE = "application/x-aireins-workspace-tab";

function draggedTab(event: DragEvent): string {
  return event.dataTransfer.getData(WORKSPACE_TAB_DRAG_TYPE) || (event.dataTransfer.getData(FILE_TAB_DRAG_TYPE) ? `file:${event.dataTransfer.getData(FILE_TAB_DRAG_TYPE)}` : "");
}
function acceptsTab(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(WORKSPACE_TAB_DRAG_TYPE) || event.dataTransfer.types.includes(FILE_TAB_DRAG_TYPE);
}
function endTabDrag(): void {
  document.body.classList.remove("file-tab-dragging");
  document.querySelectorAll<HTMLElement>("[data-drop-active], [data-drop-edge]").forEach(element => {
    delete element.dataset.dropActive; delete element.dataset.dropEdge;
  });
}
function dropTab(event: DragEvent<HTMLDivElement>, area: "main" | "right", target?: string): void {
  if (!acceptsTab(event)) return;
  event.preventDefault(); event.stopPropagation();
  const key = draggedTab(event);
  const after = target ? event.clientX > event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2 : false;
  endTabDrag();
  store.moveWorkspaceTab(key, area, target, after);
}

/** 仅内部标签拖动时覆盖内容区，避免 HTML/PDF iframe 吞掉跨栏拖放。标签栏保持在接收层上方。 */
export function WorkspaceDropTarget({ area }: { area: "main" | "right" }) {
  return <div className="workspace-tab-drop-target" data-drop-area={area} aria-hidden="true"
    onDragOver={event => {
      if (!acceptsTab(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "move"; event.currentTarget.dataset.dropActive = "true";
    }} onDragLeave={event => { delete event.currentTarget.dataset.dropActive; }}
    onDrop={event => dropTab(event, area)} />;
}

/** 右侧文件页与终端页各显示本类标签（用户 10-25）；混排只在主区，跨页靠移到主区/右侧。 */
export function FileTabs({ area, page = "files", trailing }: { area: "main" | "right"; page?: "files" | "terminal"; trailing?: ReactNode }) {
  const tabs = useStore(value => value.fileTabs.filter(tab => (tab.area ?? "right") === area), shallowEqual);
  const selected = useStore(value => area === "main" ? value.mainFileTabId : value.fileTabId);
  const terminals = useStore(value => value.terminals);
  const terminalAreas = useStore(value => value.terminalAreas);
  const terminalBusy = useStore(value => value.terminalBusyAreas[area] === true);
  const terminalSelected = useStore(value => area === "main" ? value.mainTerminalId : value.termOpen ? value.rightTerminalId : null);
  const order = useStore(value => value.workspaceTabKeys(area).join("\n"));
  const unread = useStore(value => value.mainSessionUnread);
  const pending = useStore(value => value.currentId ? value.pendingCount(value.currentId) : 0);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const terminalTabs = buildTermTabs(terminals, terminalSelected).filter(tab => (terminalAreas[tab.id] ?? "right") === area);
  const dragProps = (key: string) => ({
    draggable: !(key.startsWith("terminal:") && terminalBusy),
    "data-workspace-tab": key,
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      event.dataTransfer.setData(WORKSPACE_TAB_DRAG_TYPE, key);
      if (key.startsWith("file:")) event.dataTransfer.setData(FILE_TAB_DRAG_TYPE, key.slice(5));
      event.dataTransfer.effectAllowed = "move"; document.body.classList.add("file-tab-dragging");
    },
    onDragEnd: endTabDrag,
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!acceptsTab(event)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.dataset.dropEdge = event.clientX > rect.left + rect.width / 2 ? "after" : "before";
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) delete event.currentTarget.dataset.dropEdge;
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => dropTab(event, area, key),
  });
  return <div data-file-area={area} className={`term-tabs file-tabs${area === "main" && tabs.length === 0 && terminalTabs.length === 0 ? " main-file-tabs-empty" : ""}`}
    onDragOver={event => { if (acceptsTab(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
    onDrop={event => dropTab(event, area)}>
    <div className="term-tab-list" role="tablist" aria-label={t(area === "main" ? "ui.FilePanel.main_tabs" : "ui.FilePanel.workspace_tabs")} onKeyDown={event => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)"));
      const index = items.indexOf(event.target as HTMLButtonElement);
      const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (index < 0 || !direction) return;
      event.preventDefault();
      const next = items[(index + direction + items.length) % items.length];
      const id = next?.dataset.tabId;
      next?.click();
      requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLElement>(`[data-file-area="${area}"] [data-tab-id="${id}"]`)).find(element => element.getClientRects().length > 0)?.focus());
    }}>
      {area === "main" && <div className={`term-tab${selected === 0 && !terminalSelected ? " active" : ""}`}>
        <button type="button" role="tab" data-tab-id="0" aria-selected={selected === 0 && !terminalSelected} tabIndex={selected === 0 && !terminalSelected ? 0 : -1}
          className="term-tab-select" title={t("ui.FilePanel.return_to_session")} onClick={() => store.showMainSession()}>
          <span className="term-tab-label">{t("ui.FilePanel.session_tab")}</span>
          {pending > 0 ? <span className="gate-badge">{pending}</span> : unread && <span className="file-session-unread" aria-label={t("ui.FilePanel.session_updated")} />}
        </button>
      </div>}
      {order.split("\n").filter(key => key && (area === "main" || key.startsWith(page === "terminal" ? "terminal:" : "file:"))).map(key => {
        if (key.startsWith("terminal:")) {
          const tab = terminalTabs.find(item => item.id === key.slice(9));
          if (!tab) return null;
          const active = terminalSelected === tab.id;
          return <div key={key} {...dragProps(key)} className={`term-tab${active ? " active" : ""}${tab.exited && !terminalBusy ? " exited" : ""}`}>
            <button type="button" role="tab" data-tab-id={key} aria-selected={active} tabIndex={active ? 0 : -1}
              className="term-tab-select" title={tab.cwd} disabled={terminalBusy} onClick={() => store.selectTerminal(tab.id)}>
              <svg className="term-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">{tab.kind === "bash" ? <path d="m4 6 6 6-6 6m9 0h7" /> : <><path d="m7 5 7 7-9 7M15 19h5" /><path d="M3 2h18l-3 20H0z" /></>}</svg>
              <span className="term-tab-label">{tab.label}{tab.exited && !terminalBusy ? t("ui.TerminalPanel.exited") : ""}</span>
            </button>
            <button type="button" className="term-tab-close" aria-label={t("ui.TerminalPanel.message", { p0: tab.exited ? t("ui.TerminalPanel.remove_detail") : t("ui.TerminalPanel.end_detail"), p1: tab.label })}
              title={tab.exited ? t("ui.TerminalPanel.remove_exited_tab") : t("ui.TerminalPanel.end_terminal_confirmation_required")}
              disabled={terminalBusy} onClick={() => store.requestTerminalClose(tab.id)}>×</button>
          </div>;
        }
        const tab = tabs.find(item => item.id === Number(key.slice(5)));
        if (!tab) return null;
        const path = tab.preview?.target.path ?? (tab.directory?.sessionId === store.currentId ? tab.directory?.path : undefined) ?? (store.currentId ? store.session(store.currentId)?.cwd : store.newSessionCwd) ?? "/";
        const folder = !tab.preview;
        const name = path.split("/").filter(Boolean).pop() ?? "/";
        const active = tab.id === selected && !terminalSelected;
        return <div key={key} {...dragProps(key)} className={`term-tab${active ? " active" : ""}`}>
          <button type="button" role="tab" data-tab-id={tab.id} aria-selected={active} tabIndex={active ? 0 : -1} className="term-tab-select" title={path}
            onClick={() => { if (area === "right" && !store.filesOpen) store.setFilesOpen(true); store.switchFileTab(tab.id); }}>
            <svg className={`term-tab-icon${folder ? " file-tab-folder" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={folder ? "M3 7V5h6l2 2h10v13H3Z" : "M14 3H5v18h14V8ZM14 3v5h5"} /></svg>
            <span className="term-tab-label">{name}</span>
          </button>
          {!folder && <button type="button" className="term-tab-close file-tab-menu" aria-label={t("ui.FilePanel.tab_actions", { name })} title={t("ui.FilePanel.tab_actions", { name })}
            aria-haspopup="menu" aria-expanded={menu?.id === tab.id} onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect(); setMenu({ id: tab.id, x: rect.left, y: rect.bottom + 4 });
            }}>⋯</button>}
          <button type="button" className="term-tab-close" aria-label={t("ui.FilePanel.close", { p0: name })} title={t("ui.FilePanel.close_tab")} onClick={() => store.closeFileTab(tab.id)}>×</button>
        </div>;
      })}
    </div>
    {trailing ?? (area === "right" && <button type="button" className="term-tab-new" aria-label={t("ui.FilePanel.new_tab")} title={t("ui.FilePanel.new_tab_in_the_session_directory")} onClick={() => store.openFileTab()}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
    </button>)}
    {menu && <SidebarActionMenu position={menu} label={t("ui.FilePanel.file_tabs")} onClose={() => setMenu(null)} items={[
      { id: "move-file", icon: "open", label: t(area === "main" ? "ui.FilePanel.move_to_right" : "ui.FilePanel.move_to_main"), onSelect: () => { store.moveFileTab(menu.id, area === "main" ? "right" : "main"); setMenu(null); } },
    ]} />}
  </div>;
}

export function FilePanels() {
  const ids = useStore(value => value.fileTabs.map(tab => tab.id).join(","));
  const filesOpen = useStore(value => value.filesOpen);
  const hasRight = useStore(value => value.fileTabs.some(tab => tab.area !== "main"));
  return <>{ids && ids.split(",").map(id => <FilePanel key={id} tabId={Number(id)} onClose={() => store.setFilesOpen(false)} />)}
    {!hasRight && filesOpen && <FilePanel onClose={() => store.setFilesOpen(false)} />}</>;
}

export function FilePanel({ onClose: closeRight, tabId: ownTabId }: { onClose: () => void; tabId?: number }) {
  // 默认显示隐藏项；按浏览器记住。
  const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) !== "0"; } catch { return true; } });
  const toggleHidden = () => setShowHidden(value => {
    try { localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, value ? "0" : "1"); } catch { /* 仅本页生效 */ }
    return !value;
  });
  const session = useStore((value) => value.currentId ? value.session(value.currentId) : undefined);
  const tabId = useStore(value => ownTabId ?? value.fileTabId);
  const tab = useStore(value => value.fileTabs.find(item => item.id === tabId));
  const preview = tab?.preview ?? null;
  const area = tab?.area ?? "right";
  const visible = useStore(value => ownTabId === undefined || (area === "main" ? value.mainFileTabId === tabId && !value.mainTerminalId : value.filesOpen && value.fileTabId === tabId));
  const onClose = area === "main" ? () => store.showMainSession() : closeRight;
  const hasTab = !!tab;
  const fileDirectory = tab?.directory;
  const newSessionCwd = useStore(value => value.currentId ? undefined : value.newSessionCwd);
  const sessionDirectory = () => fileDirectory && fileDirectory.sessionId === (session?.id ?? null) ? fileDirectory.path : null;
  const directoryInitialPath = useMemo(() => sessionDirectory() ?? session?.cwd ?? newSessionCwd ?? "", [preview, tabId, session?.id, session?.cwd, visible]);
  const directoryHistory = useMemo(() => ({ current: [] as string[] }), [session?.id, session?.cwd]);
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
  const systemOpen = useStore(value => value.meta?.capabilities.systemOpen === true);
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
      if (area === "main") store.showMainSession();
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

  const menuItems: SidebarMenuItem[] = [];
  if (sendMenu?.row) {
    const menu = sendMenu;
    menuItems.push({ id: "new-tab", icon: "plus", label: t("ui.FilePanel.open_in_a_new_tab"), onSelect: () => {
      setSendMenu(null); setNotice(null);
      store.openFileTab({ path: menu.target.path, root: menu.target.root, folder: menu.folder });
    } });
    if (systemOpen) menuItems.push({ id: "open-system", icon: menu.folder ? "folder" : "open", label: t(menu.folder ? "ui.FilePanel.open_in_file_manager" : "ui.FilePanel.open_with_default"), onSelect: () => {
      setSendMenu(null);
      const id = ++copyId.current;
      setNotice({ path: menu.target.path, copied: null, reason: t("ui.FilePanel.opening_in_system") });
      openWorkPathInSystem(menu.target).then(
        () => { if (id === copyId.current) setNotice({ path: menu.target.path, copied: null, reason: t("ui.FilePanel.opened_in_system") }); },
        (error: Error) => { if (id === copyId.current) setNotice({ path: menu.target.path, copied: null, reason: error.message }); });
    } });
  }

  const tabRow = <><FileTabs area={area} />{hasTab && !preview && <button type="button" className="term-tab-toggle file-hidden-toggle" aria-pressed={showHidden} onClick={toggleHidden}
    title={showHidden ? t("ui.FilePanel.hidden_files_shown") : t("ui.FilePanel.hidden_files_not_shown")}>{t("ui.FilePanel.hidden_files")}</button>}</>;

  return <>
    {visible && area === "right" && <SidePanelResize label={t("ui.common.files")} width={width} setWidth={setWidth} minWidth={FILE_WIDTH_OPTIONS.minWidth} defaultWidth={FILE_WIDTH_OPTIONS.defaultWidth} />}
    <div id={area === "right" && visible ? "file-panel" : `file-pane-${tabId}`} hidden={!visible} data-file-area={area} className={`term-panel file-side-panel${area === "main" ? " file-main-panel" : ""}`} role="region" aria-label={t("ui.FilePanel.file_panel")} style={area === "right" ? { width: `${width}px` } : undefined} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <WorkspaceDropTarget area={area} />
      <div className="term-titlebar file-titlebar">
        {!preview && <PanelBackButton onClick={onClose} />}
        <strong className="file-side-title">{t("ui.common.files")}</strong>
        {hasTab && !preview && <div ref={setNavSlot} className="file-nav" role="toolbar" aria-label={t("ui.FilePanel.directory_navigation")} />}
        {preview && <div className="file-actions" role="toolbar" aria-label={t("ui.common.file_actions")}>
          <button className="file-action" type="button" aria-label={t("ui.common.back")} title={t(area === "main" ? "ui.FilePanel.return_to_session" : "ui.FilePanel.back_to_directory")} disabled={preview.saving} onClick={() => {
            if (area === "main") { store.showMainSession(); return; }
            if (store.clearFilePreview(tabId)) { setNotice(null); setSourcePath(null); }
          }}><FileActionIcon kind="back" /></button>
          <button className="file-action file-action-refresh" type="button" aria-label={t("ui.FilePanel.refresh_file")} title={t("ui.FilePanel.refresh_file")} disabled={preview.loading || preview.saving}
            onClick={() => void store.openFilePreview(preview.target, tabId)}><FileActionIcon kind="refresh" /></button>
          <button className="file-action" type="button" aria-label={t("ui.FilePanel.reference")} title={t("ui.FilePanel.reference_in_session")} onClick={() => referenceFile(preview.target.path)}><FileActionIcon kind="mention" /></button>
          <button className="file-action" type="button" aria-label={t("ui.FilePanel.copy_path")} title={t("ui.FilePanel.copy_path")} onClick={() => copyFile(preview.target.path)}><FileActionIcon kind="copy" /></button>
          {taildrop && <button className="file-action" type="button" aria-label={t("ui.FilePanel.send_to_device")} title={t("ui.FilePanel.send_to_a_device_on_your_tailnet")} aria-haspopup="menu" aria-expanded={sendMenu !== null} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            openSendMenu(preview.target, preview.file?.name ?? preview.target.path.split("/").pop()!, false, rect.left, rect.bottom + 4);
          }}><FileActionIcon kind="send" /></button>}
          {preview.file && preview.file.kind !== "unsupported" && <a className="file-action" aria-label={downloadOnly ? t("ui.FilePanel.download") : t("ui.FilePanel.open_externally")} title={downloadOnly ? t("ui.FilePanel.download") : t("ui.FilePanel.open_externally")}
            href={downloadOnly ? workFileContentUrl(preview.target, true) : `${workFileContentUrl(preview.target)}&v=${preview.loadId}`}
            download={downloadOnly ? preview.file.name : undefined} target={downloadOnly ? undefined : "_blank"} rel={downloadOnly ? undefined : "noopener noreferrer"} onClick={downloadOnly ? confirmDownload : undefined}>
            <FileActionIcon kind={downloadOnly ? "download" : "open"} /></a>}
          {rich && <Segmented className="file-view-toggle" buttonClassName="file-view-option" ariaLabel={t("ui.FilePanel.file_display_mode")}
            options={["csv", "tsv"].includes(preview.file?.kind ?? "") ? TABLE_OPTIONS : PREVIEW_OPTIONS}
            value={source ? "source" : "preview"} onChange={value => setSourcePath(value === "source" ? preview.target.path : null)} />}
          {preview.file?.editable && <button className="file-action file-action-save" type="button" aria-label={preview.saving ? t("ui.common.saving") : t("ui.FilePanel.save")} title={preview.saving ? t("ui.common.saving") : t("ui.FilePanel.save")} disabled={!dirty || preview.saving} onClick={() => void store.saveFilePreview(tabId)}><FileActionIcon kind="save" /></button>}
          {preview.file?.kind === "html" && <a className="file-action" aria-label={t("ui.FilePanel.download")} title={t("ui.FilePanel.download")} href={workFileContentUrl(preview.target, true)} download={preview.file.name} onClick={confirmDownload}><FileActionIcon kind="download" /></a>}
        </div>}
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label={t("ui.FilePanel.collapse_file_panel")} title={t("ui.common.collapse_panel")} onClick={onClose}><PanelRightIcon /></button>
      </div>
      {hasTab && notice && <div className="file-notice" role="status">
        {notice.reason && <p>{notice.reason}</p>}
        {notice.copied !== null && <p className="dir-copy-status">{notice.copied ? t("ui.FilePanel.path_copied") : <>{t("ui.FilePanel.cannot_copy_automatically_copy_manually")}<span className="mono">{notice.path}</span></>}</p>}
      </div>}
      {area === "right" && (preview || !hasTab) && tabRow}
      {preview ? <FilePreview key={preview.target.path} preview={preview} source={source} tabId={tabId} /> : hasTab && visible && <DirectoryContents key={`${tabId}:${session?.id ?? ""}`} initialPath={directoryInitialPath} includeFiles allowWindowsPicker
        refreshPath={session ? undefined : newSessionCwd}
        navigationHistory={directoryHistory} registerBrowserBack={registerBrowserBack} navTarget={navSlot} afterLocation={area === "right" ? tabRow : undefined} showHidden={showHidden}
        onPathChange={path => store.setFileDirectory(path, tabId)}
        onBrowseHistory={path => store.navigateHistory(path)}
        onSelectFile={path => { setNotice(null); store.openFileTab({ path, root: sessionDirectory() ?? session?.cwd ?? "/", folder: false }); }}
        onEntryMenu={(entry, x, y) => openSendMenu({ path: entry.path, root: entry.root, sessionId: session?.id }, entry.name, entry.folder, x, y, true)} />}
      {hasTab && sendMenu && <TaildropMenu enabled={sendMenu.folder ? folderTaildrop : taildrop} position={sendMenu} folder={sendMenu.folder} onClose={() => setSendMenu(null)}
        leadingItems={menuItems}
        onSend={(ip, device) => sendFile(sendMenu.target, sendMenu.name, sendMenu.folder, ip, device)} />}
    </div>
  </>;
}
