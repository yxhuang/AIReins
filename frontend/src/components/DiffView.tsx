// 共用 diff 渲染：闸门卡片与工具展开体（编辑/写入）都用它。
// 颜色一律走 --diff-* 令牌；闸门的琥珀金只留给闸门卡片本身，不进这里。
import { Fragment } from "react";

export interface DiffChunk {
  /** 分组标题（如 MultiEdit 的「改动 #n」）；缺省时不渲染标题行 */
  title?: string;
  removed: string;
  added: string;
}

export function DiffView({ chunks }: { chunks: DiffChunk[] }) {
  return (
    <pre className="code-block diff-block">
      {chunks.map((chunk, ci) => (
        <Fragment key={ci}>
          {chunk.title && <span className="diff-line diff-chunk-title">{chunk.title}</span>}
          {lineDiff(chunk.removed, chunk.added).map(([op, line], i) => (
            <span key={i} className={op === "-" ? "diff-line diff-del" : op === "+" ? "diff-line diff-add" : "diff-line"}>
              {`${op} ${line}`}
            </span>
          ))}
        </Fragment>
      ))}
    </pre>
  );
}

// 块内逐行对齐：按行 LCS，未变行原样保留（前缀空格）。
// ponytail: O(n·m) 表，超过 MAX_CELLS 退回整段删除 / 整段新增；真有巨型 diff 再换 Myers。
const MAX_CELLS = 250_000;
export function lineDiff(removed: string, added: string): [" " | "-" | "+", string][] {
  const a = removed ? splitLines(removed) : [];
  const b = added ? splitLines(added) : [];
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS || !n || !m) {
    return [...a.map((l) => ["-", l] as [" " | "-" | "+", string]), ...b.map((l) => ["+", l] as [" " | "-" | "+", string])];
  }
  // lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: [" " | "-" | "+", string][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([" ", a[i]!]); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(["-", a[i++]!]);
    else out.push(["+", b[j++]!]);
  }
  while (i < n) out.push(["-", a[i++]!]);
  while (j < m) out.push(["+", b[j++]!]);
  return out;
}

export function splitLines(text: string): string[] {
  return text.replace(/\n+$/, "").split("\n");
}
