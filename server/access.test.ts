import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccess, corsOrigin, loadRemoteConfig, localPolicy, remotePolicy, sameTailnetPeerOrigin } from "./access.js";
import { PeerOriginCache } from "./peer-origins.js";

// ── 本机入口 ──
const local = localPolicy(8790);
const self = { host: "127.0.0.1:8790" };
assert.equal(checkAccess(local, "GET", self, false), null);
assert.equal(checkAccess(local, "GET", { host: "LOCALHOST:8790" }, false), null, "Host 不区分大小写");
assert.match(checkAccess(local, "GET", { host: "evil.example:8790" }, false) ?? "", /Host/, "DNS 重绑定");
assert.match(checkAccess(local, "GET", {}, false) ?? "", /Host/, "没有 Host");
assert.equal(checkAccess(local, "GET", { ...self, origin: "https://evil.example" }, false), null, "跨站 GET 读不到响应，放行");
assert.match(checkAccess(local, "POST", { ...self, origin: "https://evil.example" }, false) ?? "", /Origin/, "跨站伪造");
assert.match(checkAccess(local, "DELETE", { ...self, origin: "null" }, false) ?? "", /Origin/, "沙箱 iframe 的 Origin: null");
assert.equal(checkAccess(local, "POST", { ...self, origin: "http://127.0.0.1:8790" }, false), null, "自家页面");
assert.equal(checkAccess(local, "POST", { host: "localhost:8790", origin: "http://localhost:8790" }, false), null, "localhost 写法");
assert.equal(checkAccess(local, "POST", self, false), null, "curl / 脚本不带 Origin");
assert.equal(checkAccess(local, "POST", { ...self, origin: "http://localhost:5173" }, false), null, "Vite /api 代理：Host 被改写，Origin 是 5173");
assert.equal(checkAccess(local, "GET", { host: "localhost:5173", origin: "http://localhost:5173" }, true), null, "Vite /ws 代理：Host 不改写");
assert.match(checkAccess(local, "GET", { ...self, origin: "https://evil.example" }, true) ?? "", /Origin/, "跨站 WS 劫持");
assert.equal(checkAccess(local, "GET", self, true), null, "脚本的 WS 不带 Origin");
assert.match(checkAccess(localPolicy(18790), "GET", self, false) ?? "", /Host/, "端口跟随 WORKBENCH_PORT");

// ── 远程入口 ──
const origin = "https://desk.tail1234.ts.net";
const remote = remotePolicy({ port: 8792, origin, allowedLogins: ["me@github"] });
const via = { host: "desk.tail1234.ts.net" }; // 经 Serve 转发，Host 保持 ts.net 域名
const me = { ...via, "tailscale-user-login": "me@github" };
assert.match(checkAccess(remote, "GET", via, false) ?? "", /Tailscale 身份/, "没有身份头");
assert.match(checkAccess(remote, "GET", { ...via, "tailscale-user-login": "other@github" }, false) ?? "", /other@github/, "不在白名单，提示里带登录名");
assert.equal(checkAccess(remote, "GET", me, false), null);
assert.equal(checkAccess(remote, "GET", { ...me, host: "127.0.0.1:8792" }, false), null, "Serve 把 Host 改写成后端地址时也认");
assert.match(checkAccess(remote, "GET", { ...me, host: "evil.example:8792" }, false) ?? "", /Host/, "网页借 DNS 重绑定直连 8792、自带伪造身份头");
assert.equal(checkAccess(remote, "POST", { ...me, origin }, false), null);
assert.match(checkAccess(remote, "POST", me, false) ?? "", /Origin/, "远程写操作必须带 Origin");
assert.equal(checkAccess(remote, "GET", { ...me, origin }, true), null, "WS");
assert.match(checkAccess(remote, "GET", me, true) ?? "", /Origin/, "WS 不带 Origin");
assert.match(checkAccess(remote, "GET", { ...me, origin: "https://other.tail1234.ts.net" }, true) ?? "", /Origin/, "别的 ts.net 源");
assert.match(checkAccess(remote, "POST", { ...me, origin: "http://127.0.0.1:8790" }, false) ?? "", /Origin/, "本机页面不能打远程口");

