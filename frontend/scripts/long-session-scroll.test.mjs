import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { MarkdownMessage } from '../src/components/MarkdownMessage.tsx';
import * as ui from '../src/session-ui.ts';
globalThis.React = React;
// Exercise the component's real hooks and throttle with a deterministic layout
// commit, without a browser dependency. The scroll fixture clamps like the DOM.
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals.H;
const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
let timer, cursor, slots = [], layouts = [], effects = [], element, props;
let sticky = true, latest = false, top = 400, height = 1000;
const viewport = { get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(value, height - 600); }, get scrollHeight() { return height; }, clientHeight: 600 };
const commit = () => { height = element.props.text.length > 1 ? 1800 : 1000; latest = ui.syncStreamViewport(viewport, sticky); };
const effect = queue => (fn, deps) => {
  const position = cursor++, old = slots[position];
  if (!old || deps.some((dep, i) => dep !== old[i])) { slots[position] = deps; queue.push(fn); }
};
const render = () => {
  cursor = 0;
  element = MarkdownMessage.type(props);
  while (layouts.length) layouts.shift()();
  while (effects.length) effects.shift()();
};
internals.H = {
  useState(initial) { const position = cursor++; if (!(position in slots)) slots[position] = initial; return [slots[position], value => { if (slots[position] !== value) { slots[position] = value; render(); } }]; },
  useRef(initial) { const position = cursor++; return slots[position] ??= { current: initial }; },
  useContext() { return commit; },
  useEffect: effect(effects), useLayoutEffect: effect(layouts),
};
globalThis.setTimeout = fn => { timer = fn; return 1; };
globalThis.clearTimeout = () => { timer = undefined; };
try {
  props = { text: 'a', streaming: true }; render();
  props = { text: 'many\nlines\n'.repeat(100), streaming: true }; render();
  assert.equal(top, 400, 'parent update still sees the old body');
  const publish = timer; timer = undefined; publish();
  assert.equal(element.props.text, props.text);
  assert.equal(top, 1200, 'actual throttled body commit must follow the new bottom');
  assert.equal(latest, false);
  sticky = false; top = 400;
  props = { text: props.text + 'more', streaming: true }; render();
  const publishAgain = timer; timer = undefined; publishAgain();
  assert.equal(top, 400, 'reading an earlier message must preserve scroll position');
  assert.equal(latest, true, 'button state must reflect the committed height');
  const view = readFileSync(new URL('../src/components/SessionView.tsx', import.meta.url), 'utf8');
  assert.match(view, /MarkdownCommitContext value={onMarkdownCommit}/);
} finally { internals.H = previousDispatcher; globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
console.log('PASS review 4: throttled commit, sticky bottom and nonsticky viewport');
