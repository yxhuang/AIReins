import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = await realpath(await mkdtemp(join(tmpdir(), "aireins-system-open-")));
process.env.HOME = fixture;
process.env.WSL_DISTRO_NAME = "Ubuntu";
const { openSystemWorkPath, systemOpenEnabled, windowsOpenPath } = await import("./system-open.js");

assert.equal(windowsOpenPath("/mnt/c/Users/a b/报告.docx"), "C:\\Users\\a b\\报告.docx");
assert.equal(windowsOpenPath("/mnt/d"), "D:\\");
assert.equal(windowsOpenPath("/home/u/x.xlsx"), "\\\\wsl.localhost\\Ubuntu\\home\\u\\x.xlsx");
assert.equal(windowsOpenPath("/mnt/cdrom/x"), "\\\\wsl.localhost\\Ubuntu\\mnt\\cdrom\\x");
// Windows 会改写或另解释的名字（ADS、反斜杠、末尾点/空格、通配符）一律拒绝，避免打开到别的对象。
for (const bad of ["/home/u/a:b", "/home/u/a\\b", "/home/u/a.", "/home/u/a ", "/home/u/a*", "/home/u//a", "relative"]) {
  assert.throws(() => windowsOpenPath(bad), /无法用 Windows 程序打开/, bad);
}
assert.throws(() => windowsOpenPath("/home/u/x", "bad name"), /WSL 发行版/);

assert.equal(systemOpenEnabled(false, "wsl"), false);
assert.equal(systemOpenEnabled(true, "linux"), false);
assert.equal(systemOpenEnabled(true, "unsupported"), false);

await mkdir(join(fixture, "docs"));
await writeFile(join(fixture, "docs", "表.xlsx"), "");
await symlink(join(fixture, "docs"), join(fixture, "link"));
const calls: [string, string][] = [];
const run = async (path: string, host: string) => { calls.push([path, host]); };
await openSystemWorkPath({ path: join(fixture, "link", "表.xlsx"), root: fixture }, { platform: "wsl" }, run);
await openSystemWorkPath({ path: join(fixture, "docs"), root: fixture }, { platform: "darwin" }, run);
assert.deepEqual(calls, [
  [`\\\\wsl.localhost\\Ubuntu${join(fixture, "docs", "表.xlsx").replaceAll("/", "\\")}`, "wsl"],
  [join(fixture, "docs"), "darwin"],
], "按 realpath 打开，WSL 映射为 Windows 路径");
await assert.rejects(openSystemWorkPath({ path: "/etc/hosts", root: "/etc" }, { platform: "darwin" }, run), { status: 403 });
await assert.rejects(openSystemWorkPath({ path: join(fixture, "missing"), root: fixture }, { platform: "darwin" }, run), { status: 404 });
await assert.rejects(openSystemWorkPath({ path: join(fixture, "docs"), root: fixture }, { platform: "darwin" },
  async () => { throw new Error("launcher failed"); }), { status: 503 });
assert.equal(calls.length, 2);

await rm(fixture, { recursive: true, force: true });
console.log("system open tests passed");
