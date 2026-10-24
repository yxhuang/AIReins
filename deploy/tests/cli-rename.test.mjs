import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const fixture = mkdtempSync(join(tmpdir(), 'aireins-cli-rename-'));
const commands = join(fixture, 'commands');
const installerRepo = join(fixture, 'repo');
mkdirSync(commands);
mkdirSync(join(installerRepo, 'bin'), { recursive: true });
copyFileSync(join(repo, 'install.sh'), join(installerRepo, 'install.sh'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = join(installerRepo, 'bin/aireins');
const calls = join(fixture, 'launcher-calls');
writeFileSync(launcher, `#!/bin/sh
PLATFORM=linux
[ "\${BASH_SOURCE:-$0}" != "$0" ] && return 0
printf '%s\\n' "$*" >> ${quote(calls)}
[ "$1" = status ] || exit 99
printf 'Running (PID 12345)\\n'
`, { mode: 0o755 });
for (const name of ['npm', 'ss', 'rg', 'python3', 'claude', 'codex', 'kimi']) {
  writeFileSync(join(commands, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
}
// Only Node expressions used by the smoke check execute; the remote installer is a stub.
writeFileSync(join(commands, 'node'), `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo v22.23.1
elif [[ "$1" == -e ]]; then exec ${quote(process.execPath)} "$@"
else exit 0; fi
`, { mode: 0o755 });
writeFileSync(join(commands, 'curl'), `#!/usr/bin/env bash
case "\${@: -1}" in
  */api/meta) printf '{"code":0}\\n200' ;;
  */assets/test.js) printf 'console.log(1)\\n200' ;;
  */) printf '<script src="/assets/test.js"></script>\\n200' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
const run = (home, args = [], locale = 'C.UTF-8', expected = 0) => {
  const result = spawnSync('bash', [join(installerRepo, 'install.sh'), ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, WORKBENCH_HOME: join(home, '.workbench'),
      WORKBENCH_LOG: join(home, '.workbench/server.log'),
      WSL_DISTRO_NAME: 'fixture',
      PATH: `${commands}:${home}/.local/bin:/usr/bin:/bin`, LC_ALL: locale },
  });
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return result.stdout;
};
const snapshot = path => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .map(entry => {
    const full = join(path, entry.name); const stat = lstatSync(full);
    return [entry.name, stat.mode, stat.mtimeMs, entry.isSymbolicLink() ? readlinkSync(full)
      : entry.isDirectory() ? snapshot(full) : readFileSync(full, 'utf8')];
  });
for (const [name, targetKind] of [
  ['old-absolute', 'old'], ['new-absolute', 'new'], ['old-relative', 'relative-old'],
  ['new-relative', 'relative-new'], ['third-party', 'third-party'], ['file', 'file'], ['directory', 'directory'],
]) {
  const home = join(fixture, name); const local = join(home, '.local/bin');
  mkdirSync(local, { recursive: true });
  const oldTarget = join(installerRepo, 'bin/workbench'); // Historical, now missing: still ours.
  const target = targetKind === 'old' ? oldTarget : targetKind === 'new' ? launcher
    : targetKind === 'relative-old' ? relative(local, oldTarget)
    : targetKind === 'relative-new' ? relative(local, launcher) : '/other/repo/bin/aireins';
  for (const oldName of ['wb', 'workbench']) {
    const link = join(local, oldName);
    if (targetKind === 'file') writeFileSync(link, 'user command\n');
    else if (targetKind === 'directory') mkdirSync(link);
    else symlinkSync(target, link);
  }
  const before = snapshot(home);
  const checkOutput = run(home, ['--check']);
  assert.deepEqual(snapshot(home), before, `${name}: --check changed HOME`);
  assert(checkOutput.includes('~/.local/bin/aireins is not installed'));
  const output = run(home, [], name === 'old-relative' ? 'zh_CN.UTF-8' : 'C.UTF-8');
  assert.equal(readlinkSync(join(local, 'aireins')), launcher);
  const ours = ['old', 'new', 'relative-old', 'relative-new'].includes(targetKind);
  for (const oldName of ['wb', 'workbench']) {
    const path = join(local, oldName);
    if (ours) {
      assert(!existsSync(path));
      assert(!readdirSync(local).includes(oldName), `${name}: dangling old link was not removed`);
      assert(output.includes(`old command link ${path}; use aireins.`) || output.includes(`旧命令链接 ${path}；请使用 aireins。`));
    } else if (targetKind === 'file') assert.equal(readFileSync(path, 'utf8'), 'user command\n');
    else if (targetKind === 'directory') assert(lstatSync(path).isDirectory());
    else assert.equal(readlinkSync(path), target);
    if (!ours) assert(output.includes(`Keeping ${path}: it is not this repository's command link.`));
  }
  const installed = snapshot(home);
  assert(run(home, ['--check']).includes('~/.local/bin/aireins installed'));
  assert.deepEqual(snapshot(home), installed, `${name}: installed --check changed HOME`);
}
const missingHome = join(fixture, 'check-no-bin'); mkdirSync(missingHome);
const missingBefore = snapshot(missingHome);
run(missingHome, ['--check']);
assert.deepEqual(snapshot(missingHome), missingBefore, '--check created ~/.local/bin');

// --update refreshes installation without smoke-starting/stopping a backend, optional setup or alias cleanup.
const updateHome = join(fixture, 'update-home');
mkdirSync(join(updateHome, '.local/bin'), { recursive: true });
symlinkSync(join(installerRepo, 'bin/workbench'), join(updateHome, '.local/bin/wb'));
const beforeUpdateCalls = readFileSync(calls, 'utf8');
const updateOutput = run(updateHome, ['--update']);
assert.equal(readFileSync(calls, 'utf8'), beforeUpdateCalls, '--update must not probe/start/stop the backend');
assert.equal(readlinkSync(join(updateHome, '.local/bin/wb')), join(installerRepo, 'bin/workbench'));
assert(!updateOutput.includes('Configuring the Tailscale remote entry'), 'no new remote setup');
assert(!updateOutput.includes('Smoke test'), 'no smoke server');
assert(!existsSync(join(updateHome, '.workbench/pages/ai-usage/manifest.json')), 'no new optional page');

// A required Windows tray failure is fatal in update mode (all commands below are shell fixtures).
const windowsCwd = join(fixture, 'windows-drive');
const trayCalls = join(fixture, 'tray-calls');
mkdirSync(windowsCwd);
// Native Linux/macOS runners have no /mnt/c; model it without changing other cd calls.
writeFileSync(launcher, readFileSync(launcher, 'utf8').replace('PLATFORM=linux', `PLATFORM=wsl
cd() {
  if [[ "$#" == 1 && "$1" == /mnt/c ]]; then builtin cd -- ${quote(windowsCwd)}
  else builtin cd "$@"; fi
}`));
writeFileSync(join(commands, 'wslpath'), '#!/usr/bin/env bash\nprintf "%s\\n" "$2"\n', { mode: 0o755 });
const trayStub = status => `#!/usr/bin/env bash
pwd -P >> ${quote(trayCalls)}
printf '%s\\n' "$*" >> ${quote(trayCalls)}
exit ${status}
`;
writeFileSync(join(commands, 'powershell.exe'), trayStub(7), { mode: 0o755 });
assert.match(run(updateHome, ['--update'], 'C.UTF-8', 1), /Windows tray installation failed/);
writeFileSync(join(commands, 'powershell.exe'), trayStub(0), { mode: 0o755 });
assert.match(run(updateHome, ['--update']), /Windows tray and shortcuts installed/);
const trayInvocations = readFileSync(trayCalls, 'utf8').trim().split('\n');
assert.equal(trayInvocations.length, 4, 'both update attempts must reach the tray command');
for (let i = 0; i < trayInvocations.length; i += 2) {
  assert.equal(trayInvocations[i], realpathSync(windowsCwd), 'tray command must run from the simulated Windows drive');
  assert.match(trayInvocations[i + 1], /-File .*\/deploy\/windows\/install-tray\.ps1 -Distro fixture -WbPath .*\/bin\/aireins$/);
}
assert.equal(readFileSync(calls, 'utf8'), beforeUpdateCalls);
assert(readFileSync(calls, 'utf8').trim().split('\n').every(command => command === 'status'));
console.log('CLI rename OK: owned absolute/relative dangling links removed, foreign links/files/directories preserved, --check read-only');
