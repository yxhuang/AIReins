/** Lexically normalize a project identity without filesystem access or case folding. */
export function normalizeProjectPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || ".";
}
