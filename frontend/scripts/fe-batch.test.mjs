import assert from "node:assert/strict";
import { bodyFontSize, readBodyFontSize } from "../src/body-font.ts";
import { highlightLanguage, highlightCode } from "../src/code-highlight.ts";

for (const size of [13, 13.5, 14, 14.5, 15, 15.5, 16, 19.5, 20]) assert.equal(bodyFontSize(String(size)), size);
for (const value of [null, "", "12.5", "20.5", "15.3", "22", "bad", "__proto__"]) assert.equal(bodyFontSize(value), 15);
assert.equal(readBodyFontSize(), 15);
Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
assert.equal(readBodyFontSize(), 15);
delete globalThis.localStorage;

assert.equal(highlightLanguage(undefined, "const x = 1"), null);
assert.equal(highlightLanguage("language-unknown", "x"), null);
assert.equal(highlightLanguage("language-__proto__", "x"), null);
assert.equal(highlightLanguage("language-tsx", "x"), "typescript");
assert.equal(highlightLanguage("language-js", "x\n".repeat(2000)), "javascript");
assert.equal(highlightLanguage("language-js", "x\n".repeat(2001)), null);

const cases = {
  ts: 'const x: string = "safe"; // comment',
  tsx: 'const x = <Card title="safe" />;',
  js: 'function f() { return 42; }',
  json: '{"key": true, "value": 42}',
  bash: 'if [ "$HOME" ]; then echo "ok"; fi # comment',
  sh: 'export HOME="/tmp"',
  python: 'def f():\n    return "ok" # comment',
  css: '.box { color: #fff; display: flex; }',
  html: '<div title="safe">&amp;</div>',
  diff: '@@ -1 +1 @@\n-old\n+new\n',
  yaml: 'name: "safe"\nenabled: true # comment',
  toml: '[app]\nname = "safe"\nenabled = true',
  markdown: '# Title\n\n`code` and **bold**',
  sql: 'SELECT name FROM users WHERE id = 42; -- comment',
  go: 'func f() string { return "ok" }',
  rust: 'fn main() { let x = 42; }',
};
const unescape = (s) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (x) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[x]);
for (const [name, text] of Object.entries(cases)) {
  const language = highlightLanguage(`language-${name}`, text);
  const html = await highlightCode(text, language);
  assert.match(html, /<span class="hljs-/);
  assert.equal(unescape(html.replace(/<span class="hljs-[\w-]+">|<\/span>/g, "")), text, name);
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>&"\'';
  const unsafe = await highlightCode(payload, language);
  assert.doesNotMatch(unsafe, /<(?:img|script)\b/i, name);
  assert.equal(unescape(unsafe.replace(/<span class="hljs-[\w-]+">|<\/span>/g, "")), payload, name);
}
console.log("OK 正文字号安全回退；16 种语言、2000 行边界与高亮 HTML 转义");
