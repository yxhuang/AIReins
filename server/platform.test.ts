import assert from "node:assert/strict";
import { detectPlatform, getPlatformCapabilities, findPowerShell, tailscaleExecutables, vscodeFileUri, windowsPickerAvailable } from "./platform.js";
import { remotePolicy, checkAccess } from "./access.js";
import { resolveShell } from "./terminals.js";
for (const [input, expected] of [
  [{ os: "linux", kernel: "6.6.87.2-microsoft-standard-WSL2", interop: false }, "wsl"],
  [{ os: "linux", kernel: "generic", interop: true }, "wsl"],
  [{ os: "linux", kernel: "generic", interop: false }, "linux"],
  [{ os: "darwin", kernel: "23.0", interop: true }, "darwin"],
  [{ os: "win32", kernel: "microsoft", interop: true }, "unsupported"],
] as const) assert.equal(detectPlatform(input), expected);
const installed = { local: true, chrome: true, picker: true, powershell: true, shellOpen: true, powerOff: true, tailscale: true, zip: true };
const wsl = getPlatformCapabilities({ ...installed, host: "wsl" });
assert.ok(Object.values(wsl).every(Boolean), "具备原依赖和关机prefs的WSL入口全部保留");
for (const host of ["linux", "darwin"] as const) {
  const caps = getPlatformCapabilities({ ...installed, host });
  for (const key of ["windowsDirectoryPicker", "appWindow", "windowsPaths", "powershell", "windowsTray", "remoteGateway"] as const) {
    assert.equal(caps[key], false, `${host}: ${key}`);
  }
  assert.equal(caps.terminal, true); assert.equal(caps.taildrop, true); assert.equal(caps.powerOff, true);
  assert.equal(caps.fileEdit, host === "linux"); assert.equal(caps.folderTaildrop, host === "linux");
  assert.equal(findPowerShell(host, () => true), undefined);
  assert.equal(windowsPickerAvailable(true, host, () => true), false);
  assert.throws(() => resolveShell("powershell", () => true, host), /PowerShell/);
  assert.deepEqual(resolveShell(undefined, () => false, host, { env: {}, executable: () => false }), { kind: "bash", file: "bash", args: ["-l", "-i"] }, "无可用登录 shell 时回退 bash");
  // Serve 直连 loopback 使用相同策略：缺身份、错账号、错 Host/Origin 与 WS 全部拒绝。
  const policy = remotePolicy({ port: 18893, origin: "https://pc.example.ts.net", allowedLogins: ["alice@example.test"] });
  const headers = { host: "127.0.0.1:18893", origin: "https://pc.example.ts.net", "tailscale-user-login": "alice@example.test" };
  assert.equal(checkAccess(policy, "POST", headers, false), null);
  assert.equal(checkAccess(policy, "GET", headers, true), null);
  for (const bad of [{ ...headers, host: "evil.test" }, { ...headers, "tailscale-user-login": undefined },
    { ...headers, "tailscale-user-login": "other@example.test" }, { ...headers, origin: undefined }, { ...headers, origin: "https://evil.test" }]) {
    assert.notEqual(checkAccess(policy, "POST", bad, false), null);
    assert.notEqual(checkAccess(policy, "GET", bad, true), null);
  }
}
for (const host of ["wsl", "linux", "darwin"] as const) {
  const caps = getPlatformCapabilities({ ...installed, local: false, host });
  assert.equal(caps.terminal, false); assert.equal(caps.appWindow, false); assert.equal(caps.windowsDirectoryPicker, false); assert.equal(caps.systemOpen, false);
  assert.equal(getPlatformCapabilities({ ...installed, local: false, remoteTerminal: true, host }).terminal, true);
}
assert.deepEqual(tailscaleExecutables("wsl"), ["tailscale", "/mnt/c/Program Files/Tailscale/tailscale.exe"]);
assert.deepEqual(tailscaleExecutables("linux"), ["tailscale"]);
assert.deepEqual(tailscaleExecutables("darwin"), ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
assert.equal(vscodeFileUri("/home/a b", "Ubuntu"), "vscode://vscode-remote/wsl+Ubuntu/home/a%20b");
assert.equal(vscodeFileUri("/Users/a b", ""), "vscode://file/Users/a%20b");
assert.equal(vscodeFileUri("relative", ""), null);
const missing = getPlatformCapabilities({ host: "wsl", local: true, chrome: false, picker: false, powershell: false, tailscale: false, zip: false });
for (const key of ["appWindow", "windowsDirectoryPicker", "powershell", "powerOff", "taildrop", "folderTaildrop"] as const) assert.equal(missing[key], false);
console.log("✅ platform detection, capabilities, native shell and direct Serve access guards");
