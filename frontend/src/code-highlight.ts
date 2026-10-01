const LANGUAGES: Record<string, string> = {
  js: "javascript", javascript: "javascript", jsx: "javascript",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  json: "json", bash: "bash", sh: "bash", shell: "bash",
  python: "python", py: "python", css: "css", html: "xml", xml: "xml",
  diff: "diff", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  markdown: "markdown", md: "markdown", sql: "sql", go: "go", rust: "rust", rs: "rust",
};

export function highlightLanguage(className: string | undefined, text: string): string | null {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase();
  if (!language || !Object.hasOwn(LANGUAGES, language)) return null;
  // Markdown 的代码文本通常有一个末尾换行，它不算额外一行。
  if (text.replace(/\n$/, "").split("\n").length > 2000) return null;
  return LANGUAGES[language] ?? null;
}

let loader: Promise<typeof import("./highlight-languages")> | undefined;
export function highlightCode(text: string, language: string): Promise<string> {
  loader ??= import("./highlight-languages");
  return loader.then((module) => module.highlight(text, language));
}