// ── 同 tailnet 本人其他电脑的源（手机主屏 App 留在原源切换主机）──
const laptop = "https://laptop.tail1234.ts.net";
const withPeer = remotePolicy({ port: 8792, origin, allowedLogins: ["me@github"] }, { has: value => value === laptop });
assert.equal(checkAccess(withPeer, "POST", { ...me, origin: laptop }, false), null, "已确认的本人电脑可写");
assert.equal(checkAccess(withPeer, "GET", { ...me, origin: laptop }, true), null, "已确认的本人电脑可开 WS");
assert.match(checkAccess(withPeer, "POST", { ...via, origin: laptop }, false) ?? "", /Tailscale 身份/, "仍要身份头");
assert.match(checkAccess(withPeer, "POST", { ...me, origin: "https://other.tail1234.ts.net" }, false) ?? "", /Origin/, "未确认的同 tailnet 源");
assert.equal(corsOrigin(withPeer, { ...me, origin: laptop }), laptop, "回显已确认的源");
assert.equal(corsOrigin(withPeer, { ...me, origin }), null, "同源不加 CORS");
assert.equal(corsOrigin(remote, { ...me, origin: laptop }), null, "默认不信任任何其他源");
assert.equal(corsOrigin(local, { ...self, origin: laptop }), null, "本机入口不加 CORS");
for (const value of ["https://laptop.tail9999.ts.net", "https://a.laptop.tail1234.ts.net", "http://laptop.tail1234.ts.net",
  "https://laptop.tail1234.ts.net:8443", "https://laptop.tail1234.ts.net.evil.test", origin, undefined]) {
  assert.equal(sameTailnetPeerOrigin(origin, value), false, `不是同 tailnet 的其他电脑：${value}`);
}
assert.equal(sameTailnetPeerOrigin(origin, laptop), true);

{
  let now = 0, loads = 0;
  let peers = [{ name: "laptop", origin: laptop, online: true, os: "linux", ips: [], owned: true as const },
    { name: "shared", origin: "https://shared.tail1234.ts.net", online: true, os: "linux", ips: [] }];
  let fail = false;
  const cache = new PeerOriginCache(origin, async () => { loads++; return fail ? { peers: [], reason: "x" } : { peers }; }, () => now);
  await cache.ensure(laptop);
  assert.equal(cache.has(laptop), true, "owned 电脑被信任");
  await cache.ensure("https://shared.tail1234.ts.net");
  assert.equal(loads, 1, "未知源 15 秒内不重复读 Tailscale");
  assert.equal(cache.has("https://shared.tail1234.ts.net"), false, "非本人账号的电脑不信任");
  await cache.ensure("https://evil.example");
  assert.equal(loads, 1, "非同 tailnet 源不触发读取");
  now = 11 * 60_000; fail = true;
  await cache.ensure(laptop);
  assert.equal(loads, 2, "过期后重读");
  assert.equal(cache.has(laptop), true, "读取失败保留旧列表");
  now += 50 * 60_000;
  await cache.ensure(laptop);
  assert.equal(cache.has(laptop), false, "持续读取失败超过 1 小时后不再信任旧列表");
  fail = false; peers = [];
  now += 16_000;
  await cache.ensure(laptop);
  assert.equal(cache.has(laptop), false, "设备从 tailnet 移除后失效");
}

// ── remote.json 解析 ──
const dir = await mkdtemp(join(tmpdir(), "workbench-access-test-"));
try {
  const file = join(dir, "remote.json");
  assert.equal(loadRemoteConfig(file, 8790), null, "没有文件 = 不开远程");
  const good = { port: 8792, origin, allowedLogins: ["me@github"] };
  await writeFile(file, JSON.stringify(good));
  assert.deepEqual(loadRemoteConfig(file, 8790), good);
  await writeFile(file, JSON.stringify({ ...good, terminal: true }));
  assert.deepEqual(loadRemoteConfig(file, 8790), { ...good, terminal: true }, "显式开启远程终端");
  await writeFile(file, JSON.stringify({ ...good, terminal: false }));
  assert.deepEqual(loadRemoteConfig(file, 8790), { ...good, terminal: false }, "显式关闭远程终端");
  await writeFile(file, JSON.stringify({ ...good, terminal: "true" }));
  assert.deepEqual(loadRemoteConfig(file, 8790), { ...good, terminal: false }, "错误类型按关闭处理");
  const bad: unknown[] = [
    { ...good, port: 8790 }, // 与本机端口相同
    { ...good, port: "8792" },
    { ...good, origin: "http://desk.tail1234.ts.net" },
    { ...good, origin: `${origin}/` }, // 结尾斜杠
    { ...good, origin: "https://Desk.tail1234.ts.net" }, // 大写：浏览器发来的 Origin 永远是小写
    { ...good, origin: "https://example.com" }, // 不是 ts.net：tailscale serve 只给 ts.net 域名签证书
    { ...good, allowedLogins: [] },
    { ...good, allowedLogins: [""] },
  ];
  for (const value of bad) {
    await writeFile(file, JSON.stringify(value));
    assert.throws(() => loadRemoteConfig(file, 8790), /remote\.json/, JSON.stringify(value));
  }
  await writeFile(file, "{not json");
  assert.throws(() => loadRemoteConfig(file, 8790), /不是有效 JSON/);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ local: 15, remote: 11, config: 11 }));
