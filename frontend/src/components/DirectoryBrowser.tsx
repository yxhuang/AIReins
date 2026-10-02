import { useEffect, useRef, useState } from "react";
import { fetchDirectories, fetchHistory } from "../api";
import { store } from "../store";
import type { DirectoryListing, HistorySession } from "../types";

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
}

export function DirectoryBrowser({ initialPath, onSelect, onClose, mode = "dir", onSelectFile }: DirectoryBrowserProps) {
  const fileMode = mode === "file";
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);
  return <div className="dir-overlay" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <div className="dir-dialog" role="dialog" aria-modal="true" aria-label={fileMode ? "选择文件" : "浏览工作目录"}>
      <div className="dir-heading">
        <h2>{fileMode ? "选择文件" : "选择工作目录"}</h2>
        <button ref={closeButton} className="btn" type="button" onClick={onClose}>取消</button>
      </div>
      <DirectoryContents initialPath={initialPath} includeFiles={fileMode}
        onSelectDirectory={fileMode ? undefined : onSelect}
        onSelectFile={(path, name) => { onSelectFile?.(path, name); onClose(); }} />
    </div>
  </div>;
}

/** 弹窗与右侧面板共用导航、请求和列表；宿主决定点击文件后的行为。 */
export function DirectoryContents({ initialPath, includeFiles, onSelectFile, onSelectDirectory }: {
  initialPath: string;
  includeFiles: boolean;
  onSelectFile: (path: string, name: string) => void;
  onSelectDirectory?: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [windowsHistory, setWindowsHistory] = useState<HistorySession[]>([]);
  useEffect(() => {
    let active = true;
    void loadWindowsHistory().then((history) => { if (active) setWindowsHistory(history); });
    return () => { active = false; };
  }, []);

  /** fallback：path 读不了时改去哪（undefined = 不回退；"" = 主目录） */
  async function load(path?: string, fallback?: string) {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDirectories(path, includeFiles);
      if (id !== requestId.current) return;
      setListing(result);
    } catch (cause) {
      if (id !== requestId.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fallback !== undefined) {
        try {
          const home = await fetchDirectories(fallback || undefined, includeFiles);
          if (id !== requestId.current) return;
          setListing(home);
          setError(`${path} 无法浏览（${message}），已改为打开 ${home.path}。`);
        } catch (homeCause) {
          if (id !== requestId.current) return;
          setError(homeCause instanceof Error ? homeCause.message : String(homeCause));
        }
      } else {
        setError(message);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath.trim() || undefined, initialPath.trim() ? "" : undefined);
    return () => { requestId.current += 1; };
    // 宿主在会话切换时重新挂载；后续目录导航由按钮触发。
  }, [initialPath, includeFiles]);

  const entries = (listing?.dirs.length ?? 0) + (includeFiles ? listing?.files?.length ?? 0 : 0);

  return (
    <div className="dir-contents">
        <p className="dir-path mono" aria-label="当前路径">{listing?.path ?? "正在读取目录…"}</p>
        <div className="dir-nav">
          <button className="btn" type="button" disabled={!listing?.parent || loading} onClick={() => { if (listing?.parent) void load(listing.parent); }}>上一级</button>
          <button className="btn" type="button" disabled={loading} onClick={() => void load()}>主目录</button>
          <button className="btn" type="button" disabled={loading} onClick={() => {
            const target = lastWindowsCwd(store.sessions, windowsHistory);
            void load(target, target === WINDOWS_FALLBACK ? undefined : WINDOWS_FALLBACK);
          }}>Windows</button>
        </div>
        {error && <p className="new-error" role="alert">{error}</p>}
        {listing?.truncated && <p className="new-hint">此目录下子目录超过 1000 个，仅显示前 1000 个。</p>}
        <div className="dir-list" aria-label={includeFiles ? "目录与文件列表" : "子目录列表"}>
          {loading ? <p className="new-hint">正在读取…</p> : entries > 0 ? (
            <>
              {listing?.dirs.map((dir) => (
                <button className="dir-entry mono" type="button" key={dir.path} onClick={() => void load(dir.path)}>{dir.name}</button>
              ))}
              {includeFiles && listing?.files?.map((file) => (
                <button className="dir-entry dir-file mono" type="button" key={file.path} onClick={() => onSelectFile(file.path, file.name)}>{file.name}</button>
              ))}
            </>
          ) : <p className="new-hint">{includeFiles ? "没有可浏览的目录或文件。" : "没有可浏览的子目录。"}</p>}
        </div>
        {onSelectDirectory && (
          <div className="dir-actions">
            <button className="btn btn-primary" type="button" disabled={!listing || loading} onClick={() => { if (listing) onSelectDirectory(listing.path); }}>选定此目录</button>
          </div>
        )}
    </div>
  );
}
