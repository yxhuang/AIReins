import assert from 'node:assert/strict';
import {
  normalizeRemoteOrigin, normalizeLocalOrigin, connectionLabel, workbenchWindowTitle,
  connectionsForPage, hostNavigationUrl, parseHostTransfer, normalizeConnections,
  initializeHostConnections, getHostConnections, saveHostConnections, subscribeHostConnections, HOST_CONNECTIONS_KEY,
} from '../src/host-connections.ts';

const local = 'http://127.0.0.1:8790';
const home = 'https://my-desktop.tailxxxx.ts.net';
const other = 'https://other-pc.tailxxxx.ts.net';
assert.equal(normalizeRemoteOrigin(`${home}/`), home);
for (const bad of ['javascript:alert(1)', 'http://my-desktop.tailxxxx.ts.net', `${home}.evil.test`, `${home}/path`, `${home}?token=secret`, `${home}#fragment`, 'https://name:password@my-desktop.tailxxxx.ts.net', 'https://evil.test']) {
  assert.equal(normalizeRemoteOrigin(bad), null, bad);
}
assert.equal(normalizeLocalOrigin(`${local}/`), local);
assert.equal(normalizeLocalOrigin('http://localhost:5173'), 'http://localhost:5173');
for (const bad of ['https://localhost:8790', 'http://100.64.1.2:8790', 'http://127.0.0.1.evil.test:8790', `${local}/secret`, 'http://user@localhost:8790']) assert.equal(normalizeLocalOrigin(bad), null, bad);
assert.equal(connectionLabel(`${local}/#/session/a`), '本机');
assert.equal(connectionLabel(`${home}/#/session/a`), 'my-desktop');
assert.equal(workbenchWindowTitle(`${local}/`, 0), 'Workbench · 本机');
assert.equal(workbenchWindowTitle(`${home}/`, 2), '(2) 个闸门待处理 · Workbench · 远程 my-desktop');

const initial = connectionsForPage(`${local}/`, { localOrigin: null, remotes: [home, home, 'https://evil.test'] });
assert.deepEqual(initial, { localOrigin: local, remotes: [home] });
const hop = hostNavigationUrl(home, initial);
assert.equal(new URL(hop).origin, home);
assert.equal(new URL(hop).search, '', '连接上下文只放 fragment，不发给服务端');
assert.deepEqual(parseHostTransfer(hop), initial);
const remote = connectionsForPage(`${home}/`, null, parseHostTransfer(hop));
assert.equal(remote.localOrigin, local, '跨源后保留发起浏览器的本机入口');
const returned = connectionsForPage(`${local}/`, remote, parseHostTransfer(hostNavigationUrl(local, remote)));
assert.equal(returned.localOrigin, local);
assert.ok(returned.remotes.includes(home));
const namedLocal = { ...initial, localName: 'other-pc' };
assert.equal(parseHostTransfer(hostNavigationUrl(home, namedLocal)).localName, 'other-pc');
assert.equal(connectionsForPage(`${home}/`, null, namedLocal).localName, 'other-pc', '本机名字跨源后仍指来源电脑');
assert.ok(!('localName' in normalizeConnections({ localName: 'bad\u0000name' })));
assert.deepEqual(connectionsForPage(`${home}/`, null), { localOrigin: null, remotes: [home] }, '手机直接访问不产生 localhost 返回入口');
assert.equal(connectionsForPage('http://localhost:8790/', initial).localOrigin, 'http://localhost:8790', '实际本机入口覆盖旧返回地址');
assert.deepEqual(connectionsForPage(`${home}/`, { localOrigin: null, remotes: [other] }, initial).remotes, [other, home], '保留目标源已保存的其他主机');
const fullHosts = Array.from({ length: 16 }, (_, i) => `https://pc-${i}.tailxxxx.ts.net`);
assert.deepEqual(connectionsForPage(`${home}/`, { localOrigin: local, remotes: fullHosts }).remotes, fullHosts,
  '列表满额时访问新主机不能静默删除已保存地址');
