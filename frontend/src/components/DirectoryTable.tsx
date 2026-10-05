import { useLayoutEffect, useRef, useState } from "react";
import { directoryEntryDate, directoryEntrySize, sortedDirectoryEntries, type DirectorySort } from "../directory-path";
import type { DirectoryListing } from "../types";

/** 表体直接生成文本 DOM；只在目录变化时建行，排序移动已有行，避免大目录逐行挂载 React 状态。 */
export function DirectoryTable({ listing, busy, onActivate }: {
  listing: DirectoryListing;
  busy: boolean;
  onActivate: (path: string, name: string, folder: boolean) => void;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const [sort, setSort] = useState<DirectorySort>({ key: "name", direction: "asc" });

  useLayoutEffect(() => {
    for (const [folder, entries] of [[true, listing.dirs], [false, listing.files ?? []]] as const) {
      for (const entry of entries) {
        const row = document.createElement("tr");
        row.dataset.path = entry.path;
        row.title = `${folder ? "打开文件夹" : "打开文件"}：${entry.path}`;
        const name = document.createElement("button");
        name.type = "button";
        name.className = `dir-table-name${folder ? " dir-table-folder" : ""}`;
        name.textContent = entry.name;
        row.insertCell().append(name);
        const size = row.insertCell();
        size.className = "dir-table-size";
        size.textContent = folder ? "" : directoryEntrySize(entry.size);
        size.title = folder ? "文件夹" : entry.size == null ? "大小未知" : `${entry.size} 字节`;
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

  return <table className="dir-table" aria-label="目录与文件详情" aria-disabled={busy}>
    <thead><tr>
      {([["name", "名称"], ["size", "大小"], ["modifiedAt", "修改日期"]] as const).map(([key, label]) =>
        <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
          <button className="dir-table-sort" type="button" aria-label={`按${label}排序`} aria-pressed={sort.key === key}
            title={`按${label}排序，再次点击切换升降序`} disabled={busy}
            onClick={() => setSort(value => ({ key, direction: value.key === key ? value.direction === "asc" ? "desc" : "asc" : key === "name" ? "asc" : "desc" }))}>
            {label}{sort.key === key && <span aria-hidden="true">{sort.direction === "asc" ? " ↑" : " ↓"}</span>}
          </button>
        </th>)}
    </tr></thead>
    <tbody ref={body} onClick={event => {
      if (busy || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLTableRowElement>("tr[data-path]");
      if (!row || !body.current?.contains(row)) return;
      const folder = listing.dirs.find(entry => entry.path === row.dataset.path);
      const entry = folder ?? listing.files?.find(entry => entry.path === row.dataset.path);
      if (entry) onActivate(entry.path, entry.name, Boolean(folder));
    }} />
  </table>;
}
