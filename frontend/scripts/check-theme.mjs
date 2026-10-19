import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// 文件浏览弹窗与侧栏入口：使用现有深浅主题令牌，禁止闸门色与硬编码色。
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const root = css.match(/:root\s*\{([^{}]*)\}/)?.[1];
assert.ok(root, "缺少 :root 令牌");
const tokens = new Map([...root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim()]));
assert.match(root, /color-scheme:\s*light dark\s*;/);
for (const theme of ["light", "dark"]) {
  assert.match(css, new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{\\s*color-scheme:\\s*${theme}\\s*;`));
}

// 底栏已有局部尺寸变量；颜色仍必须由 :root 的主题令牌提供。
const localSizes = new Set([...css.matchAll(/(--[\w-]+)\s*:\s*(?:\d+(?:\.\d+)?(?:px|em|rem)|0)\s*;/g)].map(([, name]) => name));
assert.equal(tokens.get("--surface"), "light-dark(#FAF8F2, #2A2926)", "浅色浮层暖白，深色浮层保持 C1");
assert.equal(tokens.get("--chrome"), "light-dark(#F0EEE6, #262624)", "C1 外框保持原值");

let checked = 0;
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/\.(?:dir-[\w-]+|page-nav(?:-[\w-]+)?|page-icon|host-[\w-]+)\b/.test(selector)) continue;
  assert.doesNotMatch(body, /var\(\s*--gate(?:-[\w-]+)?\b/, `${selector.trim()} 不得使用闸门色`);
  assert.doesNotMatch(body, /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|light-dark)\(/i,
    `${selector.trim()} 必须复用颜色令牌`);
  for (const [, name] of body.matchAll(/var\(\s*(--[\w-]+)/g)) {
    assert.ok(tokens.has(name) || localSizes.has(name), `${selector.trim()} 引用了未定义令牌 ${name}`);
    if (/^--(?:text(?:-[\w-]+)?|surface(?:-[\w-]+)?|chrome(?:-[\w-]+)?|border(?:-[\w-]+)?|busy)$/.test(name)) {
      assert.match(tokens.get(name), /^light-dark\(/, `${name} 必须覆盖深浅主题`);
    }
  }
  checked++;
}
assert.ok(checked > 0, "未找到文件浏览或侧栏入口样式");
assert.match(css, /\.dir-copy-status\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*user-select:\s*text;/,
  "复制退路必须完整换行并允许手动选中");
console.log(`✅ 主题检查通过（文件浏览与侧栏入口，${checked} 条规则，深浅主题令牌与闸门色隔离）`);

// 终端标签 chrome：禁止复用暖纸/品牌/闸门色，只允许终端中性色与冷色焦点环。
let terminalRules = 0;
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/\.term-tab[\w-]*\b/.test(selector)) continue;
  for (const [, token] of body.matchAll(/var\(\s*(--[\w-]+)/g)) {
    assert.ok(["--term-bg", "--term-fg", "--busy", "--font-ui"].includes(token), `${selector.trim()} 终端 chrome 不得使用 ${token}`);
    assert.ok(tokens.has(token), `${token} 必须有主题令牌`);
  }
  assert.doesNotMatch(body, /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i, `${selector.trim()} 不得硬编码颜色`);
  terminalRules++;
}
assert.ok(terminalRules > 0);
console.log(`✅ 终端标签主题检查通过（${terminalRules} 条规则，中性色与冷色焦点环）`);
