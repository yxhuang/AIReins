import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAccess, loadRemoteConfig, localPolicy, remotePolicy } from "./access.js";

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

// ── remote.json 解析 ──
const dir = await mkdtemp(join(tmpdir(), "workbench-access-test-"));
try {
  const file = join(dir, "remote.json");
  assert.equal(loadRemoteConfig(file, 8790), null, "没有文件 = 不开远程");
  const good = { port: 8792, origin, allowedLogins: ["me@github"] };
  await writeFile(file, JSON.stringify(good));
  assert.deepEqual(loadRemoteConfig(file, 8790), good);
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
