import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownMessage } from '../src/components/MarkdownMessage.tsx';
import { HistoryTimeline } from '../src/components/HistoryTimeline.tsx';
import { STREAMING_MARKDOWN_PLAIN_TEXT_THRESHOLD as threshold } from '../src/streaming-text.ts';

globalThis.React = React;
const render = (text, streaming) => renderToStaticMarkup(React.createElement(MarkdownMessage, { text, streaming }));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

assert.match(render('**short**', true), /<strong>short<\/strong>/);
assert.doesNotMatch(render('x'.repeat(threshold - 1), true), /markdown-streaming-plain/);
assert.match(render('x'.repeat(threshold), true), /markdown-streaming-plain/);

// A fence crossing the long-message boundary, GFM table, reference link and HTML
// must survive as exact escaped text during streaming and parse together at stop.
const source = `# Heading\n\n\`\`\`txt\n${'literal **code** <tag> & data\n'.repeat(1800)}\`\`\`\n\n| A | B |\n| --- | --- |\n| one | two |\n\n[reference][target]\n\n[target]: https://example.com\n\n<script>alert(1)</script>\n\n**final**`;
const plain = render(source, true);
assert.equal(plain, `<div class="markdown-message markdown-streaming-plain">${escape(source)}</div>`, 'long stream contains the whole literal source, without Markdown parsing or raw HTML');
const complete = render(source, false);
assert.doesNotMatch(complete, /markdown-streaming-plain|<script\b/);
assert.match(complete, /<table>/);
assert.match(complete, /href="https:\/\/example.com"/);
assert.match(complete, /<strong>final<\/strong>/);
assert.equal((complete.match(/literal \*\*code\*\* &lt;tag&gt; &amp; data/g) ?? []).length, 1800, 'completed code fence preserves every line across the threshold');

// Mode-only commits change height too: ending a stream without one more token
// must still notify SessionView, including when its text throttle is pending.
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals.H;
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
let cursor = 0, slots = [], effects = [], layouts = [], commits = 0;
const effect = queue => (fn, deps) => {
  const position = cursor++, old = slots[position];
  if (!old || deps.some((value, index) => value !== old[index])) { slots[position] = deps; queue.push(fn); }
};
const commit = () => commits++;
internals.H = {
  useContext() { return commit; },
  useState(initial) { const position = cursor++; if (!(position in slots)) slots[position] = initial; return [slots[position], value => { slots[position] = value; }]; },
  useRef(initial) { const position = cursor++; return slots[position] ??= { current: initial }; },
  useEffect: effect(effects), useLayoutEffect: effect(layouts),
};
let pending;
globalThis.setTimeout = fn => { pending = fn; return 1; };
globalThis.clearTimeout = () => { pending = undefined; };
const update = props => {
  cursor = 0;
  const tree = MarkdownMessage.type(props);
  while (layouts.length) layouts.shift()();
  while (effects.length) effects.shift()();
  return tree;
};
try {
  assert.equal(update({ text: source, streaming: true }).props.children, source);
  assert.equal(commits, 1);
  assert.equal(update({ text: source, streaming: false }).props.text, source);
  assert.equal(commits, 2, 'plain-to-Markdown mode switch triggers layout synchronization');
  assert.equal(pending, undefined, 'stop cancels queued stream updates');
  update({ text: source, streaming: true });
  const finalText = source + '\n\n**last token**';
  assert.equal(update({ text: finalText, streaming: true }).props.children, source, 'pending updates remain throttled in plain text mode');
  assert.equal(typeof pending, 'function');
  assert.equal(update({ text: finalText, streaming: false }).props.text, finalText, 'stop renders the exact final body before the pending timer publishes');
  assert.equal(pending, undefined);
} finally {
  internals.H = previousDispatcher;
  globalThis.setTimeout = originalSet;
  globalThis.clearTimeout = originalClear;
}

const messages = Array.from({ length: 600 }, (_, index) => ({ role: 'assistant', text: `**retained-${index}**`, timestamp: null }));
const history = renderToStaticMarkup(React.createElement(HistoryTimeline, { messages, agent: 'codex', cwd: '/repo' }));
assert.equal((history.match(/<strong>retained-\d+<\/strong>/g) ?? []).length, 600, 'offscreen optimization retains all loaded history text in the DOM');
assert.equal((history.match(/timeline-deferred-text/g) ?? []).length, 600);
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
assert.match(css, /\.timeline-deferred-text > \.text-block\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:\s*auto 120px;/, 'only message bodies, not timeline connectors or gates, defer offscreen layout');
console.log('PASS long Markdown: escaped streaming source, full final parse, stop layout commit and retained history DOM');
