import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dictionaries, getLocale, interpolate, languagePreference, localizeServerData, readLanguagePreference, resolveLocale, setLanguagePreference, t, formatNumber, formatDate, formatRelativeTime } from '../src/i18n.ts';

assert.equal(resolveLocale('system', 'zh-HK'), 'zh-CN');
assert.equal(resolveLocale('system', 'ZH-TW'), 'zh-CN');
assert.equal(resolveLocale('system', 'fr-FR'), 'en');
assert.equal(resolveLocale('en', 'zh-CN'), 'en');
assert.equal(languagePreference('invalid'), 'system');
assert.equal(readLanguagePreference(), 'system');
const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
setLanguagePreference('en');
assert.equal(getLocale(), 'en');
assert.equal(readLanguagePreference(), 'en');
assert.equal(interpolate('{name} {name} {missing}', { name: '$&' }), '$& $& {missing}');
assert.equal(interpolate('{count}', { count: 1200 }), '1,200');
assert.equal(interpolate('{product}'), 'Workbench');
// Plural blocks: {name, plural, one {…#…} other {…#…}} with Intl.PluralRules.
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: 1 }), '1 file');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: 0 }), '0 files');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: 2 }), '2 files');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: 1200 }), '1,200 files');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: '3' }), '3 files');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}', { n: 'many' }), '{n, plural, one {# file} other {# files}}');
assert.equal(interpolate('{n, plural, one {# file} other {# files}}'), '{n, plural, one {# file} other {# files}}');
assert.equal(t('core.115', { p0: 1 }), '1 file');
assert.equal(t('core.115', { p0: 5 }), '5 files');
assert.equal(t('missing.key'), 'missing.key');
dictionaries['zh-CN']['test.fallback'] = 'Fallback';
assert.equal(t('test.fallback'), 'Fallback');
delete dictionaries['zh-CN']['test.fallback'];
assert.equal(formatNumber(1200), '1,200');
assert.equal(formatRelativeTime(-1, 'minute'), '1 minute ago');
assert.match(formatDate('2026-10-12T00:00:00Z', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }), /Oct/);
const messageKey = Object.keys(dictionaries.en).find(key => key.startsWith('server.') && !dictionaries.en[key].includes('{'));
assert.ok(messageKey);
const source = { message: dictionaries['zh-CN'][messageKey], text: '用户原文', i18n: { message: { key: messageKey } }, protocolLimitations: ['old'], nested: { reason: 'old', i18n: { reason: { key: messageKey } } } };
const localized = localizeServerData(source);
assert.equal(localized.message, dictionaries.en[messageKey]);
assert.equal(localized.text, '用户原文');
assert.equal(localized.nested.reason, dictionaries.en[messageKey]);
assert.equal(source.message, dictionaries['zh-CN'][messageKey]);
assert.equal(localizeServerData({ msg: 'old', i18n: { msg: { key: 'unknown.server.key' } } }).msg, 'old');
assert.deepEqual(localizeServerData({ labels: ['old'], i18n: { labels: [{ key: messageKey }] } }).labels, [dictionaries.en[messageKey]]);
assert.deepEqual(localizeServerData({ text: '模型回答', content: '用户输入' }), { text: '模型回答', content: '用户输入' });

// The REST ingress translates metadata before callers see errors and keeps request IDs.
const originalFetch = globalThis.fetch;
try {
  const { fetchMeta, workFileContentUrl } = await import('../src/api.ts');
  globalThis.fetch = async () => ({ json: async () => ({ code: 40401, msg: dictionaries['zh-CN'][messageKey], request_id: 'request-1', i18n: { msg: { key: messageKey } } }) });
  await assert.rejects(fetchMeta(), error => error.message === dictionaries.en[messageKey] && error.cause === 'request-1');
  assert.equal(new URL(workFileContentUrl({ path: '/file.pdf', root: '/' }), 'http://localhost').searchParams.get('lang'), 'en');
} finally { globalThis.fetch = originalFetch; }

// Import after selecting English so module-level labels use the same locale as startup.
globalThis.React = React;
globalThis.window = { location: { hash: '#/', href: 'http://127.0.0.1:18000/' }, innerWidth: 1280 };
const { store } = await import('../src/store.ts');
const { DirectoryBrowser } = await import('../src/components/DirectoryBrowser.tsx');
const { App } = await import('../src/App.tsx');
store.meta = { platform: 'linux', drivers: {}, capabilities: { terminal: false, windowsPaths: false } };
for (const html of [
  renderToStaticMarkup(React.createElement(DirectoryBrowser, { initialPath: '', onSelect() {}, onClose() {} })),
  renderToStaticMarkup(React.createElement(App)),
]) assert.doesNotMatch(html, /\p{Script=Han}/u);
const { workbenchWindowTitle } = await import('../src/host-connections.ts');
const title = workbenchWindowTitle('http://127.0.0.1:18000/', 2);
assert.equal(title, '(2) pending approvals · Workbench · Local');
assert.equal(workbenchWindowTitle('http://127.0.0.1:18000/', 1), '(1) pending approval · Workbench · Local');
assert.equal(workbenchWindowTitle('http://127.0.0.1:18000/', 0), 'Workbench · Local');
assert.equal(workbenchWindowTitle('https://alice-desktop.tail123.ts.net/', 0), 'Workbench · Remote alice-desktop');
assert.equal(workbenchWindowTitle('https://alice-desktop.tail123.ts.net/', 1), '(1) pending approval · Workbench · Remote alice-desktop');
setLanguagePreference('zh-CN');
assert.equal(workbenchWindowTitle('http://127.0.0.1:18000/', 2), title);
assert.equal(readLanguagePreference(), 'zh-CN');
assert.equal(getLocale(), 'en', 'Selection applies on reload, so canceled navigation cannot mix module-level labels');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Unavailable'); } });
assert.equal(readLanguagePreference(), 'system');
assert.equal(setLanguagePreference('en'), false);
assert.equal(getLocale(), 'en');
console.log('I18n tests OK: preference, interpolation, fallback, formats, server metadata and English views');
