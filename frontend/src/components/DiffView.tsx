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
          {chunk.removed &&
            splitLines(chunk.removed).map((line, i) => (
              <span key={`d${i}`} className="diff-line diff-del">{`- ${line}`}</span>
            ))}
          {chunk.added &&
            splitLines(chunk.added).map((line, i) => (
              <span key={`a${i}`} className="diff-line diff-add">{`+ ${line}`}</span>
            ))}
        </Fragment>
      ))}
    </pre>
  );
}

// 行数统计：去掉末尾换行后按 \n 计。
export function countLines(text: string): number {
  if (!text) return 0;
  return splitLines(text).length;
}

export function splitLines(text: string): string[] {
  return text.replace(/\n+$/, "").split("\n");
}
