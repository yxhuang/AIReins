import { t } from "../i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { directoryEntryDate, directoryEntrySize, sortedDirectoryEntries, type DirectorySort } from "../directory-path";
import type { DirectoryListing } from "../types";

const GIT_LABELS: Record<string, string> = { M: t("ui.DirectoryTable.modified"), A: t("ui.DirectoryTable.added"), R: t("ui.DirectoryTable.renamed"), D: t("ui.DirectoryTable.deleted"), U: t("ui.DirectoryTable.untracked"), "!": t("ui.DirectoryTable.conflicted") };

/** 表体直接生成文本 DOM；只在目录变化时建行，排序移动已有行，避免大目录逐行挂载 React 状态。 */
export function DirectoryTable({ listing, busy, onActivate, onMenu }: {
  listing: DirectoryListing;
  busy: boolean;
  onActivate: (path: string, name: string, folder: boolean) => void;
  /** 右键、Android 长按、菜单键走 contextmenu；iOS 长按自己计时。 */
  onMenu?: (path: string, name: string, folder: boolean, x: number, y: number) => void;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const clearLongPress = () => { if (longPress.current) window.clearTimeout(longPress.current.timer); longPress.current = null; };
  const entryAt = (target: EventTarget) => {
    if (busy || !(target instanceof Element)) return null;
    const row = target.closest<HTMLTableRowElement>("tr[data-path]");
    if (!row || !body.current?.contains(row)) return null;
    const folder = listing.dirs.find(entry => entry.path === row.dataset.path);
    const entry = folder ?? listing.files?.find(entry => entry.path === row.dataset.path);
    return entry ? { entry, folder: Boolean(folder), row } : null;
  };
  const [sort, setSort] = useState<DirectorySort>({ key: "name", direction: "asc" });

  useLayoutEffect(() => {
    for (const [folder, entries] of [[true, listing.dirs], [false, listing.files ?? []]] as const) {
      for (const entry of entries) {
        const row = document.createElement("tr");
        row.dataset.path = entry.path;
        row.title = t("ui.common.message", { p0: (folder ? t("ui.DirectoryBrowser.open_folder_detail") : t("ui.DirectoryBrowser.open_file_detail")), p1: (entry.path) });
        const name = document.createElement("button");
        name.type = "button";
        name.className = `dir-table-name${folder ? " dir-table-folder" : ""}${entry.name.startsWith(".") ? " dir-table-hidden" : ""}`;
        name.textContent = entry.name;
        const mark = listing.git?.[entry.name];
        if (mark) {
          const badge = document.createElement("span");
          badge.className = "dir-git";
          badge.textContent = folder ? "●" : mark;
          name.dataset.git = mark;
          name.append(badge);
          row.title += t("ui.DirectoryTable.git", { p0: (folder ? t("ui.DirectoryTable.changes_below_detail") : ""), p1: (GIT_LABELS[mark] ?? mark), p2: (folder ? "）" : "") });
        }
        row.insertCell().append(name);
        const size = row.insertCell();
        size.className = "dir-table-size";
        size.textContent = folder ? "" : directoryEntrySize(entry.size);
        size.title = folder ? t("ui.DirectoryTable.folder") : entry.size == null ? t("ui.DirectoryTable.size_unknown") : t("ui.DirectoryTable.bytes", { p0: (entry.size) });
        const date = row.insertCell();
        date.className = "dir-table-date";
        date.textContent = directoryEntryDate(entry.modifiedAt);
        rows.current.set(entry.path, row);
      }
    }
    const tableBody = body.current;
    return () => { rows.current.clear(); tableBody?.replaceChildren(); };
  }, [listing]);

  useLayoutEffect(() => {
    const tableBody = body.current;
    if (!tableBody) return;
    let next: ChildNode | null = tableBody.firstChild;
    for (const entry of sortedDirectoryEntries(listing, true, sort)) {
      const row = rows.current.get(entry.path);
      if (!row) continue;
      if (row === next) next = next.nextSibling;
      else tableBody.insertBefore(row, next);
    }
  }, [listing, sort]);

  useLayoutEffect(() => {
    for (const row of rows.current.values()) row.querySelector("button")!.disabled = busy;
  }, [listing, busy]);

  return <table className={`dir-table${listing.git ? " dir-table-git" : ""}`} aria-label={t("ui.DirectoryTable.directory_and_file_details")} aria-disabled={busy}>
    <thead><tr>
      {([["name", t("ui.DirectoryTable.name")], ["size", t("ui.DirectoryTable.size")], ["modifiedAt", t("ui.DirectoryTable.modified_2")]] as const).map(([key, label]) =>
        <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
          <button className="dir-table-sort" type="button" aria-label={t("ui.DirectoryTable.sort_by", { p0: (label) })} aria-pressed={sort.key === key}
            title={t("ui.DirectoryTable.sort_by_click_again_to_reverse_the", { p0: (label) })} disabled={busy}
            onClick={() => setSort(value => ({ key, direction: value.key === key ? value.direction === "asc" ? "desc" : "asc" : key === "name" ? "asc" : "desc" }))}>
            {label}{sort.key === key && <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>}
          </button>
        </th>)}
    </tr></thead>
    <tbody ref={body} onClick={event => {
      // 只吞长按后的那次触屏点击；键盘 Enter/Space 的 click detail 为 0，不受残留标记影响。
      if (suppressClick.current) { suppressClick.current = false; if (event.detail !== 0) return; }
      const hit = entryAt(event.target);
      if (hit) onActivate(hit.entry.path, hit.entry.name, hit.folder);
    }} onContextMenu={onMenu && (event => {
      const hit = entryAt(event.target);
      if (!hit) return;
      event.preventDefault();
      clearLongPress();
      const rect = hit.row.getBoundingClientRect();
      if (event.clientX === 0 && event.clientY === 0) onMenu(hit.entry.path, hit.entry.name, hit.folder, rect.left + 24, rect.bottom);
      else onMenu(hit.entry.path, hit.entry.name, hit.folder, event.clientX, event.clientY);
    })} onPointerDown={onMenu && (event => {
      suppressClick.current = false;
      if (event.pointerType !== "touch") return;
      const hit = entryAt(event.target);
      if (!hit) return;
      const { clientX: x, clientY: y } = event;
      longPress.current = { x, y, timer: window.setTimeout(() => {
        longPress.current = null;
        suppressClick.current = true;
        onMenu(hit.entry.path, hit.entry.name, hit.folder, x, y);
      }, 500) };
    })} onPointerMove={event => {
      const start = longPress.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearLongPress();
    }} onPointerUp={clearLongPress} onPointerCancel={clearLongPress} />
  </table>;
}
