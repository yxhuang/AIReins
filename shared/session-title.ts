// 会话标题：列表字段优先，缺省时用首条 user_message 派生。
// 所有空白（含换行）压成单空格；保留完整标题，由界面按可用宽度显示省略号。
// 首条消息还没到时返回占位「新会话」。
export function sessionTitle(session: { title?: string; customTitle?: string }, events?: { type: string; payload: Record<string, unknown> }[]): string {
  if (session.customTitle?.trim()) return session.customTitle.trim();
  const firstUser = events?.find((event) => event.type === "user_message");
  const command = firstUser?.payload.command;
  const commandText = command && typeof command === "object" && "name" in command && typeof command.name === "string"
    ? `/${command.name}${"arguments" in command && typeof command.arguments === "string" ? ` ${command.arguments}` : ""}`
    : "";
  const text = firstUser ? String(firstUser.payload.text ?? commandText) : "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (session.title !== undefined) {
    // 旧服务端会把自动标题截到显示宽度 30；已有首条消息时可安全补全。
    // 只补全完全匹配旧截断规则的标题，保持其他列表字段的优先级。
    return flat && session.title === truncateDisplayWidth(flat, 30) ? flat : session.title;
  }
  if (!flat) return "新会话";
  return flat;
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
