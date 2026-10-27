// @ 文件引用：纯文本 token 的提取与光标处触发判定。
// token = 空白分隔的一段；只有 token 首字符是 @ 才算引用（foo@bar.com 这类不误判）。
// 文本中的 @路径 原样保留发送（后端三家翻译都需要 @ 锚点），这里只负责找出候选路径。

// 尾部可剥离字符集：中英文标点与常见结束符。
// 不含 - 与 _：路径常用字符，剥了会冤杀真实文件名。
// 含 .：剥离候选只在「剥后命中真实文件」时才被采纳（存在性判定在 store 层），
// 因此 a.ts 这种点在中段的 token 不受影响，只有「@file.」这种尾点才产生候选。
const TRAILING_STRIP = new Set([..."，。、；：！？）》」』,.;:!?)]}\"'`…"]);

// token 边界判定：空白 + 句读标点（TRAILING_STRIP 去掉 .——点是路径常态组成，
// 作边界会把 @a.ts 从中间切开）。中文输入习惯下「@a.ts，然后」是高频写法，
// 以下四处统一用这套边界：@ 面板触发扫描（mentionQueryAt）、整 token 替换终点
// （mentionTokenEnd）、提取时 @ 的左边界（extractMentionTokens）、中段截断候选
// （stripMentionCandidates）。
// 注意：提取出的 token 仍是原始空白分隔段（其中的标点原样保留）——
// 「整 token 先查、截断只作回退」的纪律在 store.resolveMentionPath，
// 文件名真带逗号（report，final.txt）时整 token 命中优先，不被截断冤枉。
const BOUNDARY_CHARS = [...TRAILING_STRIP].filter((c) => c !== ".");
const BOUNDARY_RE = new RegExp(
  `[\\s${BOUNDARY_CHARS.map((c) => c.replace(/[\\\]^\-]/g, "\\$&")).join("")}]`,
);
// matchAll 内部会克隆正则，模块级共享是安全的。
const MENTION_RE = new RegExp(`(?:^|${BOUNDARY_RE.source})@([^\\s]+)`, "g");

/** 与发送时同一套 @ 边界，用于把可见的引用画成行内标签。 */
export function mentionSegments(text: string): { text: string; mention: boolean }[] {
  const segments: { text: string; mention: boolean }[] = [];
  let end = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const raw = match[0];
    const marker = raw.indexOf("@");
    const start = (match.index ?? 0) + marker;
    // 标签止于第一个句读标点并剥掉尾部标点（「@a.ts，然后」只画 @a.ts）；真带标点的文件名只是显示被截短，解析不受影响。
    let tag = raw.slice(marker);
    const cut = tag.slice(1).search(BOUNDARY_RE);
    if (cut >= 0) tag = tag.slice(0, cut + 1);
    while (tag.length > 1 && TRAILING_STRIP.has(tag.charAt(tag.length - 1))) tag = tag.slice(0, -1);
    if (tag.length === 1) continue;
    if (start > end) segments.push({ text: text.slice(end, start), mention: false });
    segments.push({ text: tag, mention: true });
    end = start + tag.length;
  }
  if (end < text.length) segments.push({ text: text.slice(end), mention: false });
  return segments;
}

/** 从整段文本提取去重后的引用路径（不含 @），保持出现顺序。 */
export function extractMentionTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const path = match[1];
    // 目录引用保留在文本中交给 agent 按需读取，不作为普通文件附件解析。
    if (path === undefined || path.endsWith("/") || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 光标落在「@ 开头」的 token 内或末尾时返回触发信息（start 为 token 起点，query 为 @ 后到光标的部分）。
 * 句中触发：只要求 token 以 @ 开头，不要求行首。
 * token 边界是空白或句读标点：「@a.ts，然后」光标在「然后」里时不触发（面板及时关闭）。
 */
export function mentionQueryAt(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !BOUNDARY_RE.test(text.charAt(start - 1))) start--;
  const token = text.slice(start, cursor);
  if (!token.startsWith("@")) return null;
  return { start, query: token.slice(1) };
}

/** 当前 token 的终点（从 cursor 向后扫到下一个空白或句读标点），用于选中后整 token 替换。 */
export function mentionTokenEnd(text: string, cursor: number): number {
  let end = cursor;
  while (end < text.length && !BOUNDARY_RE.test(text.charAt(end))) end++;
  return end;
}

/**
 * 给定 token 产出剥离候选列表（长的在前，不含原 token）：
 * 先逐级剥掉尾部标点；尾部无可剥但中段有句读标点时（「a.ts，然后」以「后」结尾），
 * 再在第一个边界标点处截断补一个候选。
 * 上层只在整 token 查无此文件时按序查询，命中真实文件才采纳——
 * 「整 token 优先、截断只是回退」，文件名真带逗号时整 token 命中不冤枉；
 * 无尾部标点且无中段边界（或会剥成空串）时返回空列表——不产生剥离需求。
 */
export function stripMentionCandidates(token: string): string[] {
  const out: string[] = [];
  let current = token;
  while (current.length > 0 && TRAILING_STRIP.has(current.charAt(current.length - 1))) {
    current = current.slice(0, -1);
    if (current.length > 0) out.push(current);
  }
  // 中段截断：尾部剥完仍含边界标点时，截到第一个边界处（尾部剥离候选更长，已排在前）
  for (let i = 0; i < current.length; i++) {
    if (BOUNDARY_RE.test(current.charAt(i))) {
      const prefix = current.slice(0, i);
      if (prefix.length > 0 && prefix !== token && !out.includes(prefix)) out.push(prefix);
      break;
    }
  }
  return out;
}
