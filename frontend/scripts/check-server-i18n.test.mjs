import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkServerI18n, chineseSourceSites } from './check-server-i18n.mjs';

// Literal extraction: plain strings, template placeholders and regexes; comments are ignored.
const sites = chineseSourceSites('server/demo.ts', [
  '// 注释里的中文不登记',
  'throw new Error(`缺少 ${name} 配置`);',
  "const label = '会话列表';",
  'const pattern = /标题[:：]/;',
].join('\n'));
assert.deepEqual(sites.map(site => site.text), ['缺少 {p0} 配置', '会话列表', '/标题[:：]/']);
assert.deepEqual(sites.map(site => site.line), [2, 3, 4]);

const source = "throw new Error('拒绝访问');\nconsole.warn('内部诊断');\n";
const sources = new Map([['server/demo.ts', source]]);
const dictionary = { 'server.messageX': '拒绝访问' };
const hash = createHash('sha256').update('内部诊断').digest('hex');
const base = { sources: [{ file: 'server/demo.ts', line: 1, key: 'server.messageX' }], excluded: [{ file: 'server/demo.ts', line: 2, text: '(诊断摘要)', sha256: hash, reason: '仅日志' }] };
const ok = checkServerI18n({ sources, coverage: base, dictionary });
assert.deepEqual(ok.failures, []);
assert.equal(ok.sourceSites, 2);

// New unregistered Chinese copy fails the guard.
const unregistered = checkServerI18n({ sources, coverage: { sources: base.sources, excluded: [] }, dictionary });
assert.equal(unregistered.failures.length, 1);
assert.match(unregistered.failures[0], /server\/demo\.ts:2: unregistered Chinese literal/);

// Registered line drifting away from the literal reports the current line.
const drifted = checkServerI18n({ sources, coverage: { sources: [{ file: 'server/demo.ts', line: 9, key: 'server.messageX' }], excluded: base.excluded }, dictionary });
assert.equal(drifted.failures.length, 1);
assert.match(drifted.failures[0], /location drift; current line 1/);

// A registered template removed from the source asks to update the entry.
const removed = checkServerI18n({ sources: new Map([['server/demo.ts', "console.warn('trace');\nconsole.warn('内部诊断');\n"]]), coverage: base, dictionary });
assert.equal(removed.failures.length, 1);
assert.match(removed.failures[0], /no longer exists in source/);

// An exclusion without a reason is rejected, and both literals stay unregistered.
const reasonless = checkServerI18n({ sources, coverage: { sources: [], excluded: [{ file: 'server/demo.ts', line: 2, text: '内部诊断' }] }, dictionary });
assert.equal(reasonless.failures.length, 3);
assert.match(reasonless.failures[0], /missing template or exception reason/);

console.log('Server i18n coverage guard tests OK: extraction, registration, drift, removal and reasons');
