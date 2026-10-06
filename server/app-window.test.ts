import assert from "node:assert/strict";
import { appWindowEnabled, openAppWindow, AppWindowError, findWindowsChrome } from "./app-window.js";
import { localPolicy, remotePolicy } from "./access.js";

const local = localPolicy(8790);
const remote = remotePolicy({ port: 8792, origin: "https://desk.tail1234.ts.net", allowedLogins: ["me"] });
const chrome = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const launched: { file: string; args: string[] }[] = [];
const launcher = async (file: string, args: string[]) => { launched.push({ file, args }); };
assert.equal(appWindowEnabled(remote, chrome), false);
assert.equal(appWindowEnabled(local, null), false);
assert.equal(appWindowEnabled(local, chrome), true);
await assert.rejects(openAppWindow(remote, 8790, { target: "http://127.0.0.1:8790/" }, chrome, launcher),
  error => error instanceof AppWindowError && error.status === 403);
for (const target of [null, 42, "javascript:alert(1)", "https://evil.test/", "http://127.0.0.1:9000/",
  "https://desk.tail1234.ts.net/path?x=1#/session/remote",
  "http://user@localhost:8790/", "https://desk.tail1234.ts.net:8443/", "https://desk.tail1234.ts.net.evil.test/",
  "https://desk.tail1234.ts.net/\n", "x".repeat(5000)]) {
  await assert.rejects(openAppWindow(local, 8790, { target }, chrome, launcher),
    error => error instanceof AppWindowError && error.status === 400, String(target));
}
assert.equal(launched.length, 0, "拒绝请求不启动程序");
for (const target of ["http://localhost:8790/path?x=1#/session/local", "http://127.0.0.1:8790/#/session/local", "http://localhost:5173/#/session/dev"]) {
  await openAppWindow(local, 8790, { target }, chrome, launcher);
  assert.deepEqual(launched.at(-1), { file: chrome, args: [`--app=http://127.0.0.1:8790/#wb-goto=${encodeURIComponent(target)}`] });
}
await assert.rejects(openAppWindow(local, 8790, { target: "http://127.0.0.1:8790/" }, null, launcher),
  error => error instanceof AppWindowError && error.status === 503);
await assert.rejects(openAppWindow(local, 8790, { target: "http://127.0.0.1:8790/" }, chrome,
  async () => { throw Error("launch failed"); }), /无法启动/);
assert.equal(findWindowsChrome(false), null, "非 WSL 不可用且不探测 Windows");
console.log("PASS: App 窗口入口隔离、能力位、target 校验、本机 App origin 与假 launcher");
