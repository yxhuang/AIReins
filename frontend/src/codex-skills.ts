import type { CodexSkillInfo } from "./api";

/** $ completion follows the @ picker: token at the caret, independent of line start. */
export function skillQueryAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)\$([^\s$]*)$/.exec(before);
  if (!match) return null;
  const start = cursor - match[1]!.length - 1;
  const tail = /^[^\s$]*/.exec(text.slice(cursor))![0];
  return { start, end: cursor + tail.length, query: match[1]! };
}

export function filterSkills(skills: CodexSkillInfo[], query: string): CodexSkillInfo[] {
  const q = query.toLocaleLowerCase();
  return skills.filter(s => s.enabled && `${s.name}\n${s.description}`.toLocaleLowerCase().includes(q));
}

export function insertSkill(text: string, token: { start: number; end: number }, name: string): { text: string; cursor: number } {
  const marker = `$${name} `;
  return { text: text.slice(0, token.start) + marker + text.slice(token.end), cursor: token.start + marker.length };
}
