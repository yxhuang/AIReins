import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromStatus, validateConfig, setupRemote } from '../install-remote.mjs';

// install-remote.mjs resolves user-facing copy from LC_ALL/LC_MESSAGES/LANG at call time;
// pin Chinese so the assertions below do not drift with the host locale.
process.env.LC_ALL = 'zh_CN.UTF-8';

const origin = 'https://new-pc.tail123.ts.net';
const status = () => ({ BackendState: 'Running', Self: { DNSName: 'new-pc.tail123.ts.net.', UserID: 42 }, User: { '42': { LoginName: 'owner@example.com' } } });
const expected = { port: 8793, origin, allowedLogins: ['owner@example.com'], terminal: false };

test('generate the logged-in machine config without changing status input', () => {
  const input = status();
  assert.deepEqual(configFromStatus(input), expected);
  assert.equal(input.Self.DNSName, 'new-pc.tail123.ts.net.');
});
for (const [name, change, error] of [
  ['missing Self DNSName', s => delete s.Self.DNSName, /DNSName/],
  ['non ts.net name', s => s.Self.DNSName = 'example.com.', /origin/],
  ['missing User mapping', s => s.User = {}, /LoginName/],
  ['not Running', s => s.BackendState = 'NeedsLogin', /Running/],
  ['URL embedded in DNSName', s => s.Self.DNSName = 'host.ts.net/path', /origin/],
  ['empty login', s => s.User['42'].LoginName = '', /LoginName/],
]) test(name, () => {
  const input = status(); change(input);
  assert.throws(() => configFromStatus(input), error);
});
test('existing config follows backend port/origin/login validation', () => {
  assert.deepEqual(validateConfig({ ...expected, terminal: true }), { ...expected, terminal: true });
  for (const invalid of [
    { port: 8790 }, { port: '8793' }, { port: 65536 },
    { origin: `${origin}/` }, { origin: 'https://example.com' },
    { origin: 'https://user:pass@new-pc.tail123.ts.net' },
    { allowedLogins: [] }, { allowedLogins: [''] },
  ]) assert.throws(() => validateConfig({ ...expected, ...invalid }));
});

