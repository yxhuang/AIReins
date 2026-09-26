import { useEffect, useRef, useState } from "react";
import { fetchDirectories } from "../api";
import type { DirectoryListing } from "../types";

interface DirectoryBrowserProps {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function DirectoryBrowser({ initialPath, onSelect, onClose }: DirectoryBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);

  async function load(path?: string, fallbackToHome = false) {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDirectories(path);
      if (id !== requestId.current) return;
      setListing(result);
    } catch (cause) {
      if (id !== requestId.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fallbackToHome) {
        try {
          const home = await fetchDirectories();
          if (id !== requestId.current) return;
          setListing(home);
          setError(`当前路径无法浏览（${message}），已回到主目录。`);
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
    closeButton.current?.focus();
    void load(initialPath.trim() || undefined, Boolean(initialPath.trim()));
    return () => { requestId.current += 1; };
    // 打开时只读取一次表单路径；后续目录导航由按钮触发。
  }, []);

  return (
    <div className="dir-overlay" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <div className="dir-dialog" role="dialog" aria-modal="true" aria-label="浏览工作目录">
        <div className="dir-heading">
          <h2>选择工作目录</h2>
          <button ref={closeButton} className="btn" type="button" onClick={onClose}>取消</button>
        </div>
        <p className="dir-path mono" aria-label="当前路径">{listing?.path ?? "正在读取目录…"}</p>
        <div className="dir-nav">
          <button className="btn" type="button" disabled={!listing?.parent || loading} onClick={() => { if (listing?.parent) void load(listing.parent); }}>上一级</button>
          <button className="btn" type="button" disabled={loading} onClick={() => void load()}>回到主目录</button>
        </div>
        {error && <p className="new-error" role="alert">{error}</p>}
        {listing?.truncated && <p className="new-hint">此目录下子目录超过 1000 个，仅显示前 1000 个。</p>}
        <div className="dir-list" aria-label="子目录列表">
          {loading ? <p className="new-hint">正在读取…</p> : listing?.dirs.length ? listing.dirs.map((dir) => (
            <button className="dir-entry mono" type="button" key={dir.path} onClick={() => void load(dir.path)}>{dir.name}</button>
          )) : <p className="new-hint">没有可浏览的子目录。</p>}
        </div>
        <div className="dir-actions">
          <button className="btn btn-primary" type="button" disabled={!listing || loading} onClick={() => { if (listing) onSelect(listing.path); }}>选定此目录</button>
        </div>
      </div>
    </div>
  );
}
