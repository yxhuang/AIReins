import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run a copied launcher with fake port/backend commands; never start the live AIReins.
// Locale is pinned: zh asserts the Chinese copy, en asserts the English one.
for (const [buildFails, locale, failureCopy] of [[true, "zh_CN.UTF-8", /前端构建失败，工作台未启动/], [false, "zh_CN.UTF-8", null], [true, "en_US.UTF-8", /Frontend build failed; AIReins not started/]] as const) {
  const root = mkdtempSync(join(tmpdir(), "wb-release-launcher-"));
  const repo = join(root, "repo");
  const mocks = join(root, "mocks");
  const trace = join(root, "calls");
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(mocks);
  copyFileSync(new URL("../bin/aireins", import.meta.url), join(repo, "bin/aireins"));
  const executable = (name: string, script: string) => writeFileSync(join(mocks, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  executable("npm", `echo "npm $*" >> "$TEST_TRACE"
if [[ "$TEST_BUILD_FAIL" == 1 ]]; then exit 1; fi
mkdir -p frontend/dist
echo '<script src="/assets/fixture.js"></script>' > frontend/dist/index.html`);
  executable("ss", `if [[ -f "$TEST_STARTED" ]]; then echo 'LISTEN 0 511 127.0.0.1:8877 0.0.0.0:* users:(("node",pid=123,fd=20))'; fi`);
  executable("setsid", `echo backend >> "$TEST_TRACE"; touch "$TEST_STARTED"`);
  const result = spawnSync("bash", [join(repo, "bin/aireins"), "start"], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, LC_ALL: locale, PATH: `${mocks}:${process.env.PATH}`, WORKBENCH_NO_OPEN: "1", WORKBENCH_PORT: "8877",
      WORKBENCH_LOG: join(root, "server.log"), TEST_TRACE: trace, TEST_STARTED: join(root, "started"), TEST_BUILD_FAIL: buildFails ? "1" : "0" },
  });
  assert.equal(result.status, buildFails ? 1 : 0, result.stdout + result.stderr);
  const calls = readFileSync(trace, "utf8");
  assert.equal((calls.match(/npm run build/g) ?? []).length, 1);
  assert.equal(calls.includes("backend"), !buildFails);
  assert.equal(existsSync(join(repo, "frontend/dist/index.html")), !buildFails);
  if (failureCopy) assert.match(result.stderr, failureCopy);
}
console.log("Release baseline: missing dist builds once; failed build never starts backend");

// Public CLI wiring: keep internal gateway/service filenames while calling the new entry.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
assert.match(source("../bin/aireins-win"), /\/aireins"/);
assert.match(source("../deploy/windows/wb-tray.ps1"), /\$WbPath = '~\/\.local\/bin\/aireins'/);
assert.match(source("../deploy/windows/wb-remote-gateway.ps1"), /\/\.local\/bin\/aireins start/);
assert.match(source("../deploy/systemd/wb-remote-conn.py"), /~\/\.local\/bin\/aireins/);
for (const path of ["../deploy/windows/wb-tray.ps1", "../deploy/windows/install-tray.ps1", "../deploy/windows/wb-remote-gateway.ps1"]) {
  assert.equal(source(path).charCodeAt(0), 0xfeff, `${path}: preserve UTF-8 BOM for Windows PowerShell 5.1`);
}
console.log("Release CLI: Windows shortcut/tray/gateway and Linux socket entry call aireins");
