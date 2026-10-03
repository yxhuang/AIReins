import { useEffect, useRef, useState } from "react";
import { mentionQueryAt } from "../mentions";
import { store } from "../store";
import type { SessionRecord } from "../types";
import { useStore } from "../useStore";
import { DirectoryContents } from "./DirectoryBrowser";
import { FILE_WIDTH_OPTIONS, PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";

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
  if (!session) return { path: null, reason: "没有当前会话，仅复制路径。" };
  if (session.status === "dead") return { path: null, reason: "会话已结束，仅复制路径。" };
  if (!mentionsSupported) return { path: null, reason: "当前 driver 不支持 @ 引用，仅复制路径。" };
  const root = absolutePath(session.cwd);
  const file = absolutePath(path);
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!root || !file || !file.startsWith(prefix) || file === root) {
    return { path: null, reason: "文件不在会话 cwd 之下，仅复制路径。" };
  }
  const relative = file.slice(prefix.length);
  if (/\s/u.test(relative)) return { path: null, reason: "相对路径含空白字符，@ 引用会被截断，仅复制路径。" };
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
  const [width, setWidth] = useSidePanelWidth(FILE_WIDTH_OPTIONS);
  const [notice, setNotice] = useState<{ path: string; copied: boolean | null; reason: string | null } | null>(null);
  const copyId = useRef(0);
  useEffect(() => () => { copyId.current += 1; }, []);

  const selectFile = (path: string) => {
    // 点击时读当前状态；插入不等待异步剪贴板，避免切会话后错插。
    const current = store.currentId ? store.session(store.currentId) : undefined;
    const supported = current ? store.meta?.drivers[current.agent]?.mentions === true : false;
    const plan = planFileMention(current, supported, path);
    if (current && plan.path !== null) store.requestFileMention(current.id, path);
    const id = ++copyId.current;
    setNotice({ path, copied: null, reason: plan.reason });
    void (async () => {
      let copied = false;
      try { await navigator.clipboard.writeText(path); copied = true; } catch { /* 保留完整路径供手动复制。 */ }
      if (id === copyId.current) setNotice({ path, copied, reason: plan.reason });
    })();
  };

  return <>
    <SidePanelResize label="文件" width={width} setWidth={setWidth} minWidth={FILE_WIDTH_OPTIONS.minWidth} defaultWidth={FILE_WIDTH_OPTIONS.defaultWidth} />
    <div id="file-panel" className="term-panel file-side-panel" role="region" aria-label="文件面板" style={{ width: `${width}px` }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
      <div className="term-titlebar">
        <PanelBackButton onClick={onClose} />
        <strong className="file-side-title">文件</strong>
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label="收起文件面板" title="收起面板" onClick={onClose}><PanelRightIcon /></button>
      </div>
      {notice && <div className="file-notice" role="status">
        {notice.reason && <p>{notice.reason}</p>}
        <p className="dir-copy-status mono">{notice.copied === null ? "正在复制：" : notice.copied ? "已复制：" : "无法自动复制，请手动复制："}{notice.path}</p>
      </div>}
      <DirectoryContents initialPath={session?.cwd ?? ""} includeFiles onSelectFile={selectFile} />
    </div>
  </>;
}
