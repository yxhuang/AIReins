// The same isolated startup and direct-Serve access check runs locally and in CI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'wb-ci-smoke-'));
const workbenchHome = join(home, 'workbench');
const bin = join(home, 'bin');
const directories = ['workbench', 'bin', '.claude', '.codex', '.kimi', '.config', 'claude-history', 'codex-history', 'kimi-history', 'delegate'];
await Promise.all(directories.map(directory => mkdir(join(home, directory))));
for (const cli of ['claude', 'codex', 'kimi']) {
  await writeFile(join(bin, cli), '#!/bin/sh\nif [ "$1" = --version ]; then echo workbench-ci-stub-1.0; exit 0; fi\nexit 1\n', { mode: 0o755 });
}
await writeFile(join(workbenchHome, 'prefs.json'), '{}\n');

// Hold both reservations together so local and remote ports cannot collide.
const probes = [createServer(), createServer()];
await Promise.all(probes.map(probe => new Promise((resolve, reject) => {
  probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);
})));
const [port, remotePort] = probes.map(probe => probe.address().port);
assert(![8790, 8792, 8793].includes(port) && ![8790, 8792, 8793].includes(remotePort));
await Promise.all(probes.map(probe => new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))));
const origin = 'https://pc.example.ts.net';
const login = 'demo@example.test';
await writeFile(join(workbenchHome, 'remote.json'), JSON.stringify({ port: remotePort, origin, allowedLogins: [login], terminal: false }) + '\n', { mode: 0o600 });

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, HOME: home, WORKBENCH_HOME: workbenchHome,
    PATH: `${bin}:${process.env.PATH ?? ''}`, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi'), XDG_CONFIG_HOME: join(home, '.config'),
    WORKBENCH_CLAUDE_HISTORY_DIR: join(home, 'claude-history'), WORKBENCH_CLAUDE_PROJECTS_DIR: join(home, 'claude-history'),
    WORKBENCH_CODEX_HISTORY_DIR: join(home, 'codex-history'), WORKBENCH_KIMI_HISTORY_DIR: join(home, 'kimi-history'),
    WB_DELEGATE_DIR: join(home, 'delegate'), WORKBENCH_STATIC_DIR: join(process.cwd(), 'frontend/dist'),
    WORKBENCH_PORT: String(port), WORKBENCH_NO_APP_WINDOW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; let childError; let childClosed = false;
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
child.once('error', error => { childError = error; });
// close also fires after spawn errors; attaching now handles an early exit before cleanup.
const closed = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = (targetPort, path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port: targetPort, path, method, headers,
    agent: false, signal: AbortSignal.timeout(3000) }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', data => { body += data; });
    response.once('error', reject); response.once('end', () => resolve({ status: response.statusCode, body }));
  });
  req.once('error', reject); req.end();
});
const waitForClose = async ms => {
  let timer;
  const stopped = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer); return stopped;
};
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childError) throw childError;
    if (childClosed) throw new Error(`Backend exited ${child.exitCode ?? child.signalCode}`);
    try { response = await get(port, '/api/meta'); break; } catch { await delay(100); }
  }
  assert(response, 'Backend did not serve /api/meta');
  assert.equal(response.status, 200);
  const meta = JSON.parse(response.body);
  assert.equal(meta.code, 0); assert(meta.data.capabilities);
  for (const cli of ['claude', 'codex', 'kimi']) assert.equal(meta.data.cliVersions[cli], 'workbench-ci-stub-1.0');
  response = await get(port, '/');
  assert.equal(response.status, 200); assert.match(response.body, /<html[\s>]/i);
  const headers = { host: new URL(origin).host, 'tailscale-user-login': login };
  assert.equal((await get(remotePort, '/api/meta', { host: headers.host })).status, 403, 'Missing identity must be denied');
  assert.equal((await get(remotePort, '/api/meta', { ...headers, host: 'evil.example' })).status, 403, 'Wrong Host must be denied');
  assert.equal((await get(remotePort, '/api/meta', { ...headers, 'tailscale-user-login': 'other@example.test' })).status, 403, 'Wrong login must be denied');
  response = await get(remotePort, '/api/meta', headers);
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).code, 0);
  assert.equal((await get(remotePort, '/api/meta', { ...headers, host: `127.0.0.1:${remotePort}` })).status, 200, 'Serve may preserve its loopback target Host');
  assert.equal((await get(remotePort, '/ci-smoke-unknown', { ...headers, origin: 'https://evil.example' }, 'POST')).status, 403, 'Wrong write Origin must be denied before routing');
  console.log(`CI smoke OK: isolated CLI stubs, /api/meta and / on ${port}; direct-Serve access guards on ${remotePort}`);
} catch (error) {
  console.error(output.slice(-6000)); throw error;
} finally {
  if (!childClosed && !childError) child.kill('SIGTERM');
  if (!await waitForClose(5000)) { child.kill('SIGKILL'); assert(await waitForClose(5000), 'Backend still running'); }
  assert(childClosed, 'Backend still running');
  console.log('CI smoke backend stopped');
}
