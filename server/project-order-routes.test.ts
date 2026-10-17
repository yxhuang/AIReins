import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real index.ts HTTP path, isolated HOME/data and fake version CLIs: no authentication or native session needed.
const home = await mkdtemp(join(tmpdir(), "aireins-project-order-http-"));
const bin = join(home, "bin");
await mkdir(bin);
for (const name of ["codex", "claude", "kimi"]) await writeFile(join(bin, name), "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", { mode: 0o700 });
await writeFile(join(home, "project-order.json"), JSON.stringify(["/project/a", "/project/hidden", "/project/b"]));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as { port: number }).port;
await new Promise<void>(resolve => listener.close(() => resolve()));
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))], {
  env: { ...process.env, HOME: home, WORKBENCH_NO_APP_WINDOW: "1", WORKBENCH_HOME: home, WORKBENCH_PORT: String(port), PATH: `${bin}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const closed = once(child, "close");
let output = "";
const deadline = setTimeout(() => child.kill("SIGTERM"), 25_000);
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`startup timeout: ${output}`)), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(Error(`startup failed: ${output}`)); });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"message":"workbench server started"')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
  });
  const base = `http://127.0.0.1:${port}`;
  const send = (body: unknown, origin = base) => fetch(`${base}/api/project-order/move`, { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.deepEqual((await (await fetch(`${base}/api/project-order`)).json()).data.paths, ["/project/a", "/project/hidden", "/project/b"]);
  const moved = await send({ path: "/project/b", before: "/project/a" });
  assert.equal(moved.status, 200, "POST body must be read by real index.ts organization branch");
  assert.deepEqual((await moved.json()).data.paths, ["/project/b", "/project/a", "/project/hidden"]);
  assert.deepEqual(JSON.parse(await readFile(join(home, "project-order.json"), "utf8")), ["/project/b", "/project/a", "/project/hidden"]);
  const invalid = await send({ path: "/project/a", before: "/project/b", after: "/project/hidden" });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 40070);
  assert.equal((await send({ path: "/project/a", before: "/project/b" }, "https://evil.test")).status, 403);
  assert.equal((await fetch(`${base}/api/session-groups`)).status, 404);
  console.log("PASS: real HTTP project-order GET/POST body wiring, persistence, validation and unchanged Origin guard");
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  await closed;
}
