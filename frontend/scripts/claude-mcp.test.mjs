import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
const { store } = await import('../src/store.ts');
const { Composer } = await import('../src/components/SessionView.tsx');
const { InfoDialog } = await import('../src/components/SlashMenu.tsx');
const { withSideCommands } = await import('../src/commands.ts');
assert.equal(typeof Composer, 'function', 'Composer must expose its real client command path');
const session = { id: 'fixture', agent: 'claude', cwd: '/repo', status: 'idle', processId: 123, config: {} };
store.meta = { drivers: { claude: { commands: true, mentions: true } } };
store.commands.set(session.id, [{ name: 'mcp', description: 'Manage MCP', argHint: '[reconnect|enable|disable]', source: 'claude' }]);
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previous = internals.H;
const oldFetch = globalThis.fetch;
// Use the existing hook-fixture pattern: invoke actual component handlers, with fetch as the external boundary.
function mount(Component, props, effects = false) {
  const slots = []; let cursor, tree, queue = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const dispatcher = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; render(); }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useEffect(fn, deps) { const i = cursor++; if (!same(slots[i], deps)) { slots[i] = deps; if (effects) queue.push(fn); } },
    useLayoutEffect() { cursor++; },
  };
  function render() { internals.H = dispatcher; cursor = 0; tree = Component(props); }
  render();
  return { get tree() { return tree; }, flush() { while (queue.length) queue.shift()(); } };
}
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
const find = (node, predicate) => nodes(node).find(predicate);
const key = key => ({ key, shiftKey: false, preventDefault() {}, nativeEvent: { isComposing: false } });
const settle = () => new Promise(resolve => setImmediate(resolve));
const calls = [];
let status = 'disabled'; let unsupported = false; let stale = false;
globalThis.fetch = async (url, options) => {
  const body = options?.body && JSON.parse(options.body); calls.push({ url, body });
  let data = { mcpServers: [{ name: 'fixture', status, config: { type: 'http', url: 'https://mcp.example/mcp' }, scope: 'user', source: 'user' }] };
  if (body?.action === 'toggle') { status = 'needs-auth'; data.mcpServers[0].status = status; data.actionError = 'Server status: needs-auth'; }
  if (body?.action === 'authenticate') {
    if (unsupported) data.actionError = 'Unsupported control request: mcp_authenticate';
    else data.auth = { authUrl: 'https://oauth.example/authorize?state=s', requiresUserAction: true, callbackExpected: true };
  }
  if (body?.action === 'oauth_callback') assert.equal(body.callbackUrl, 'http://localhost:123/callback?code=fixture&state=s');
  if (body?.action === 'reconnect') { status = 'connected'; data.mcpServers[0].status = status; data.mcpServers[0].tools = [{ name: 'fixture_tool' }]; }
  if (stale) data.refreshError = 'fixture status unavailable';
  return { json: async () => ({ code: 0, data }) };
};
try {
  const command = withSideCommands('claude', store.commands.get(session.id)).find(c => c.name === 'mcp');
  assert.equal(command.argHint, undefined, '/mcp completion should open the local panel immediately');
  let sent = 0; const oldSend = store.sendCommand; store.sendCommand = () => { sent++; return true; };
  try {
    for (const mode of ['completion', 'text', 'tab']) {
      store.drafts.set(session.id, mode === 'completion' || mode === 'tab' ? '/mc' : '/mcp');
      const composer = mount(Composer, { session, dead: false, errored: false });
      const textarea = () => find(composer.tree, n => n.type === 'textarea');
      textarea().props.onSelect({ currentTarget: { selectionStart: mode === 'text' ? 4 : 3 } });
      if (mode !== 'completion') textarea().props.onKeyDown(key(mode === 'tab' ? 'Tab' : 'Escape'));
      if (mode === 'tab') assert.equal(textarea().props.value, '/mcp ');
      textarea().props.onKeyDown(key('Enter'));
      assert.ok(find(composer.tree, n => n.type === InfoDialog && n.props.kind === 'mcp'), mode + ' opens the shared MCP panel');
      assert.equal(textarea().props.value, '');
    }
    assert.equal(sent, 0, '/mcp must never send a model command');
  } finally { store.sendCommand = oldSend; }
  const panel = mount(InfoDialog, { session, kind: 'mcp', onClose() {} }, true); panel.flush(); await settle();
  const row = () => { const body = find(panel.tree, n => n.type?.name === 'InfoBody'); return body.type(body.props); };
  const toggle = () => find(row(), n => n.props?.role === 'switch');
  const button = label => find(row(), n => n.type === 'button' && n.props.children === label);
  assert.equal(toggle().props['aria-checked'], false, 'CLI disabled renders as off');
  await toggle().props.onClick(); await settle();
  assert.equal(toggle().props['aria-checked'], true, 'needs-auth is enabled, awaiting authentication');
  assert.equal(button('重连').props.disabled, false);
  assert.match(renderToStaticMarkup(panel.tree), /Server status: needs-auth/);
  assert.match(renderToStaticMarkup(panel.tree), /claude mcp login/);
  await button('授权').props.onClick(); await settle();
  const link = find(row(), n => n.type === 'a' && n.props.href?.startsWith('https://oauth.example/'));
  assert.equal(link.props.rel, 'noopener noreferrer');
  const input = find(row(), n => n.type === 'input' && n.props.type === 'url');
  input.props.onChange({ target: { value: 'http://localhost:123/callback?code=fixture&state=s' } });
  await button('提交回调 URL').props.onClick(); await settle();
  await button('重连').props.onClick(); await settle();
  assert.match(renderToStaticMarkup(panel.tree), /connected/);
  // Older CLIs retain a usable fallback when they reject the native OAuth control.
  status = 'needs-auth'; unsupported = true;
  await find(panel.tree, n => n.type === 'button' && n.props.children === '刷新状态').props.onClick(); await settle();
  await button('授权').props.onClick(); await settle();
  assert.match(renderToStaticMarkup(panel.tree), /Unsupported control request/);
  assert.match(renderToStaticMarkup(panel.tree), /claude mcp login/);
  assert.equal(button('重连').props.disabled, false);
  unsupported = false;
  await button('授权').props.onClick(); await settle();
  // A local browser callback completes in the CLI without submitting the manual URL.
  status = 'connected';
  await find(panel.tree, n => n.type === 'button' && n.props.children === '刷新状态').props.onClick(); await settle();
  assert.equal(button('授权'), undefined, 'fresh connected state must remove stale OAuth instructions');
  stale = true;
  await toggle().props.onClick(); await settle();
  assert.equal(toggle().props.disabled, true, 'stale readback must lock controls until refresh');
  assert.equal(button('重连').props.disabled, true);
  assert.equal(find(panel.tree, n => n.type === 'button' && n.props.children === '刷新状态').props.disabled, false);
} finally { internals.H = previous; globalThis.fetch = oldFetch; }
console.log('✅ Claude MCP: /mcp completion/text/Tab routes, disabled/needs-auth, OAuth link/callback, reconnect and CLI fallback');
