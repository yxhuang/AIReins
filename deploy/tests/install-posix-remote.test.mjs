import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupPosixRemote } from '../install-posix-remote.mjs';

const temp = mkdtempSync(join(tmpdir(), 'aireins-posix-remote-'));
const origin = 'https://alice.example.ts.net';
const config = { origin, port: 9873, allowedLogins: ['alice@example.test'], terminal: true };
const status = { BackendState: 'Running' };
const same = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'alice.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9873' } } } },
};
let seq = 0;
function runCase({ platform, serve = {}, check = false, state = status, error, readError, raw, configText = JSON.stringify(config) }) {
  const home = join(temp, String(seq++)); mkdirSync(home);
  writeFileSync(join(home, 'remote.json'), configText);
  const calls = []; const lines = [];
  const result = setupPosixRemote({ home, platform, check, print: line => lines.push(line), run(file, args) {
    calls.push([file, args]);
    if (args[0] === 'status') return { status: 0, stdout: JSON.stringify(state) };
    if (args[1] === 'status') return readError ?? { status: 0, stdout: raw ?? JSON.stringify(serve) };
    assert.deepEqual(args, ['serve', '--bg', 'http://127.0.0.1:9873']);
    return error ?? { status: 0, stdout: '' };
  } });
  assert.equal(result.created, false);
  assert.equal(readFileSync(join(home, 'remote.json'), 'utf8'), configText, '已有 remote.json 保持逐字节不变');
  return { writes: calls.filter(([, args]) => args[1] === '--bg'), calls, text: lines.join('\n') };
}
for (const platform of ['linux', 'darwin']) {
  for (const serve of [null, {}, { TCP: {}, Web: {}, Foreground: {}, Services: {} }]) {
    const result = runCase({ platform, serve });
    assert.equal(result.writes.length, 1, '未配置 Serve 时只执行一次启用');
    assert(result.text.includes(origin));
    assert.deepEqual(result.calls[1][1], ['serve', 'status', '--json'], '启用前先读 Serve');
    assert.equal(runCase({ platform, serve, check: true }).writes.length, 0, '--check 只读');
  }
  const configured = runCase({ platform, serve: same });
  assert.equal(configured.writes.length, 0, '同目标不更改');
  assert(/already configured|已配置/.test(configured.text));
  for (const serve of [
    { TCP: { 80: { TCPForward: '127.0.0.1:1234' } } },
    { Web: { 'alice.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1234' } } } } },
    { Foreground: { session: same } },
    { Services: { 'svc:other': { Tun: true } } },
    { ...same, AllowFunnel: { 'alice.example.ts.net:443': true } },
  ]) {
    const other = runCase({ platform, serve });
    assert.equal(other.writes.length, 0, '其他 Serve/Funnel 配置不覆盖');
    assert(other.text.includes(JSON.stringify(serve)), '打印现状');
    assert(other.text.includes('serve --bg http://127.0.0.1:9873'), '给出手动命令');
  }
  const denied = runCase({ platform, error: { status: 1, stderr: 'Access denied: check operator permissions' } });
  assert.equal(denied.writes.length, 1, '权限失败不重试');
  assert(denied.text.includes('set --operator="$USER"'));
  assert(denied.text.includes('bash install.sh'));
  const unreadable = runCase({ platform, readError: { error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) } });
  assert.equal(unreadable.writes.length, 0, '读取权限失败不能误判为空配置');
  assert(unreadable.text.includes('set --operator="$USER"'));
  for (const raw of ['invalid', '[]', 'false']) assert.equal(runCase({ platform, raw }).writes.length, 0, '状态无效不写入');
  assert.equal(runCase({ platform, state: { BackendState: 'NeedsLogin' } }).calls.length, 1, '未登录不读写 Serve');
  assert.equal(runCase({ platform, configText: 'invalid' }).calls.length, 1, '无效配置不读写 Serve');
}
console.log('POSIX remote OK: empty, same, other, permission failure; --check and invalid/login guards (all run stubs)');
