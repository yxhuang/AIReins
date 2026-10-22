import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCallbacks } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "aireins-codex-proxy-"));
const keys = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];
const changed = [...keys, "no_proxy", "NO_PROXY", "PATH", "WORKBENCH_HOME", "AIREINS_PROXY_FIXTURE_LOG"];
const original = Object.fromEntries(changed.map(key => [key, process.env[key]]));
process.env.WORKBENCH_HOME = fixture;
const { DEFAULT_PREFS, loadPrefs, savePrefs } = await import("./prefs.js");
const { codexEnvironment } = await import("./codex-env.js");
const { CodexDriver, probeCodexConfigSchema } = await import("./drivers/codex.js");
const server = createServer((_request, response) => { response.end("proxy-online"); });
let driver: InstanceType<typeof CodexDriver> | undefined;

async function listen(port: number): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function closeProxy(): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

try {
  const inherited = { https_proxy: "http://inherited.example:18080", NO_PROXY: "internal.example", EXTRA: "retained" };
  assert.deepEqual(codexEnvironment(inherited), inherited, "No preference preserves the original environment");
  const proxyPort = await listen(0);
  const proxy = `http://127.0.0.1:${proxyPort}`;
  await closeProxy();
  savePrefs({ ...DEFAULT_PREFS, codexProxyUrl: proxy });
  const selected = codexEnvironment(inherited);
  for (const key of keys) assert.equal(selected[key], proxy);
  assert.equal(selected.no_proxy, selected.NO_PROXY);
  assert.equal(selected.EXTRA, "retained");
  assert.deepEqual(new Set(selected.no_proxy!.split(",")), new Set(["localhost", "127.0.0.1", "::1", "internal.example"]));
  assert.equal(inherited.https_proxy, "http://inherited.example:18080", "Parent environment stays untouched");
  const { workbenchHome } = await import("./persistence.js");
  assert.equal(workbenchHome, fixture, "Proxy setup must not redirect persistence outside the test fixture");
  savePrefs({ ...loadPrefs(), codexProxyUrl: "https://proxy.example:18443" });
  assert.equal(codexEnvironment({}).https_proxy, "https://proxy.example:18443", "New children read the current preference");
  savePrefs({ ...loadPrefs(), codexProxyUrl: proxy });

  // A local app-server fixture exercises real process inheritance without a logged-in CLI.
  const logPath = join(fixture, "children.jsonl");
  await writeFile(join(fixture, "codex"), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { get } from 'node:http';
import { createInterface } from 'node:readline';
const keys = ${JSON.stringify(keys)};
appendFileSync(process.env.AIREINS_PROXY_FIXTURE_LOG, JSON.stringify({ pid: process.pid,
  env: Object.fromEntries([...keys, 'no_proxy', 'NO_PROXY'].map(key => [key, process.env[key]])) }) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  try {
    let result = {};
    if (message.method === 'config/read') result = { config: { model: 'fixture-model' } };
    if (message.method === 'model/list') result = { data: [{ id: 'fixture-model', isDefault: true }] };
    if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: 'proxy-thread' } };
    if (message.method === 'thread/read') result = await new Promise((resolve, reject) => {
      const request = get(process.env.https_proxy, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ thread: { id: 'proxy-thread', proxyBody: body, pid: process.pid } }));
      });
      request.setTimeout(1000, () => request.destroy(new Error('fixture proxy timeout')));
      request.on('error', reject);
    });
    console.log(JSON.stringify({ id: message.id, result }));
  } catch (error) { console.log(JSON.stringify({ id: message.id, error: { message: error.message } })); }
});
lines.on('close', () => process.exit(0));
`, { mode: 0o700 });
  process.env.PATH = `${fixture}:${process.env.PATH}`;
  process.env.AIREINS_PROXY_FIXTURE_LOG = logPath;
  for (const key of keys) delete process.env[key];
  delete process.env.no_proxy;
  delete process.env.NO_PROXY;

  const schema = await probeCodexConfigSchema(fixture);
  assert.equal(schema.options.find(option => option.id === "model")?.default, "fixture-model");
  const callbacks: DriverCallbacks = { emit: () => undefined, metadata() {}, commands() {}, status() {}, exited() {} };
  driver = new CodexDriver({ sessionId: "proxy-fixture", cwd: fixture, config: {}, callbacks });
  await driver.start();
  const pid = driver.child!.pid;
  await assert.rejects(driver.queryInfo("status"));
  await listen(proxyPort);
  const online = await driver.queryInfo("status") as { thread: { proxyBody: string; pid: number } };
  assert.equal(online.thread.proxyBody, "proxy-online", "Proxy opened after the worker started");
  assert.equal(online.thread.pid, pid);
  await closeProxy();
  await assert.rejects(driver.queryInfo("status"));
  await listen(proxyPort);
  const recovered = await driver.queryInfo("status") as typeof online;
  assert.equal(recovered.thread.proxyBody, "proxy-online", "Proxy reopened without restarting the worker");
  assert.equal(recovered.thread.pid, pid);
  const children = (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(children.length, 2, "One configuration probe and one worker, with no automatic restart");
  for (const child of children) {
    for (const key of keys) assert.equal(child.env[key], proxy, "Probe and worker must use the same configured proxy");
    assert.equal(child.env.no_proxy, child.env.NO_PROXY);
  }
  for (const key of keys) assert.equal(process.env[key], undefined, "AR environment must stay unchanged");
  console.log("Codex proxy environment and offline/online process tests passed");
} finally {
  await driver?.stop();
  await closeProxy();
  for (const key of changed) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  await rm(fixture, { recursive: true, force: true });
}
