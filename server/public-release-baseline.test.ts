import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run a copied launcher with fake port/backend commands; never start the live WB.
for (const buildFails of [true, false]) {
  const root = mkdtempSync(join(tmpdir(), "wb-release-launcher-"));
  const repo = join(root, "repo");
  const mocks = join(root, "mocks");
  const trace = join(root, "calls");
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(mocks);
  copyFileSync(new URL("../bin/workbench", import.meta.url), join(repo, "bin/workbench"));
  const executable = (name: string, script: string) => writeFileSync(join(mocks, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  executable("npm", `echo "npm $*" >> "$TEST_TRACE"
if [[ "$TEST_BUILD_FAIL" == 1 ]]; then exit 1; fi
mkdir -p frontend/dist
echo '<script src="/assets/fixture.js"></script>' > frontend/dist/index.html`);
  executable("ss", `if [[ -f "$TEST_STARTED" ]]; then echo 'LISTEN 0 511 127.0.0.1:8877 0.0.0.0:* users:(("node",pid=123,fd=20))'; fi`);
  executable("setsid", `echo backend >> "$TEST_TRACE"; touch "$TEST_STARTED"`);
  const result = spawnSync("bash", [join(repo, "bin/workbench"), "start"], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${mocks}:${process.env.PATH}`, WORKBENCH_NO_OPEN: "1", WORKBENCH_PORT: "8877",
      WORKBENCH_LOG: join(root, "server.log"), TEST_TRACE: trace, TEST_STARTED: join(root, "started"), TEST_BUILD_FAIL: buildFails ? "1" : "0" },
  });
  assert.equal(result.status, buildFails ? 1 : 0, result.stdout + result.stderr);
  const calls = readFileSync(trace, "utf8");
  assert.equal((calls.match(/npm run build/g) ?? []).length, 1);
  assert.equal(calls.includes("backend"), !buildFails);
  assert.equal(existsSync(join(repo, "frontend/dist/index.html")), !buildFails);
  if (buildFails) assert.match(result.stderr, /前端构建失败，工作台未启动/);
}
console.log("Release baseline: missing dist builds once; failed build never starts backend");