function fixture({ task = null, backend = status(), serve = {}, uacCode = 0, queryFails = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-install-remote-'));
  const calls = []; const messages = [];
  const options = {
    home, repo: '/home/test user/workbench', distro: 'Ubuntu', user: 'test', localPort: 8790,
    available: () => true, print: s => messages.push(s),
    run(file, args) {
      calls.push({ file, args });
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify(backend) };
      if (args[0] === 'serve') return { status: 0, stdout: JSON.stringify(serve) };
      const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      if (command.includes('Start-Process')) return { status: uacCode, stdout: '', stderr: 'UAC declined' };
      return { status: queryFails ? 1 : 0, stdout: JSON.stringify(task) };
    },
  };
  return { home, calls, messages, options, path: join(home, '.workbench/remote.json') };
}
test('fresh install writes mode 600 and invokes one waited UAC with UNC and Linux identity', () => {
  const f = fixture();
  const result = setupRemote(f.options);
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), expected);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const commands = f.calls.filter(c => c.args.includes('-EncodedCommand')).map(c => Buffer.from(c.args.at(-1), 'base64').toString('utf16le'));
  const uac = commands.filter(c => c.includes('Start-Process'));
  assert.equal(uac.length, 1);
  assert.match(uac[0], /-Verb RunAs -Wait -PassThru/);
  assert.ok(uac[0].includes('\\\\wsl.localhost\\Ubuntu\\home\\test user\\workbench\\deploy\\windows\\install-remote-gateway.ps1'));
  assert.ok(uac[0].includes('-Distro "Ubuntu" -LinuxUser "test" -LinuxHome "' + f.home + '"'));
  assert.ok(f.messages.some(s => s.includes('远程终端默认关闭') && s.includes('terminal 改为 true')));
});
test('existing config is byte-for-byte preserved and existing task skips UAC', () => {
  const f = fixture({ task: { State: 'Running' } });
  mkdirSync(join(f.home, '.workbench'));
  const text = JSON.stringify({ ...expected, terminal: true }, null, 2);
  writeFileSync(f.path, text, { mode: 0o640 });
  assert.equal(setupRemote(f.options).created, false);
  assert.equal(readFileSync(f.path, 'utf8'), text);
  assert.equal(statSync(f.path).mode & 0o777, 0o640);
  assert.equal(f.calls.length, 3);
  assert.ok(f.messages.some(s => s.includes(origin)));
  assert.ok(f.messages.some(s => s.includes('Running')));
});
test('--check reports three states and never creates a config or requests UAC', () => {
  const f = fixture();
  assert.equal(setupRemote({ ...f.options, check: true }).created, false);
  assert.throws(() => statSync(f.path), /ENOENT/);
  for (const label of ['remote.json', 'Serve', 'Workbench Remote Gateway']) assert.ok(f.messages.some(s => s.includes(label)));
  assert.equal(f.calls.length, 3);
});
test('repeated install preserves generated config and task query failure prevents UAC', () => {
  const f = fixture({ queryFails: true });
  assert.equal(setupRemote(f.options).created, true);
  const before = readFileSync(f.path, 'utf8');
  assert.equal(setupRemote(f.options).created, false);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(f.calls.length, 6);
});
test('refused UAC gives a copyable command and retains generated config', () => {
  const f = fixture({ uacCode: 1 });
  assert.equal(setupRemote(f.options).created, true);
  assert.ok(f.messages.some(s => s.includes('管理员 Windows PowerShell 5.1')));
  assert.ok(f.messages.some(s => s.includes('-File "\\\\wsl.localhost\\Ubuntu\\') && s.includes('-LinuxHome')));
});
test('stopped Tailscale, non-WSL and missing Tailscale skip without writing', () => {
  for (const extra of [{}, { distro: '' }, { available: () => false }]) {
    const f = fixture({ backend: { BackendState: 'NeedsLogin' } });
    setupRemote({ ...f.options, ...extra });
    assert.throws(() => statSync(f.path), /ENOENT/);
    assert.ok(f.messages.some(s => s.includes('跳过')));
  }
});
test('invalid existing config and dangling symlink are never overwritten', () => {
  for (const dangling of [false, true]) {
    const f = fixture(); mkdirSync(join(f.home, '.workbench'));
    if (dangling) symlinkSync(join(f.home, 'absent.json'), f.path);
    else writeFileSync(f.path, '{invalid');
    assert.equal(setupRemote(f.options).created, false);
    assert.equal(f.calls.length, 3);
    if (!dangling) assert.equal(readFileSync(f.path, 'utf8'), '{invalid');
    assert.ok(f.messages.some(s => s.includes('未覆盖')));
  }
});
test('Serve health verifies configured HTTPS root and refuses Funnel', () => {
  for (const [serve, good] of [
    [{ Web: { 'new-pc.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8794' } } } } }, true],
    [{ Web: { 'new-pc.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } }, false],
    [{ AllowFunnel: { 'new-pc.tail123.ts.net:443': true } }, false],
  ]) {
    const f = fixture({ serve }); mkdirSync(join(f.home, '.workbench')); writeFileSync(f.path, JSON.stringify(expected));
    setupRemote({ ...f.options, check: true });
    assert.ok(f.messages.some(s => s.startsWith(good ? '✅ Serve' : '⚠ Serve')));
  }
});
test('English locale prints English copy without Han characters', () => {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = 'en_US.UTF-8';
  try {
    const f = fixture({ uacCode: 1 });
    assert.equal(setupRemote(f.options).created, true);
    assert.ok(f.messages.some(s => s.includes('off by default') && s.includes('wb restart')));
    assert.ok(f.messages.some(s => s.includes('UAC was declined or installation failed')));
    for (const message of f.messages) assert.ok(!/[\u3400-\u9fff]/.test(message), message);
  } finally {
    process.env.LC_ALL = previous;
  }
});

