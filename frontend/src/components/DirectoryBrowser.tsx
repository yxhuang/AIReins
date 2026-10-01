import { useEffect, useRef, useState } from "react";
import { fetchDirectories } from "../api";
import { store } from "../store";
import type { DirectoryListing } from "../types";

const WINDOWS_FALLBACK = "/mnt/c/Users";

/** 「Windows」按钮的落点：最近活跃的、工作目录在 /mnt/ 下的会话（服务端记录，电脑和手机一致）。 */
function lastWindowsCwd(): string {
  const latest = store.sessions
    .filter((session) => session.cwd.startsWith("/mnt/"))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))[0];
  return latest?.cwd ?? WINDOWS_FALLBACK;
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
            const target = lastWindowsCwd();
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
