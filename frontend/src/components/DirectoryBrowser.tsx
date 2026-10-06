import { useEffect, useId, useRef, useState, type RefObject } from "react";
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
    <div className="dir-dialog" role="dialog" aria-modal="true" aria-label={fileMode ? "选择文件" : "浏览工作目录"}>
      <div className="dir-heading">
        <h2>{fileMode ? "选择文件" : "选择工作目录"}</h2>
        <button ref={closeButton} className="btn" type="button" title="取消并返回" onClick={onClose}>取消</button>
      </div>
      <DirectoryContents initialPath={initialPath} includeFiles={fileMode} allowWindowsPicker={allowWindowsPicker}
        onSelectDirectory={fileMode ? undefined : onSelect}
        onSelectFile={(path, name) => { onSelectFile?.(path, name); onClose(); }} />
    </div>
  </div>;
}

/** 弹窗与右侧面板共用导航、请求和列表；宿主决定点击文件后的行为。 */
export function DirectoryContents({ initialPath, includeFiles, onSelectFile, onSelectDirectory, allowWindowsPicker = false, onPathChange, onBrowseHistory, navigationHistory, registerBrowserBack }: {
  initialPath: string;
  includeFiles: boolean;
  onSelectFile: (path: string, name: string) => void;
  onSelectDirectory?: (path: string) => void;
  allowWindowsPicker?: boolean;
  onPathChange?: (path: string) => void;
  onBrowseHistory?: (path: string) => void;
  navigationHistory?: RefObject<string[]>;
  registerBrowserBack?: (back: () => boolean) => () => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(() => normalizeDirectoryPath(initialPath));
  const [addressEditing, setAddressEditing] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
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
    let active = true;
    void loadWindowsHistory().then((history) => { if (active) setWindowsHistory(history); });
    return () => { active = false; };
  }, []);

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
          setError(`${path} 无法浏览（${message}），已改为打开 ${home.path}。`);
        } catch (homeCause) {
          if (id !== requestId.current) return;
          setError(homeCause instanceof Error ? homeCause.message : String(homeCause));
        }
      } else {
        if (!back) setListing(null);
        setError(message);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    const path = normalizeDirectoryPath(initialPath);
    void load(path || undefined, path ? "" : undefined);
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
  const recentPaths = recentDirectoryPaths([...sessions, ...windowsHistory], [initialPath, savedCwd]).filter(path => path !== listing?.path);
  function editAddress() {
    if (busy) return;
    setRecentOpen(false);
    setAddressEditing(true);
  }

  async function browseWindows() {
    if (busy) return;
    const id = requestId.current;
    setPickerBusy(true);
    setError(null);
    try {
      const picker = includeFiles ? pickWindowsFile : pickWindowsDirectory;
      const result = await picker(listing?.path ?? normalizeDirectoryPath(address));
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
    <div className="dir-contents">
        <div className="dir-location" role="group" aria-label="前往目录">
          <div className="dir-address" ref={addressRoot} tabIndex={-1}>
            {nativePicker && <button ref={pickerButton} className="dir-windows-picker" type="button" aria-label="Windows 浏览窗口"
              title={pickerBusy ? "Windows 浏览窗口已打开，等待选择" : includeFiles ? "打开 Windows 浏览窗口，选择文件并预览" : "打开 Windows 浏览窗口，选择文件夹"}
              aria-busy={pickerBusy} disabled={busy} onClick={() => { setRecentOpen(false); void browseWindows(); }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5V9" fill="currentColor" fillOpacity=".25" />
                <path d="M3.5 8h17a1.5 1.5 0 0 1 1.5 1.7l-1.2 9A1.5 1.5 0 0 1 19.3 20H4.7a1.5 1.5 0 0 1-1.5-1.3L2 9.7A1.5 1.5 0 0 1 3.5 8Z" fill="currentColor" fillOpacity=".5" />
              </svg>
            </button>}
            {listing && !addressEditing ? <div className="dir-address-path">
              <nav ref={addressCrumbs} className="dir-address-crumbs" aria-label="地址栏目录层级"
                title="点击目录层级跳转；横向滚动查看上级；点击空白处编辑路径"
                onClick={event => { if (!(event.target as HTMLElement).closest("button")) editAddress(); }}
                onPaste={event => {
                  const pasted = event.clipboardData.getData("text/plain");
                  if (!busy && pasted.trim()) { event.preventDefault(); setAddress(pasted); editAddress(); }
                }}>
                {directoryBreadcrumbs(listing.path).map((crumb, index) => <span className="dir-address-part" key={crumb.path}>
                  {index > 0 && <span className="dir-address-separator" aria-hidden="true">›</span>}
                  <button type="button" title={crumb.path} disabled={busy}
                    aria-current={crumb.path === listing.path ? "location" : undefined}
                    onClick={() => void load(crumb.path)}>{crumb.label}</button>
                </span>)}
              </nav>
              <button type="button" className="dir-address-edit" aria-label="编辑目录路径"
                title="输入或粘贴完整路径" disabled={busy} onClick={editAddress} />
            </div> : <input ref={addressInput} type="text" className="mono" aria-label="目录路径" value={address} disabled={busy}
              placeholder="粘贴 Windows 或 Linux 文件夹路径" title="粘贴目录路径，按 Enter 前往；右侧下拉选择最近目录" spellCheck={false}
              onFocus={() => setRecentOpen(false)}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!busy && address.trim()) void load(normalizeDirectoryPath(address));
                } else if (event.key === "Escape" && listing) {
                  event.preventDefault();
                  event.stopPropagation();
                  setAddress(listing.path);
                  setAddressEditing(false);
                  addressRoot.current?.focus();
                }
              }} />}
            <button ref={recentButton} type="button" className="dir-recent-toggle" aria-label="最近目录" title="选择最近使用的目录"
              aria-haspopup="menu" aria-expanded={recentOpen} aria-controls={recentMenuId} disabled={busy || recentPaths.length === 0}
              onClick={() => setRecentOpen(value => !value)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {recentOpen && <div ref={recentMenu} id={recentMenuId} className="dir-recent-menu" role="menu" aria-label="最近目录" onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRecent(true); return; }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }}>
              <div className="dir-recent-heading">最近目录</div>
              {recentPaths.map(path => <button type="button" className="dir-recent-option mono" role="menuitem" title={path} key={path}
                onClick={() => { setRecentOpen(false); void load(path).then(() => addressRoot.current?.focus()); }}>{path}</button>)}
            </div>}
          </div>
          <button className="btn" type="button" title="可粘贴 Windows 或 Linux 文件夹地址，按 Enter 或点击前往" disabled={busy || !address.trim()}
            onClick={() => void load(normalizeDirectoryPath(address))}>前往</button>
          {onBrowseHistory && <button className="btn dir-history-button" type="button" disabled={busy || !listing}
            title={listing ? `查看 ${listing.path} 及子目录的对话` : "先浏览目录"}
            onClick={() => { if (listing) onBrowseHistory(listing.path); }}>此目录的对话</button>}
        </div>
        <div className="dir-nav">
          <button className="btn" type="button" title="返回当前目录的上一级" disabled={!listing?.parent || busy} onClick={() => { if (listing?.parent) void load(listing.parent); }}>上一级</button>
          <button className="btn" type="button" title="打开 WSL 主目录" disabled={busy} onClick={() => void load()}>WSL</button>
          <button className="btn" type="button" title="打开最近使用的 Windows 目录" disabled={busy} onClick={() => {
            const target = lastWindowsCwd(store.sessions, windowsHistory);
            void load(target, target === WINDOWS_FALLBACK ? undefined : WINDOWS_FALLBACK);
          }}>Windows</button>
        </div>
        {error && <p className="new-error" role="alert">{error}</p>}
        {listing?.truncated && <p className="new-hint">{includeFiles ? "条目较多，文件夹和文件各最多显示 1000 个。" : "此目录下子目录超过 1000 个，仅显示前 1000 个。"}</p>}
        <div className={`dir-list${includeFiles ? " dir-list-table" : ""}`} aria-label={includeFiles ? "目录与文件列表" : "子目录列表"}>
          {loading ? <p className="new-hint">正在读取…</p> : includeFiles && listing ?
            listing.dirs.length + (listing.files?.length ?? 0) > 0 ? <DirectoryTable listing={listing} busy={busy}
              onActivate={(path, name, folder) => folder ? void load(path) : onSelectFile(path, name)} /> :
              <p className="new-hint">没有可浏览的目录或文件。</p> : entries.length > 0 ? (
            <>
              {entries.map(entry => (
                <button className="dir-entry dir-folder" type="button" key={entry.path}
                  aria-label={entry.name} title={`${entry.folder ? "打开文件夹" : "打开文件"}：${entry.path}`} disabled={busy}
                  onClick={() => entry.folder ? void load(entry.path) : onSelectFile(entry.path, entry.name)}>
                  <span className="dir-entry-name"><DirectoryEntryIcon folder={entry.folder} /><span className="mono">{entry.name}</span></span>
                </button>
              ))}
            </>
          ) : <p className="new-hint">{includeFiles ? "没有可浏览的目录或文件。" : "没有可浏览的子目录。"}</p>}
        </div>
        {onSelectDirectory && (
          <div className="dir-actions">
            <button className="btn btn-primary" type="button" title="使用当前目录作为工作目录" disabled={!listing || busy} onClick={() => { if (listing) onSelectDirectory(listing.path); }}>选定此目录</button>
          </div>
        )}
    </div>
  );
}

function DirectoryEntryIcon({ folder }: { folder: boolean }) {
  return <svg className="dir-entry-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={folder ? "M3 7V5h6l2 2h10v13H3Z" : "M14 3H5v18h14V8ZM14 3v5h5 M8 12h8M8 16h6"} />
  </svg>;
}
