import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyPage, scanPages, type PageManifest } from "./pages.js";

// 上游：回显收到的路径和头
let seen: { url?: string; method?: string; headers?: IncomingHttpHeaders; body?: string } = {};
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen = { url: req.url, method: req.method, headers: req.headers, body };
    res.writeHead(201, { "content-security-policy": "frame-ancestors 'self'", "x-up": "1" });
    res.end("ok");
  });
});
await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
const upPort = (upstream.address() as AddressInfo).port;
const page: PageManifest = { id: "p", name: "P", icon: "📊", type: "iframe", url: `http://127.0.0.1:${upPort}`, proxy: true };

// 前端：模拟 index.ts 已剥掉 /pages/p 前缀、已过 checkAccess
let lastPending: Promise<void> = Promise.resolve();
const front = createServer((req, res) => {
  lastPending = proxyPage(page, req.url ?? "/", req, res);
  lastPending.catch(() => res.destroy());
});
await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
const frontPort = (front.address() as AddressInfo).port;

function call(method: string, path: string, headers: Record<string, string>, body = "") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port: frontPort, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

const got = await call("POST", "/api/refresh?provider=all", {
  host: "desk.tail1234.ts.net",
  origin: "https://desk.tail1234.ts.net",
  "tailscale-user-login": "me@github",
  "tailscale-user-name": "Me",
  "x-forwarded-for": "100.64.0.1",
  cookie: "a=b",
  referer: "https://desk.tail1234.ts.net/",
  "x-requested-by": "ai-usage-panel",
  "content-type": "application/json",
}, "{}");
assert.equal(got.status, 201, "状态码透传");
assert.equal(got.text, "ok");
assert.equal(got.headers["x-up"], "1", "响应头透传");
assert.equal(got.headers["content-security-policy"], "frame-ancestors 'self'");
assert.equal(seen.method, "POST");
assert.equal(seen.url, "/api/refresh?provider=all", "路径与 query 原样");
assert.equal(seen.body, "{}", "请求体透传");
assert.equal(seen.headers?.host, `127.0.0.1:${upPort}`, "Host 改成目标");
assert.equal(seen.headers?.origin, `http://127.0.0.1:${upPort}`, "带 Origin 时改成目标源");
assert.equal(seen.headers?.["x-requested-by"], "ai-usage-panel", "业务头保留");
for (const name of ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "cookie", "referer"]) {
  assert.equal(seen.headers?.[name], undefined, `${name} 不下传`);
}

await call("POST", "/api/refresh", { host: "127.0.0.1:8790" });
assert.equal(seen.headers?.origin, undefined, "不带 Origin 时不补，目标自行 fail-closed");

// 上游挂了：proxyPage reject，由调用方（index.ts）转成 502
// 用一个刚关掉的端口：WSL 里连 127.0.0.1:1 不会立刻被拒，而是挂到超时
const closed = createServer();
await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
const closedPort = (closed.address() as AddressInfo).port;
await new Promise<void>((done) => closed.close(() => done()));
const dead: PageManifest = { ...page, url: `http://127.0.0.1:${closedPort}` };
let pending: Promise<void> | undefined;
const deadFront = createServer((req, res) => {
  pending = proxyPage(dead, "/", req, res);
  pending.catch(() => res.end());
});
await new Promise<void>((done) => deadFront.listen(0, "127.0.0.1", done));
await new Promise<void>((done) => {
  request({ host: "127.0.0.1", port: (deadFront.address() as AddressInfo).port, path: "/" }, (res) => res.resume().on("end", done)).end();
});
await assert.rejects(pending!, /ECONNREFUSED/);
deadFront.close();

// 客户端上传途中断开：代理应立即结束，而不是挂到 30 秒超时
await new Promise<void>((done) => {
  const req = request({ host: "127.0.0.1", port: frontPort, method: "POST", path: "/", headers: { "content-length": "100" } });
  req.on("error", () => undefined);
  req.write("half");
  setTimeout(() => {
    req.destroy();
    setTimeout(done, 200);
  }, 100);
});
const outcome = await Promise.race([
  lastPending.then(() => "resolved", () => "rejected"),
  new Promise((done) => setTimeout(() => done("hung"), 1_000)),
]);
assert.equal(outcome, "rejected", "客户端断开后代理立即结束");
assert.equal((await call("GET", "/still-alive", {})).status, 201, "断开后仍能服务");

// manifest：proxy 只允许本机回环 http
const root = await mkdtemp(join(tmpdir(), "wb-pages-"));
const manifests: Record<string, string> = { ok: "http://127.0.0.1:8788", lan: "http://192.168.1.6:8788", tls: "https://127.0.0.1:8788" };
for (const [id, url] of Object.entries(manifests)) {
  await mkdir(join(root, id));
  await writeFile(join(root, id, "manifest.json"), JSON.stringify({ id, name: id, icon: "📊", type: "iframe", url, proxy: true }));
}
assert.deepEqual(scanPages(root).map((p) => p.id), ["ok"], "非回环 / https 的代理 manifest 被跳过");

front.close();
upstream.close();
console.log("✅ pages 代理测试全过");
