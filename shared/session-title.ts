// 会话标题：列表字段优先，缺省时用首条 user_message 派生。
// 所有空白（含换行）压成单空格后按显示宽度截断（CJK/全角计 2，其余计 1，上限 30，超出加 …）；
// 首条消息还没到时返回占位「新会话」。
export function sessionTitle(session: { title?: string }, events: { type: string; payload: Record<string, unknown> }[] | undefined): string {
  if (session.title !== undefined) return session.title;
  const firstUser = events?.find((event) => event.type === "user_message");
  const text = firstUser ? String(firstUser.payload.text ?? "") : "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  return truncateDisplayWidth(flat, 30);
}

// 按显示宽度截断：CJK/全角字符计 2，其余计 1；超出上限时截断并追加 …。
export function truncateDisplayWidth(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charDisplayWidth(ch);
    if (width + w > maxWidth) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

// 宽字符区间：CJK 统一表意、假名、谚文、全角形式等（足够覆盖标题场景的近似判定）。
const WIDE_CHAR = /[ᄀ-ᅟ⺀-鿿ꥠ-꥿가-ퟻ豈-﫿︰-﹏＀-｠￠-￦𠀀-𫿿]/u;

function charDisplayWidth(ch: string): number {
  return WIDE_CHAR.test(ch) ? 2 : 1;
}