// Run the real install.sh with shell/Windows/service commands replaced in a temp repo.
function installerFixture(running = true, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-install-shell-'));
  const repo = join(home, 'repo'); const mocks = join(home, 'mock-bin');
  mkdirSync(join(repo, 'deploy/windows'), { recursive: true });
  mkdirSync(join(repo, 'bin')); mkdirSync(mocks);
  copyFileSync(fileURLToPath(new URL('../../../install.sh', import.meta.url)), join(repo, 'install.sh'));
  const trace = join(home, 'calls');
  // Stubs run with LC_ALL=C so an uninstalled zh locale cannot leak bash setlocale
  // warnings into the captured stub output that install.sh pattern-matches on.
  const executable = (path, text) => writeFileSync(path, '#!/usr/bin/env -S LC_ALL=C bash\n' + text + '\n', { mode: 0o755 });
  executable(join(repo, 'bin/workbench'), `if [[ "\${BASH_SOURCE[0]}" != "$0" ]]; then PLATFORM=wsl; return 0; fi
echo "wb $*" >> "$TEST_TRACE"
case "$1" in
  status) if [[ -f "$TEST_HOME/running" ]]; then echo '运行中（PID 123）'; else echo '未运行'; fi ;;
  start) touch "$TEST_HOME/running"; echo '已启动（PID 123）' ;;
  stop) echo stopped ;;
  *) exit 1 ;;
esac`);
  if (running) writeFileSync(join(home, 'running'), '');
  executable(join(mocks, 'npm'), `echo "npm $*" >> "$TEST_TRACE"
if [[ "$*" == 'run build' && "\${TEST_BUILD_FAIL:-0}" == 1 ]]; then exit 1; fi`);
  executable(join(mocks, 'curl'), `url="\${@: -1}"
echo "curl $url" >> "$TEST_TRACE"
case "$url" in
  */api/meta) printf '{"code":0}\\n200' ;;
  */assets/fixture.js) printf 'fixture\\n%s' "\${TEST_ASSET_STATUS:-200}" ;;
  */) printf '<script src="/assets/fixture.js"></script>\\n%s' "\${TEST_HOME_STATUS:-200}" ;;
  *) exit 1 ;;
esac`);
  for (const name of ['ss', 'rg', 'codex', 'powershell.exe']) executable(join(mocks, name), 'echo "mock $0 $*" >> "$TEST_TRACE"');
  executable(join(mocks, 'wslpath'), 'echo "$2"');
  const runner = join(home, 'remote-runner.mjs');
  writeFileSync(runner, `import { appendFileSync, writeFileSync } from 'node:fs';
import { setupRemote } from ${JSON.stringify(new URL('../install-remote.mjs', import.meta.url).href)};
writeFileSync(process.env.TEST_REMOTE_LOG, '');
const result = setupRemote({ check: process.argv[2] === '--check', home: process.env.HOME, repo: process.env.TEST_REPO, distro: process.env.WSL_DISTRO_NAME, user: process.env.USER, available: () => true, print: text => appendFileSync(process.env.TEST_REMOTE_LOG, text + '\\n'),
run(file, args) {
  if (args[0] === 'status') return {status: 0, stdout: ${JSON.stringify(JSON.stringify(status()))}};
  if (args[0] === 'serve') return {status: 0, stdout: '{}'};
  const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  return command.includes('Start-Process') ? {status: 1, stderr: 'UAC declined'} : {status: 0, stdout: 'null'};
}});
if (result.created) process.exitCode = 10;
`);
  // The node mock must forward the pinned locale to the child Node process, so it keeps
  // the plain bash shebang; its own setlocale warning goes to stderr, which install.sh
  // never captures for the remote-installer call.
  writeFileSync(join(mocks, 'node'), `#!/bin/bash
if [[ "$1" == */deploy/windows/install-remote.mjs ]]; then
  shift; "$TEST_NODE" "$TEST_RUNNER" "$@"; rc=$?
  cat "$TEST_REMOTE_LOG"; exit "$rc"
fi
exec "$TEST_NODE" "$@"`, { mode: 0o755 });
  const run = check => spawnSync('bash', [join(repo, 'install.sh'), ...(check ? ['--check'] : [])], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, LC_ALL: 'zh_CN.UTF-8', HOME: home, USER: 'test', WSL_DISTRO_NAME: 'Ubuntu', WORKBENCH_PORT: '8790', PATH: `${mocks}:${home}/.local/bin:/usr/bin:/bin`, TEST_NODE: process.execPath, TEST_RUNNER: runner, TEST_TRACE: trace, TEST_HOME: home, TEST_REPO: repo, TEST_REMOTE_LOG: join(home, 'remote-output'), ...extraEnv },
  });
  return { home, trace, run };
}
test('install.sh --check reports remote states without npm, Windows writes or service calls', () => {
  const f = installerFixture(); const output = f.run(true);
  assert.equal(output.status, 0, output.stdout + output.stderr);
  for (const label of ['remote.json', 'Serve', 'Workbench Remote Gateway']) assert.ok(output.stdout.includes(label), output.stdout + output.stderr);
  assert.equal(existsSync(join(f.home, '.workbench')), false);
  assert.equal(existsSync(join(f.home, '.local')), false);
  assert.equal(existsSync(f.trace), false);
});
test('install.sh keeps running WB, requests restart, continues after refused UAC and reruns idempotently', () => {
  const f = installerFixture();
  const output = f.run(false);
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.ok(output.stdout.includes('运行 wb restart 使远程入口生效'));
  assert.ok(output.stdout.includes('UAC 被拒绝或安装失败'), output.stdout + output.stderr);
  assert.ok(output.stdout.includes('冒烟测试：/api/meta 返回 code: 0'));
  assert.ok(output.stdout.includes('首页 / 与静态资源 /assets/fixture.js 返回 200'));
  assert.match(readFileSync(f.trace, 'utf8'), /npm run build/);
  for (const path of ['/api/meta', '/', '/assets/fixture.js']) {
    assert.ok(readFileSync(f.trace, 'utf8').includes(`curl http://127.0.0.1:8790${path}`));
  }
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /wb (start|stop|restart)/);
  const path = join(f.home, '.workbench/remote.json'); const before = readFileSync(path, 'utf8');
  const again = f.run(false);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(again.stdout.includes('已有配置，未覆盖'));
});
test('install.sh uses existing smoke start/stop logic when WB is not running', () => {
  const f = installerFixture(false); const output = f.run(false);
  assert.equal(output.status, 0, output.stdout + output.stderr);
  const trace = readFileSync(f.trace, 'utf8');
  assert.match(trace, /wb start/); assert.match(trace, /wb stop/);
  assert.doesNotMatch(trace, /wb restart/);
  assert.ok(output.stdout.includes('已停止本次冒烟启动的服务'));
});

test('install.sh fails a build before installing links or touching services', () => {
  const f = installerFixture(true, { TEST_BUILD_FAIL: '1' }); const output = f.run(false);
  assert.equal(output.status, 1, output.stdout + output.stderr);
  assert.ok(output.stdout.includes('npm run build 失败，安装未完成'));
  assert.match(readFileSync(f.trace, 'utf8'), /npm run build/);
  assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /wb |powershell/);
  assert.equal(existsSync(join(f.home, '.local/bin')), false);
});
for (const name of ['TEST_HOME_STATUS', 'TEST_ASSET_STATUS']) {
  test(`install.sh rejects non-200 ${name} and preserves running WB`, () => {
    const f = installerFixture(true, { [name]: '404' }); const output = f.run(false);
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.ok(output.stdout.includes('首页或引用的静态资源未返回 200'));
    assert.doesNotMatch(readFileSync(f.trace, 'utf8'), /wb (start|stop|restart)/);
  });
}
