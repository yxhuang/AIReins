import { normalizeDirectoryPath } from "./directory-path";

/** 普通网页保持外链；只有明确文件 URI 或会话所属 cwd 的路径才接入面板。 */
export function resolveLocalFileLink(href: string, cwd?: string, windowsPaths = true): string | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch { return null; }
  } else if (/^vscode:\/\/file\//i.test(path)) path = path.replace(/^vscode:\/\/file/i, "");
  else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  // 先去掉行号/片段，再解码，保留编码后的文件名 # 与 ?。
  path = path.split(/[?#]/, 1)[0]!.replace(/:\d+(?::\d+)?$/, "");
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/^vscode:\/\/file/i.test(href) && /^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  if (!windowsPaths && /^[a-z]:[\\/]/i.test(path)) return null;
  path = normalizeDirectoryPath(path, windowsPaths);
  if (!path || path.includes("\0")) return null;
  if (!path.startsWith("/")) {
    if (!cwd || !normalizeDirectoryPath(cwd, windowsPaths).startsWith("/")) return null;
    path = `${normalizeDirectoryPath(cwd, windowsPaths)}/${path}`;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** 有限 RFC4180 风格预览；字段内分隔符/换行及双引号转义不丢失。 */
export function parseDelimited(text: string, delimiter: string, maxRows = 200, maxColumns = 100): {
  rows: string[][]; truncated: boolean; error?: string;
} {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false, truncated = false;
  const input = text.replace(/^\ufeff/, "");
  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else truncated = true;
    field = ""; closed = false;
  };
  for (let i = 0; i < input.length; i++) {
    if (rows.length === maxRows) return { rows, truncated: true };
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === delimiter) pushField();
    else if (char === "\r" || char === "\n") {
      pushField(); rows.push(row); row = [];
      if (char === "\r" && input[i + 1] === "\n") i++;
    } else if (char === '"' && field === "" && !closed) quoted = true;
    else if (closed || char === '"') return { rows, truncated, error: "字段引号格式不完整，请查看原文。" };
    else field += char;
  }
  if (quoted) return { rows, truncated, error: "字段引号未闭合，请查看原文。" };
  if (field || row.length || closed) { pushField(); rows.push(row); }
  return { rows, truncated };
}

/** HTML 只呈现内联样式/data 图片。sandbox 由 iframe 再独立强制。 */
export function isolatedHtml(text: string): string {
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script,base,meta[http-equiv],iframe,object,embed,form").forEach(node => node.remove());
  doc.querySelectorAll("a,area").forEach(node => node.removeAttribute("href"));
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${doc.documentElement.outerHTML}`;
}
