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
  { file: 'dispatch-flow.ts', text: '/^工单[:：]\\s*/', reason: 'Recognizes a dispatch heading in input data; it is not displayed copy.' },
  { file: 'snapshot.ts', text: '`快照预检失败（${error instanceof Error ? error.message : String(error)}），跳过快照检查直接建会话`', reason: 'Diagnostic callback sent to console.warn; logs stay in their original language.' },
];
// A count placeholder followed by one of these nouns must use {p, plural, one {…} other {…}} (see TERMS.md).
const countableNouns = ['file', 'time', 'minute', 'line', 'location', 'item', 'gate', 'approval', 'host', 'error',
  'message', 'task', 'byte', 'dispatch', 'tree', 'session', 'second', 'tool', 'character', 'reference', 'event', 'entry', 'type'];
const nounForms = new Set(countableNouns.flatMap(noun => [noun, `${noun}s`]));
// p0 of core.026 is a dispatcher label, not a count.
const pluralExceptions = [{ key: 'core.026', reason: 'p0 is a dispatcher name, not a count.' }];
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
    // Placeholders: bare {name} plus {name, plural, …} blocks (a block's one/other texts contain no braces).
    const names = text => {
      const blockNames = [...text.matchAll(/\{(\w+),\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g)].map(match => match[1]);
      const bare = text.replace(/\{\w+,\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g, '');
      return [...new Set([...blockNames, ...[...bare.matchAll(/\{(\w+)\}/g)].map(match => match[1])].filter(name => name !== 'product'))].sort();
    };
    assert.deepEqual(names(zh[key]), names(en[key]), `${key}: placeholders differ`);
    assert.ok(!han.test(en[key]), `${key}: English translation contains Chinese`);
    // Well-formed plural blocks: every "plural" marker must parse as a full {name, plural, one {…} other {…}}.
    for (const [locale, value] of [['zh-CN', zh[key]], ['en', en[key]]]) {
      const blocks = value.match(/\{\w+,\s*plural,/g)?.length ?? 0;
      assert.equal(value.match(/\{\w+,\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g)?.length ?? 0, blocks,
        `${key}: malformed plural block in ${locale}`);
    }
    // English: a count placeholder directly followed by a countable noun needs the plural syntax.
    const stripped = en[key].replace(/\{\w+,\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g, '');
    for (const match of stripped.matchAll(/\{p\d+\}\s+([A-Za-z][A-Za-z-]*)/g)) {
      if (!nounForms.has(match[1].toLowerCase())) continue;
      assert.ok(pluralExceptions.some(item => item.key === key),
        `${key}: "${match[0]}" puts a countable noun after a count placeholder; use {pN, plural, one {# …} other {# …s}} or register a pluralExceptions entry`);
    }
  }
  keys += Object.keys(zh).length;
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`I18n check OK: ${checked} source files, ${keys} keys, ${exceptions.length + 1} registered exceptions`);
