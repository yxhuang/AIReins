import { t } from "../i18n";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fetchDirectories, fetchHistory, pickWindowsDirectory, pickWindowsFile } from "../api";
import { store } from "../store";
import { directoryBreadcrumbs, normalizeDirectoryPath, recentDirectoryPaths, sortedDirectoryEntries } from "../directory-path";
import { useStore } from "../useStore";
import type { DirectoryListing, HistorySession } from "../types";
import { useAnchoredMenu } from "./useAnchoredMenu";
import { DirectoryTable } from "./DirectoryTable";

const WINDOWS_FALLBACK = "/mnt/c/Users";

/** 比较工作台与三家原生会话；无有效活动时间的记录不压过已有候选。 */
export function lastWindowsCwd(
  sessions: readonly { cwd: string; lastActivityAt: string }[],
  history: readonly { cwd: string; lastActivityAt: string }[] = [],
): string {
  let cwd = WINDOWS_FALLBACK;
  let latest = -Infinity;
  let found = false;
  for (const session of [...sessions, ...history]) {
    if (!session.cwd.startsWith("/mnt/")) continue;
    const time = Date.parse(session.lastActivityAt);
    if (!found || time > latest) {
      cwd = session.cwd;
      latest = Number.isFinite(time) ? time : -Infinity;
      found = true;
    }
  }
  return cwd;
}

/** 预取不挡导航；最小页，三家一起按活动时间排序，失败仍用工作台。 */
export async function loadWindowsHistory(): Promise<HistorySession[]> {
  try {
    const deadline = Date.now() + 1500;
    let cursor: string | undefined;
    do {
      const result = await fetchHistory({ q: "/mnt/", limit: 1, cursor });
      const matches = result.sessions.filter((session) => session.cwd.startsWith("/mnt/"));
      if (matches.length) return matches;
      // q 也匹配标题；只有误匹配时才继续最小页，且不无限扫描。
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    } while (Date.now() < deadline);
    return [];
  } catch {
    return [];
  }
}

interface DirectoryBrowserProps {
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
  /** "file" = 选文件模式（「+」附件的「电脑上的文件」）：同层文件也可点选，隐藏「选定此目录」 */
  mode?: "dir" | "file";
  /** file 模式下点击文件条目触发；随后浏览器自行 onClose */
  onSelectFile?: (path: string, name: string) => void;
  /** 地址栏左侧显示 Windows 浏览窗口按钮（仍需后端声明 windowsDirectoryPicker） */
  allowWindowsPicker?: boolean;
}

export function DirectoryBrowser({ initialPath, onSelect, onClose, mode = "dir", onSelectFile, allowWindowsPicker = false }: DirectoryBrowserProps) {
  const fileMode = mode === "file";
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);
  return <div className="dir-overlay" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <div className="dir-dialog" role="dialog" aria-modal="true" aria-label={fileMode ? t("ui.DirectoryBrowser.select_file") : t("ui.DirectoryBrowser.browse_working_directory")}>
      <div className="dir-heading">
        <h2>{fileMode ? t("ui.DirectoryBrowser.select_file") : t("ui.DirectoryBrowser.select_working_directory")}</h2>
        <button ref={closeButton} className="btn" type="button" title={t("ui.DirectoryBrowser.cancel_and_return")} onClick={onClose}>{t("ui.common.cancel")}</button>
      </div>
      <DirectoryContents initialPath={initialPath} includeFiles={fileMode} allowWindowsPicker={allowWindowsPicker}
        onSelectDirectory={fileMode ? undefined : onSelect}
        onSelectFile={(path, name) => { onSelectFile?.(path, name); onClose(); }} />
    </div>
  </div>;
}