assert.equal(parseHostTransfer(`${home}/#wb-connect=broken%`), null);
assert.equal(parseHostTransfer(`${home}/#wb-connect=${'x'.repeat(9000)}`), null);
const hostile = normalizeConnections({ localOrigin: 'https://evil.test', remotes: [home, 'https://evil.test'], secret: 'do not carry' });
assert.deepEqual(hostile, { localOrigin: null, remotes: [home] });
assert.ok(!hostNavigationUrl(home, hostile).includes('secret'));
assert.throws(() => hostNavigationUrl('https://evil.test', initial));
assert.throws(() => hostNavigationUrl('http://localhost:1234', initial), /本机/, '不能导航到上下文之外的 loopback 服务');
const storage = new Map(), handlers = new Set();
let replaced = '', notifications = 0;
globalThis.window = {
  location: { href: hop },
  history: { state: null, replaceState(_state, _title, url) { replaced = url; } },
  addEventListener(type, handler) { if (type === 'storage') handlers.add(handler); },
  removeEventListener(type, handler) { if (type === 'storage') handlers.delete(handler); },
};
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
initializeHostConnections();
assert.equal(replaced, `${home}/`, '启动消费 fragment，不干扰 store 的会话恢复');
assert.equal(getHostConnections().localOrigin, local);
assert.ok(storage.has(HOST_CONNECTIONS_KEY));
globalThis.localStorage.setItem(HOST_CONNECTIONS_KEY, JSON.stringify({ localOrigin: local, remotes: fullHosts }));
let importNotice = "";
globalThis.window.alert = message => { importNotice = message; };
initializeHostConnections();
assert.deepEqual(getHostConnections().remotes, fullHosts, '满额目标保留原列表，不淘汰最后一台');
assert.match(importNotice, /列表已满.*原有地址已保留/, '丢弃超额传入地址前明确告知');
saveHostConnections({ localOrigin: local, remotes: [home] });
const unsubscribeA = subscribeHostConnections(() => notifications++), unsubscribeB = subscribeHostConnections(() => notifications++);
assert.equal(handlers.size, 1);
unsubscribeA();
saveHostConnections({ localOrigin: local, remotes: [home, other] });
assert.equal(notifications, 1);
unsubscribeB();
assert.equal(handlers.size, 0, '最后一个订阅退出后移除真正注册的 handler');
globalThis.localStorage.setItem = () => { throw Error('storage unavailable'); };
assert.equal(saveHostConnections({ localOrigin: local, remotes: [home] }), false);
assert.ok(getHostConnections().remotes.includes(home), '存储不可用时保留本页状态');
globalThis.React = (await import('react')).default;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
const { renderToStaticMarkup } = await import('react-dom/server');
const { HostSwitcher, HostConnectionSettings, hostSwitchHasUnsentInput } = await import('../src/components/HostSwitcher.tsx');
const { store } = await import('../src/store.ts');
let firstMessage = '', attached = false;
globalThis.document = { querySelector(selector) {
  if (selector === '.new-form textarea') return { value: firstMessage };
  if (selector === '.composer .attach-remove') return attached ? {} : null;
  throw Error(`unexpected input selector: ${selector}`);
} };
store.currentId = null;
assert.equal(hostSwitchHasUnsentInput(), false);
firstMessage = '未发送的首条消息';
assert.equal(hostSwitchHasUnsentInput(), true, '没有会话ID时新建表单消息也触发确认');
firstMessage = '   '; attached = true;
assert.equal(hostSwitchHasUnsentInput(), true, '附件独立触发确认');
attached = false; store.currentId = 'draft-test'; store.setDraft('draft-test', '未发送输入');
assert.equal(hostSwitchHasUnsentInput(), true, '已有会话草稿仍触发确认');
store.clearDraft('draft-test'); store.currentId = null;
const brand = renderToStaticMarkup(React.createElement(HostSwitcher));
assert.match(brand, /<button[^>]*class="brand host-switch-button"/);
assert.ok(brand.includes('brand-mark') && brand.includes('brand-name'));
assert.match(brand, /class="brand-name"[^>]*>my-desktop<\/span>/);
assert.ok(!brand.includes('host-switch-chevron'));
assert.ok(brand.includes('选择主机，当前：my-desktop'));
globalThis.window.location.href = `${local}/`;
initializeHostConnections();
assert.match(renderToStaticMarkup(React.createElement(HostSwitcher)), /class="brand-name"[^>]*>本机<\/span>/);
assert.ok(renderToStaticMarkup(React.createElement(HostConnectionSettings)).includes('Tailscale 地址'));
console.log('PASS: 主机地址校验、Tailscale 名称与窗口标题、本机/远程往返、手机直连、跨源合并与不可信 fragment');
