// @ 文件引用：纯文本 token 的提取与光标处触发判定。
// token = 空白分隔的一段；只有 token 首字符是 @ 才算引用（foo@bar.com 这类不误判）。
// 文本中的 @路径 原样保留发送（后端三家翻译都需要 @ 锚点），这里只负责找出候选路径。

/** 从整段文本提取去重后的引用路径（不含 @），保持出现顺序。 */
export function extractMentionTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = match[1];
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 光标落在「@ 开头」的 token 内或末尾时返回触发信息（start 为 token 起点，query 为 @ 后到光标的部分）。
 * 句中触发：只要求 token 以 @ 开头，不要求行首。
 */
export function mentionQueryAt(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
  const token = text.slice(start, cursor);
  if (!token.startsWith("@")) return null;
  return { start, query: token.slice(1) };
}

/** 当前 token 的终点（从 cursor 向后扫到下一个空白），用于选中后整 token 替换。 */
export function mentionTokenEnd(text: string, cursor: number): number {
  let end = cursor;
  while (end < text.length && !/\s/.test(text.charAt(end))) end++;
  return end;
}

// 尾部可剥离字符集：中英文标点与常见结束符。
// 不含 - 与 _：路径常用字符，剥了会冤杀真实文件名。
// 含 .：剥离候选只在「剥后命中真实文件」时才被采纳（存在性判定在 store 层），
// 因此 a.ts 这种点在中段的 token 不受影响，只有「@file.」这种尾点才产生候选。
const TRAILING_STRIP = new Set([..."，。、；：！？）》」』,.;:!?)]}\"'`…"]);

/**
 * 给定 token 产出逐级剥掉尾部标点的候选列表（长的在前，不含原 token）。
 * 上层只在整 token 查无此文件时按序查询，命中真实文件才采纳；
 * 无尾部标点（或会剥成空串）时返回空列表——不产生剥离需求。
 */
export function stripMentionCandidates(token: string): string[] {
  const out: string[] = [];
  let current = token;
  while (current.length > 0 && TRAILING_STRIP.has(current.charAt(current.length - 1))) {
    current = current.slice(0, -1);
    if (current.length > 0) out.push(current);
  }
  return out;
}