/** 弹窗与右侧面板共用导航、请求和列表；宿主决定点击文件后的行为。 */
export function DirectoryContents({ initialPath, refreshPath, includeFiles, onSelectFile, onEntryMenu, onSelectDirectory, allowWindowsPicker = false, onPathChange, onPathLost, onBrowseHistory, navigationHistory, registerBrowserBack, navTarget, afterLocation, showHidden = true, upIcon = false, collapsible = false }: {
  initialPath: string;
  /** 只在点击刷新时对齐此目录；变化时不自动导航。 */
  refreshPath?: string;
  includeFiles: boolean;
  onSelectFile: (path: string, name: string) => void;
  /** 表格行右键/长按；root 是当前列出的目录。 */
  onEntryMenu?: (entry: { path: string; root: string; name: string; folder: boolean }, x: number, y: number) => void;
  onSelectDirectory?: (path: string) => void;
  allowWindowsPicker?: boolean;
  onPathChange?: (path: string) => void;
  /** 导航失败、列表被清空时调用（新建表单借此不沿用上一个目录）。 */
  onPathLost?: () => void;
  onBrowseHistory?: (path: string) => void;
  navigationHistory?: RefObject<string[]>;
  registerBrowserBack?: (back: () => boolean) => () => void;
  /** 给定时导航（刷新/上一级/WSL/Windows）渲染进宿主标题栏；null = 槽位尚未挂载，先不渲染，避免闪一下内联按钮。 */
  navTarget?: HTMLElement | null;
  /** 地址栏下方的宿主内容（文件面板标签行）。 */
  afterLocation?: ReactNode;
  /** 文件表格是否列出 . 开头的条目（服务端 files=1 时总会返回）。 */
  showHidden?: boolean;
  /** 内联导航的「上一级」用文件面板同款圆形箭头钮（新建表单）。 */
  upIcon?: boolean;
  /** 新建页内嵌：所在目录即选择，列表默认收起；不回退主目录，空路径不自动打开。 */
  collapsible?: boolean;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const tableListing = useMemo(() => !listing || showHidden ? listing : {
    ...listing, dirs: listing.dirs.filter(entry => !entry.name.startsWith(".")), files: listing.files?.filter(entry => !entry.name.startsWith(".")),
  }, [listing, showHidden]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const windowsPaths = useStore(value => value.meta?.capabilities?.windowsPaths === true);
  const normalizePath = (value: string) => normalizeDirectoryPath(value, windowsPaths);
  const [address, setAddress] = useState(() => normalizePath(initialPath));
  const [addressEditing, setAddressEditing] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [listOpen, setListOpen] = useState(!collapsible);
  const listRef = useRef<HTMLDivElement>(null);
  // 新建页列表浮在表单下方（CSS 绝对定位），不撑高页面、不挪动居中内容；高度量到视口底，超出在列表内滚动。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!collapsible || !list) return;
    const fit = () => { list.style.maxHeight = `${Math.max(120, window.innerHeight - list.getBoundingClientRect().top - 16)}px`; };
    const observer = new ResizeObserver(fit);
    observer.observe(list.closest("form") ?? list);
    window.addEventListener("resize", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [collapsible, listOpen]);
  const addressRoot = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const addressCrumbs = useRef<HTMLElement>(null);
  const recentButton = useRef<HTMLButtonElement>(null);
  const recentMenu = useRef<HTMLDivElement>(null);
  const recentMenuId = useId();
  const closeRecent = (returnFocus: boolean) => {
    setRecentOpen(false);
    if (returnFocus) recentButton.current?.focus();
  };
  useAnchoredMenu({ open: recentOpen, rootRef: addressRoot, buttonRef: recentButton, panelRef: recentMenu,
    close: closeRecent, initialFocus: "button" });
  const requestId = useRef(0);
  const [windowsHistory, setWindowsHistory] = useState<HistorySession[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const nativePicker = useStore(value => allowWindowsPicker && value.meta?.capabilities?.windowsDirectoryPicker === true);
  const busy = loading || pickerBusy;
  const sessions = useStore(value => value.sessions);
  const [savedCwd] = useState(() => {
    try { return localStorage.getItem("workbench-last-cwd") ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    if (addressCrumbs.current) addressCrumbs.current.scrollLeft = addressCrumbs.current.scrollWidth;
    if (addressEditing) { addressInput.current?.focus(); addressInput.current?.select(); }
  }, [listing?.path, addressEditing]);
  useEffect(() => {
    if (!windowsPaths) return;
    let active = true;
    void loadWindowsHistory().then((history) => { if (active) setWindowsHistory(history); });
    return () => { active = false; };
  }, [windowsPaths]);

  function recordPath(path: string, back = false) {
    const visited = navigationHistory?.current;
    if (visited) {
      if (back && visited.at(-2) === path) visited.pop();
      else if (visited.at(-1) !== path) visited.push(path);
    }
    onPathChange?.(path);
  }

  /** fallback：path 读不了时改去哪（undefined = 不回退；"" = 主目录） */
  async function load(path?: string, fallback?: string, back = false) {
    setRecentOpen(false);
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDirectories(path, includeFiles);
      if (id !== requestId.current) return;
      setListing(result);
      setAddress(result.path);
      setAddressEditing(false);
      recordPath(result.path, back);
    } catch (cause) {
      if (id !== requestId.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fallback !== undefined) {
        try {
          const home = await fetchDirectories(fallback || undefined, includeFiles);
          if (id !== requestId.current) return;
          setListing(home);
          setAddress(home.path);
          setAddressEditing(false);
          recordPath(home.path);
          setError(t("ui.DirectoryBrowser.cannot_browse_opened_instead", { p0: String(path), p1: (message), p2: (home.path) }));
        } catch (homeCause) {
          if (id !== requestId.current) return;
          setError(homeCause instanceof Error ? homeCause.message : String(homeCause));
        }
      } else {
        if (!back) { setListing(null); onPathLost?.(); }
        setError(message);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    const path = normalizePath(initialPath);
    if (collapsible) {
      if (path) void load(path);
      else setLoading(false);
    } else void load(path || undefined, path ? "" : undefined);
    return () => { requestId.current += 1; };
    // 宿主在会话切换时重新挂载；后续目录导航由按钮触发。
  }, [initialPath, includeFiles]);

  useEffect(() => registerBrowserBack?.(() => {
    if (busy) return true;
    const previous = navigationHistory?.current.at(-2);
    if (!previous) return false;
    void load(previous, undefined, true);
    return true;
  }), [busy, navigationHistory, registerBrowserBack]);

  const entries = includeFiles ? [] : sortedDirectoryEntries(listing, false, { key: "name", direction: "asc" });
  const recentPaths = recentDirectoryPaths([...sessions, ...windowsHistory], [initialPath, savedCwd], windowsPaths).filter(path => path !== listing?.path);
  function toggleList() {
    if (!listOpen && !listing && !loading) void load();
    setListOpen(value => !value);
  }
  function editAddress() {
    if (busy) return;
    setRecentOpen(false);
    setAddressEditing(true);
  }

  function goUp() { if (listing?.parent) void load(listing.parent); }
  function openWindows() {
    setListOpen(true);
    const target = lastWindowsCwd(store.sessions, windowsHistory);
    void load(target, target === WINDOWS_FALLBACK ? undefined : WINDOWS_FALLBACK);
  }

  async function browseWindows() {
    if (busy) return;
    const id = requestId.current;
    setPickerBusy(true);
    setError(null);
    try {
      const picker = includeFiles ? pickWindowsFile : pickWindowsDirectory;
      const result = await picker(listing?.path ?? normalizePath(address));
      // 面板关闭或切换会话后不应用迟到选择；取消保留当前目录。
      if (id === requestId.current && result.path) {
        if (includeFiles) {
          const parent = result.path.slice(0, result.path.lastIndexOf("/")) || "/";
          recordPath(parent);
          onSelectFile(result.path, result.path.slice(result.path.lastIndexOf("/") + 1));
        } else if (onSelectDirectory) onSelectDirectory(result.path);
        else await load(result.path);
      }
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPickerBusy(false);
      pickerButton.current?.focus();
    }
  }

  return (
    <div className="dir-contents" onKeyDown={event => {
      if (collapsible && listOpen && event.key === "Escape") { event.stopPropagation(); setListOpen(false); }
    }}>
        <div className="dir-location" role="group" aria-label={t("ui.DirectoryBrowser.go_to_directory")}>
          <div className="dir-address" ref={addressRoot} tabIndex={-1}>
            {nativePicker && <button ref={pickerButton} className="dir-windows-picker" type="button" aria-label={t("ui.DirectoryBrowser.windows_file_picker")}
              title={pickerBusy ? t("ui.DirectoryBrowser.windows_file_picker_opened_waiting_for_selection") : includeFiles ? t("ui.DirectoryBrowser.open_the_windows_file_picker_to_select") : t("ui.DirectoryBrowser.open_the_windows_folder_picker")}
              aria-busy={pickerBusy} disabled={busy} onClick={() => { setRecentOpen(false); void browseWindows(); }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5V9" fill="currentColor" fillOpacity=".25" />
                <path d="M3.5 8h17a1.5 1.5 0 0 1 1.5 1.7l-1.2 9A1.5 1.5 0 0 1 19.3 20H4.7a1.5 1.5 0 0 1-1.5-1.3L2 9.7A1.5 1.5 0 0 1 3.5 8Z" fill="currentColor" fillOpacity=".5" />
              </svg>
            </button>}
            {!nativePicker && collapsible && <button className="dir-windows-picker" type="button" aria-label={t("ui.DirectoryBrowser.show_folders")}
              aria-expanded={listOpen} disabled={busy} onClick={toggleList}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5V9" fill="currentColor" fillOpacity=".25" />
                <path d="M3.5 8h17a1.5 1.5 0 0 1 1.5 1.7l-1.2 9A1.5 1.5 0 0 1 19.3 20H4.7a1.5 1.5 0 0 1-1.5-1.3L2 9.7A1.5 1.5 0 0 1 3.5 8Z" fill="currentColor" fillOpacity=".5" />
              </svg>
            </button>}
            {listing && !addressEditing ? <div className="dir-address-path">
              <nav ref={addressCrumbs} className="dir-address-crumbs" aria-label={t("ui.DirectoryBrowser.directory_breadcrumbs")}
                title={t("ui.DirectoryBrowser.click_a_directory_to_navigate_scroll_sideways")}
                onClick={event => { if (!(event.target as HTMLElement).closest("button")) editAddress(); }}
                onPaste={event => {
                  const pasted = event.clipboardData.getData("text/plain");
                  if (!busy && pasted.trim()) { event.preventDefault(); setAddress(pasted); editAddress(); }
                }}>
                {directoryBreadcrumbs(listing.path, windowsPaths).map((crumb, index) => <span className="dir-address-part" key={crumb.path}>
                  {index > 0 && <span className="dir-address-separator" aria-hidden="true">›</span>}
                  <button type="button" title={crumb.path} disabled={busy}
                    aria-current={crumb.path === listing.path ? "location" : undefined}
                    onClick={() => { setListOpen(true); void load(crumb.path); }}>{crumb.label}</button>
                </span>)}
              </nav>
              <button type="button" className="dir-address-edit" aria-label={t("ui.DirectoryBrowser.edit_directory_path")}
                title={t("ui.DirectoryBrowser.enter_or_paste_a_full_path")} disabled={busy} onClick={editAddress} />
            </div> : <input ref={addressInput} type="text" className="mono" aria-label={t("ui.DirectoryBrowser.directory_path")} value={address} disabled={busy}
              placeholder={windowsPaths ? t("ui.DirectoryBrowser.paste_a_windows_or_linux_folder_path") : t("ui.DirectoryBrowser.paste_a_folder_path")} title={t("ui.DirectoryBrowser.paste_a_directory_path_and_press_enter")} spellCheck={false} enterKeyHint="go"
              onFocus={() => setRecentOpen(false)}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!busy && address.trim()) void load(normalizePath(address));
                } else if (event.key === "Escape" && listing) {
                  event.preventDefault();
                  event.stopPropagation();
                  setAddress(listing.path);
                  setAddressEditing(false);
                  addressRoot.current?.focus();
                }
              }} />}
            <button ref={recentButton} type="button" className="dir-recent-toggle" aria-label={t("ui.DirectoryBrowser.recent_directories")} title={t("ui.DirectoryBrowser.select_a_recent_directory")}
              aria-haspopup="menu" aria-expanded={recentOpen} aria-controls={recentMenuId} disabled={busy || recentPaths.length === 0}
              onClick={() => setRecentOpen(value => !value)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {recentOpen && <div ref={recentMenu} id={recentMenuId} className="dir-recent-menu" role="menu" aria-label={t("ui.DirectoryBrowser.recent_directories")} onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRecent(true); return; }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}>
              <div className="dir-recent-heading">{t("ui.DirectoryBrowser.recent_directories")}</div>
              {recentPaths.map(path => <button type="button" className="dir-recent-option mono" role="menuitem" title={path} key={path}
                onClick={() => { setRecentOpen(false); if (collapsible) setListOpen(false); void load(path).then(() => addressRoot.current?.focus()); }}>{path}</button>)}
            </div>}
          </div>
          {onBrowseHistory && <button className="btn dir-history-button" type="button" disabled={busy || !listing}
            title={listing ? t("ui.DirectoryBrowser.view_conversations_in_and_its_subdirectories", { p0: (listing.path) }) : t("ui.DirectoryBrowser.browse_a_directory_first")}
            onClick={() => { if (listing) onBrowseHistory(listing.path); }}>{t("ui.common.sessions")}</button>}
        </div>
        {afterLocation}
        {collapsible ? <div className="dir-nav">
          {windowsPaths && <>
            <button className="btn" type="button" title={t("ui.DirectoryBrowser.open_the_wsl_home_directory")} disabled={busy} onClick={() => { setListOpen(true); void load(); }}>WSL</button>
            <button className="btn" type="button" title={t("ui.DirectoryBrowser.open_the_most_recent_windows_directory")} disabled={busy} onClick={openWindows}>Windows</button>
          </>}
          <button className="btn dir-list-toggle" type="button" aria-expanded={listOpen} disabled={busy} onClick={toggleList}>
            {listOpen ? t("ui.DirectoryBrowser.hide_folders") : t("ui.DirectoryBrowser.show_folders")}
          </button>
        </div> : navTarget === undefined ? <div className="dir-nav">
          {upIcon ? <button className="file-nav-btn file-nav-icon dir-nav-up" type="button" aria-label={t("ui.DirectoryBrowser.parent_directory")} title={t("ui.DirectoryBrowser.go_to_the_parent_of_the_current")} disabled={!listing?.parent || busy} onClick={goUp}><NavIcon d="M12 19V5 M5 12l7-7 7 7" /></button>
            : <button className="btn" type="button" title={t("ui.DirectoryBrowser.go_to_the_parent_of_the_current")} disabled={!listing?.parent || busy} onClick={goUp}>{t("ui.DirectoryBrowser.parent_directory")}</button>}
          <button className="btn" type="button" title={windowsPaths ? t("ui.DirectoryBrowser.open_the_wsl_home_directory") : t("ui.DirectoryBrowser.open_the_home_directory")} disabled={busy} onClick={() => void load()}>{windowsPaths ? "WSL" : t("ui.DirectoryBrowser.home_directory")}</button>
          {windowsPaths && <button className="btn" type="button" title={t("ui.DirectoryBrowser.open_the_most_recent_windows_directory")} disabled={busy} onClick={openWindows}>Windows</button>}
        </div> : navTarget && createPortal(<>
          <button className="file-nav-btn file-nav-icon" type="button" aria-label={t("ui.DirectoryBrowser.refresh")} title={t(refreshPath?.trim() ? "ui.DirectoryBrowser.reload_new_session_directory" : "ui.DirectoryBrowser.reload_the_current_directory_including_git_status")} disabled={busy} onClick={() => void load(normalizePath(refreshPath ?? "") || listing?.path || normalizePath(address) || undefined)}><NavIcon d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5" /></button>
          <button className="file-nav-btn file-nav-icon" type="button" aria-label={t("ui.DirectoryBrowser.parent_directory")} title={t("ui.DirectoryBrowser.go_to_the_parent_of_the_current")} disabled={!listing?.parent || busy} onClick={goUp}><NavIcon d="M12 19V5 M5 12l7-7 7 7" /></button>
          <button className="file-nav-btn" type="button" title={windowsPaths ? t("ui.DirectoryBrowser.open_the_wsl_home_directory") : t("ui.DirectoryBrowser.open_the_home_directory")} disabled={busy} onClick={() => void load()}>{windowsPaths ? "WSL" : t("ui.DirectoryBrowser.home_directory")}</button>
          {windowsPaths && <button className="file-nav-btn" type="button" title={t("ui.DirectoryBrowser.open_the_most_recent_windows_directory")} disabled={busy} onClick={openWindows}>Windows</button>}
        </>, navTarget)}
        {error && <p className="new-error" role="alert">{error}</p>}
        {listOpen && listing?.truncated && <p className="new-hint">{includeFiles ? t("ui.DirectoryBrowser.many_entries_found_up_to_1_000") : t("ui.DirectoryBrowser.this_directory_has_over_1_000_subdirectories")}</p>}
        {listOpen && <div ref={listRef} className={`dir-list${includeFiles ? " dir-list-table" : ""}`} aria-label={includeFiles ? t("ui.common.directories_and_files") : t("ui.DirectoryBrowser.subdirectories")}>
          {loading ? <p className="new-hint">{t("ui.common.reading")}</p> : includeFiles && listing && tableListing ?
            tableListing.dirs.length + (tableListing.files?.length ?? 0) > 0 ? <DirectoryTable listing={tableListing} busy={busy}
              onActivate={(path, name, folder) => folder ? void load(path) : onSelectFile(path, name)}
              onMenu={onEntryMenu && ((path, name, folder, x, y) => onEntryMenu({ path, root: listing.path, name, folder }, x, y))} /> :
              <p className="new-hint">{t("ui.DirectoryBrowser.no_directories_or_files_to_browse")}</p> : entries.length > 0 ? (
            <>
              {entries.map(entry => (
                <button className="dir-entry dir-folder" type="button" key={entry.path}
                  aria-label={entry.name} title={t("ui.common.message", { p0: (entry.folder ? t("ui.DirectoryBrowser.open_folder_detail") : t("ui.DirectoryBrowser.open_file_detail")), p1: (entry.path) })} disabled={busy}
                  onClick={() => entry.folder ? void load(entry.path) : onSelectFile(entry.path, entry.name)}>
                  <span className="dir-entry-name"><DirectoryEntryIcon folder={entry.folder} /><span className="mono">{entry.name}</span></span>
                </button>
              ))}
            </>
          ) : <p className="new-hint">{includeFiles ? t("ui.DirectoryBrowser.no_directories_or_files_to_browse") : t("ui.DirectoryBrowser.no_subdirectories_to_browse")}</p>}
        </div>}
        {onSelectDirectory && (
          <div className="dir-actions">
            <button className="btn btn-primary" type="button" title={t("ui.DirectoryBrowser.use_the_current_directory_as_the_working")} disabled={!listing || busy} onClick={() => { if (listing) onSelectDirectory(listing.path); }}>{t("ui.DirectoryBrowser.select_this_directory")}</button>
          </div>
        )}
    </div>
  );
}

function NavIcon({ d }: { d: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

function DirectoryEntryIcon({ folder }: { folder: boolean }) {
  return <svg className="dir-entry-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={folder ? "M3 7V5h6l2 2h10v13H3Z" : "M14 3H5v18h14V8ZM14 3v5h5 M8 12h8M8 16h6"} />
  </svg>;
}
