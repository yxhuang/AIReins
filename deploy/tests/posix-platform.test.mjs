import './cli-rename.test.mjs';
import './install-posix-remote.test.mjs';
import './install-dependencies.test.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupPosixRemote } from '../install-posix-remote.mjs';

const repo = resolve(import.meta.dirname, '../..');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const shell = code => {
  const result = spawnSync('bash', ['-c', `source ${quote(join(repo, 'bin/aireins'))}\n${code}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
assert.equal(shell(`uname() { [[ "$1" == -s ]] && echo Darwin || echo 24.0; }; platform`), 'darwin');
assert.equal(shell(`uname() { [[ "$1" == -s ]] && echo Linux || echo 6.6-Microsoft-standard; }; platform`), 'wsl');
// WSLInterop also identifies WSL even when uname/env hints are absent.
const interop = shell(`[[ -e /proc/sys/fs/binfmt_misc/WSLInterop ]] && echo yes || echo no`);
assert.equal(shell(`uname() { [[ "$1" == -s ]] && echo Linux || echo 6.6-generic; }; platform`), interop === 'yes' ? 'wsl' : 'linux');
assert.equal(shell(`PLATFORM=linux; ss() { printf '%s\\n' 'LISTEN 0 10 127.0.0.1:48900 0.0.0.0:* users:(("node",pid=111,fd=20))' 'LISTEN 0 10 127.0.0.1:4890 0.0.0.0:* users:(("node",pid=222,fd=20))'; }; port_pid 4890`), '222');
assert.equal(shell(`PLATFORM=wsl; ss() { printf '%s\\n' 'LISTEN 0 10 127.0.0.1:4890 0.0.0.0:* users:(("node",pid=222,fd=20))'; }; port_pid 4890`), '222');
assert.equal(shell(`PLATFORM=darwin; lsof() { [[ "$*" == '-nP -a -iTCP@127.0.0.1:4890 -sTCP:LISTEN -t' ]] || return 1; echo 333; }; port_pid 4890`), '333');
assert.equal(shell(`PLATFORM=darwin; ps() { [[ "$*" == '-p 333 -o command=' ]] || return 1; echo "node --import tsx $REPO/server/index.ts"; }; is_ours 333 && echo ours`), 'ours');
assert.equal(shell(`PLATFORM=darwin; ps() { echo 'node /other/server/index.ts'; }; is_ours 333 || echo foreign`), 'foreign');
for (const platform of ['linux', 'wsl']) {
  assert.equal(shell(`PLATFORM=${platform}; process_command() { echo 'node --import tsx server/index.ts'; }; readlink() { echo "$REPO"; }; is_ours 333 && echo ours`), 'ours');
  assert.equal(shell(`PLATFORM=${platform}; process_command() { echo 'node --import tsx server/index.ts'; }; readlink() { echo '/other'; }; is_ours 333 || echo foreign`), 'foreign');
}
assert.equal(shell(`PLATFORM=darwin; open() { echo "$1"; }; open_browser; echo browser-ok`), 'browser-ok');

const temp = mkdtempSync(join(tmpdir(), 'wb-posix-platform-'));
const status = { BackendState: 'Running', Self: { DNSName: 'alice.example.ts.net.', UserID: 7 }, User: { 7: { LoginName: 'alice@example.test' } } };
for (const platform of ['linux', 'darwin']) {
  const home = join(temp, platform); const calls = []; const lines = [];
  let serve = {};
  const options = { home, platform, print: value => lines.push(value), run(file, args) {
    calls.push([file, args]);
    if (args.join(' ') === 'serve --bg http://127.0.0.1:8793') serve = {
      TCP: { 443: { HTTPS: true } }, Web: { 'alice.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8793' } } } },
    };
    return { status: 0, stdout: JSON.stringify(args[0] === 'status' ? status : serve) };
  } };
  assert.equal(setupPosixRemote({ ...options, check: true }).created, false);
  assert.equal(setupPosixRemote(options).created, true);
  const configPath = join(home, 'remote.json');
  const before = readFileSync(configPath, 'utf8');
  assert.equal(JSON.parse(before).terminal, false);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert(lines.some(line => line.includes('https://alice.example.ts.net')));
  assert(calls.some(([, args]) => args.join(' ') === 'serve status --json'));
  assert.equal(setupPosixRemote(options).created, false);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(calls.filter(([, args]) => args[1] === '--bg').length, 1, '首次启用后重跑不改 Serve');
}
const invalid = join(temp, 'invalid'); mkdirSync(invalid); writeFileSync(join(invalid, 'remote.json'), 'invalid');
setupPosixRemote({ home: invalid, run: () => ({ status: 0, stdout: JSON.stringify(status) }), print() {} });
assert.equal(readFileSync(join(invalid, 'remote.json'), 'utf8'), 'invalid');
let calls = [];
setupPosixRemote({ home: join(temp, 'mac-fallback'), check: true, platform: 'darwin', available: () => true, print() {}, run(file, args) {
  calls.push([file, args]); return file === 'tailscale' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: JSON.stringify(status) };
} });
assert.equal(calls[1][0], '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
assert(calls.every(([, args]) => args.join(' ') === 'status --json'));
// Test install --check without launching CLIs, Windows interop or Tailscale.
const fixture = join(temp, 'check-fixture'); const commands = join(fixture, 'commands');
mkdirSync(commands, { recursive: true }); mkdirSync(join(fixture, 'bin'));
copyFileSync(join(repo, 'bin/aireins'), join(fixture, 'bin/aireins'));
const original = spawnSync('git', ['show', 'HEAD:install.sh'], { cwd: repo, encoding: 'utf8' });
assert.equal(original.status, 0, original.stderr);
const beforeInstaller = join(fixture, 'install-before.sh');
writeFileSync(beforeInstaller, original.stdout.replaceAll('bin/workbench', 'bin/aireins'));
const afterInstaller = join(fixture, 'install-after.sh');
copyFileSync(join(repo, 'install.sh'), afterInstaller);
for (const name of ['ss', 'lsof', 'rg', 'npm', 'python3', 'curl', 'claude', 'codex', 'kimi', 'powershell.exe']) {
  writeFileSync(join(commands, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
}
writeFileSync(join(commands, 'node'), '#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then echo v22.23.1; else echo "remote probe stubbed: $1"; fi\n', { mode: 0o755 });
const checkInstaller = (path, os, release, distro = '', locale = { LC_ALL: 'zh_CN.UTF-8' }) => {
  writeFileSync(join(commands, 'uname'), `#!/usr/bin/env bash\nif [[ "$1" == -s ]]; then echo ${os}; else echo ${release}; fi\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: fixture, WORKBENCH_HOME: join(fixture, '.workbench'),
    PATH: `${commands}:${process.env.PATH}`, WSL_DISTRO_NAME: distro };
  delete env.LC_ALL; delete env.LC_MESSAGES; delete env.LANG;
  Object.assign(env, locale);
  const checked = spawnSync('bash', [path, '--check'], { encoding: 'utf8', env });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  return checked.stdout.replace(/remote probe stubbed: .*\n/, 'remote probe stubbed\n');
};
// 除命令改名和新增的命令链接体检外，中文版保留 HEAD 的既有输出。
const withoutCliCheck = output => output
  .replace(/^.*~\/\.local\/bin\/aireins.*\n/gm, '')
  .replace(/成功 \d+ 项，⚠ \d+ 项，❌ \d+ 项。/, '成功 / 警告 / 错误统计');
assert.equal(withoutCliCheck(checkInstaller(afterInstaller, 'Linux', '6.6-microsoft-standard', 'ubuntu')),
  withoutCliCheck(checkInstaller(beforeInstaller, 'Linux', '6.6-microsoft-standard', 'ubuntu')
    .replaceAll('Workbench', 'AIReins').replaceAll('wb status', 'aireins status')));
const macCheck = checkInstaller(afterInstaller, 'Darwin', '24.0');
assert(macCheck.includes('✅ macOS（实验性）'));
assert(macCheck.includes('✅ lsof 已安装'));
assert(!macCheck.includes('✅ ss 已安装'));
const linuxCheck = checkInstaller(afterInstaller, 'Linux', '6.6-generic');
if (interop !== 'yes') assert(linuxCheck.includes('非 WSL 环境'));
// 英文 locale：同一 fixture 下输出英文，退出码为 0，且 stdout 不含任何汉字。
const enCheck = checkInstaller(afterInstaller, 'Linux', '6.6-generic', '', { LC_ALL: 'en_US.UTF-8' });
for (const marker of ['AIReins install dependency check', '✅ Linux', 'Node v22.23.1 (≥ 22.12)',
  'At least one Agent CLI is installed; make sure you are logged in.',
  '~/.local/bin is not in PATH', 'Remote entry check (read-only)']) assert(enCheck.includes(marker), marker);
if (interop !== 'yes') assert(enCheck.includes('Not a WSL environment: skipping Windows tray and shortcut install.'));
assert(!/\p{Script=Han}/u.test(enCheck), enCheck);
// 只有 LANG（无 LC_ALL/LC_MESSAGES）为 zh 时仍输出中文，且与 LC_ALL 中文输出一致。
const langZhCheck = checkInstaller(afterInstaller, 'Linux', '6.6-generic', '', { LANG: 'zh_CN.UTF-8' });
assert(langZhCheck.includes('AIReins 安装依赖体检'));
assert.equal(langZhCheck, linuxCheck);
console.log('POSIX platform OK: detection, port/process branches, remote setup preserves existing config and only enables unconfigured Serve');
