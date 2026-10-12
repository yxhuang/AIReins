import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { parseSync } from 'rolldown/experimental';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const han = /\p{Script=Han}/u;
// Exact source literals only. These are compatibility/data/logging boundaries, not untranslated UI.
export const exceptions = [
  { file: 'components/TerminalPanel.tsx', text: '"M汉\\uE0B0"', reason: 'Hidden font calibration probe must include a CJK glyph and a powerline glyph.' },
  { file: 'host-connections.ts', text: '`(${pending}) 个闸门待处理 · `', reason: 'Window title must keep matching the Windows tray contract in both languages.' },
  { file: 'host-connections.ts', text: '"本机"', reason: 'Fixed local identity inside workbenchWindowTitle; tray contract.' },
  { file: 'host-connections.ts', text: '`远程 ${label}`', reason: 'Fixed remote identity inside workbenchWindowTitle; tray contract.' },
  { file: 'dispatch-flow.ts', text: '/^工单[:：]\\s*/', reason: 'Recognizes a dispatch heading in input data; it is not displayed copy.' },
  { file: 'snapshot.ts', text: '`快照预检失败（${error instanceof Error ? error.message : String(error)}），跳过快照检查直接建会话`', reason: 'Diagnostic callback sent to console.warn; logs stay in their original language.' },
];
// Archived Chromium template: not in the production import graph. Its exact hash is registered so new copy cannot hide in vendor.
import { createHash } from 'node:crypto';
const vendorHash = "643d8b00614aba4d7f715340061f5d5e9f647ae7ce626f9c4ea5051ac7f94196";
let checked = 0;
const failures = [];
function inspect(file) {
  const source = readFileSync(file, 'utf8');
  const name = relative(root, file).replaceAll('\\', '/');
  const { program, errors } = parseSync(name, source, { lang: name.endsWith('.tsx') ? 'tsx' : 'ts' });
  assert.equal(errors.length, 0, `${name}: ${JSON.stringify(errors)}`);
  function walk(node, diagnostic = false) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && node.callee.object?.name === 'console') diagnostic = true;
    const isLiteral = node.type === 'Literal' || node.type === 'TemplateLiteral' || node.type === 'JSXText';
    const raw = source.slice(node.start, node.end);
    const decoded = node.type === 'Literal' && typeof node.value === 'string' ? node.value
      : node.type === 'JSXText' ? node.value
      : node.type === 'TemplateLiteral' ? node.quasis.map(part => part.value.cooked ?? part.value.raw).join('') : raw;
    if (isLiteral && (han.test(raw) || han.test(decoded))) {
      if (diagnostic || exceptions.some(item => item.file === name && item.text === raw)) return;
      if (name === 'vendor/chromium-directory.ts' && node.type === 'TemplateLiteral'
        && createHash('sha256').update(raw).digest('hex') === vendorHash) return;
      if (node.type !== 'TemplateLiteral' || han.test(decoded)) {
        failures.push(`${name}:${source.slice(0, node.start).split('\n').length}: ${raw.slice(0, 100)}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'comments') continue;
      if (Array.isArray(value)) value.forEach(item => walk(item, diagnostic));
      else if (value && typeof value === 'object') walk(value, diagnostic);
    }
  }
  walk(program); checked++;
}
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { if (file !== join(root, 'i18n')) visit(file); }
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) inspect(file);
    else if (/\.(css|html)$/.test(entry.name)) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, '');
      if (han.test(source)) failures.push(`${relative(root, file)}: Chinese text outside a dictionary`);
    }
  }
}
visit(root);
let keys = 0;
const merged = new Set();
for (const group of ['core', 'ui', 'server']) {
  const zh = (await import(`../src/i18n/${group}.zh-CN.ts`)).default;
  const en = (await import(`../src/i18n/${group}.en.ts`)).default;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), `${group}: dictionary keys differ`);
  for (const key of Object.keys(zh)) {
    assert.ok(!merged.has(key), `Duplicate dictionary key: ${key}`); merged.add(key);
    for (const [locale, dictionary] of [['zh-CN', zh], ['en', en]]) assert.ok(typeof dictionary[key] === 'string' && dictionary[key].trim(), `${locale}: empty translation ${key}`);
    assert.deepEqual([...zh[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).filter(name => name !== "product").sort(), [...en[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).filter(name => name !== "product").sort(), `${key}: placeholders differ`);
    assert.ok(!han.test(en[key]), `${key}: English translation contains Chinese`);
  }
  keys += Object.keys(zh).length;
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`I18n check OK: ${checked} source files, ${keys} keys, ${exceptions.length + 1} registered exceptions`);
