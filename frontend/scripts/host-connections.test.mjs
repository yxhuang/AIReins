import assert from 'node:assert/strict';
import {
  normalizeRemoteOrigin, normalizeLocalOrigin, connectionLabel, workbenchWindowTitle,
  connectionsForPage, hostNavigationUrl, parseHostTransfer, normalizeConnections,
  initializeHostConnections, getHostConnections, saveHostConnections, subscribeHostConnections, HOST_CONNECTIONS_KEY,
  connectionsWithRemote, resolveRemoteHostInput,
} from '../src/host-connections.ts';

const local = 'http://127.0.0.1:8790';
const home = 'https://my-desktop.tailxxxx.ts.net';
const other = 'https://other-pc.tailxxxx.ts.net';
assert.equal(normalizeRemoteOrigin(`${home}/`), home);
const laptop = 'https://my-laptop.tailxxxx.ts.net';
const discoveredLaptop = { name: 'my-laptop', origin: laptop, online: true, os: 'windows',
  ips: ['100.64.0.49', 'fd7a:115c:a1e0::0000:0031'] };
const discovery = { peers: [discoveredLaptop] };
assert.equal(resolveRemoteHostInput(laptop), laptop, '完整 origin 无需接口');
for (const bare of ['my-laptop.tailxxxx.ts.net', 'my-laptop.tailxxxx.ts.net/', 'my-laptop.tailxxxx.ts.net.']) {
  assert.equal(resolveRemoteHostInput(bare), laptop, '裸 MagicDNS 无需接口');
}
assert.equal(resolveRemoteHostInput('100.64.0.49'), null, 'IP 需要发现结果');
for (const input of ['100.64.0.49', 'fd7a:115c:a1e0::0000:0031', 'FD7A:115C:A1E0::0000:0031',
  'fd7a:115c:a1e0:0000:0000:0000:0000:0031', 'my-laptop', 'my-laptop', ' my-laptop ']) {
  assert.equal(resolveRemoteHostInput(input, discovery), laptop, input);
}
assert.equal(resolveRemoteHostInput('my-laptop', { peers: [{ ...discoveredLaptop, name: 'Windows laptop' }] }), laptop, '匹配 MagicDNS 首段');
assert.equal(resolveRemoteHostInput('Windows Laptop', { peers: [{ ...discoveredLaptop, name: 'Windows laptop' }] }), laptop, '匹配 name，大小写不敏感');
assert.throws(() => resolveRemoteHostInput('100.64.1.99', discovery), /找不到 100\.64\.1\.99 对应的电脑/);
assert.throws(() => resolveRemoteHostInput('unknown', { peers: [], reason: 'Tailscale 未运行' }), /找不到 unknown.*Tailscale 未运行/);
assert.throws(() => resolveRemoteHostInput('my-laptop', { peers: [discoveredLaptop,
  { ...discoveredLaptop, origin: other, online: false }] }), /多个.*请使用 Tailscale IP 或完整地址/, '同名时拒绝歧义，在线不覆盖离线');
assert.equal(resolveRemoteHostInput('my-laptop', { peers: [discoveredLaptop, discoveredLaptop] }), laptop, '重复 origin 只算一台');
assert.throws(() => resolveRemoteHostInput('my-laptop', { peers: [{ ...discoveredLaptop, origin: 'https://evil.test' }] }), /找不到/, '发现地址仍必须通过原校验');
for (const bad of [`${laptop}/path`, `${laptop}?secret=x`, 'http://my-laptop.tailxxxx.ts.net', 'https://evil.test']) {
  assert.throws(() => resolveRemoteHostInput(bad), /完整的 HTTPS Tailscale 地址/, bad);
}
assert.throws(() => resolveRemoteHostInput('   '), /请输入/);
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
assert.deepEqual(connectionsWithRemote(initial, other).remotes, [home, other], '一键添加保留已保存主机');
assert.deepEqual(connectionsWithRemote(initial, home), initial, '重复发现项不会重复添加');
assert.throws(() => connectionsWithRemote(initial, 'https://evil.test'), /Tailscale/);
assert.throws(() => connectionsWithRemote({ ...initial, remotes: fullHosts }, other), /最多保存 16/);
assert.equal(connectionsWithRemote({ ...initial, remotes: fullHosts }, fullHosts[0]).remotes.length, 16, '满额时已有主机仍可切换');
const discoveredHop = hostNavigationUrl(other, connectionsWithRemote(initial, other));
assert.deepEqual(parseHostTransfer(discoveredHop).remotes, [home, other], '发现项保存后的上下文传到目标');
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
const { fetchTailscalePeers } = await import('../src/api.ts');
const originalFetch = globalThis.fetch;
try {
  let requests = 0;
  const peers = [{ name: 'other-pc', origin: other, online: false, os: 'windows', ips: ['100.64.1.2'] }];
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, '/api/tailscale/peers');
    assert.ok(init.signal, '发现接口沿用 API 超时保护');
    return { json: async () => ({ code: 0, msg: 'success', data: { peers }, request_id: 'fixture' }) };
  };
  assert.deepEqual(await fetchTailscalePeers(), { peers });
  assert.equal(requests, 1, 'API 调用不自动重试');
  globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { peers: [], reason: '未检测到 Tailscale' } }) });
  assert.deepEqual(await fetchTailscalePeers(), { peers: [], reason: '未检测到 Tailscale' });
} finally { globalThis.fetch = originalFetch; }
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
const hostSettings = renderToStaticMarkup(React.createElement(HostConnectionSettings));
assert.ok(hostSettings.includes('Tailscale 地址'));
assert.match(hostSettings, /type="text"/, 'IP 和机器名不被浏览器 URL 表单校验拦截');
assert.ok(hostSettings.includes('Tailscale IP'), '两个共用入口提示支持 IP 与机器名');
console.log('PASS: 主机地址与 IP/IPv6/机器名补全、裸 MagicDNS、无匹配及歧义、连接往返与存储保护');
