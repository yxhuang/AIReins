import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '@lydell/node-pty';

// Execute the actual dependency section only; every package/CLI command is a fixture.
const installer = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'aireins-install-deps-'));
let seq = 0;
async function check({ tty = true, platform = 'darwin', brew = true, answer = '', failed = false,
  readonly = false, version = 'v20.0.0', rg = false, locale = 'en_US.UTF-8' } = {}) {
  const root = join(temp, String(seq++)); const commands = join(root, 'commands');
  mkdirSync(commands, { recursive: true }); mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/aireins'), 'PLATFORM="${TASK_PLATFORM}"\n');
  const script = join(root, 'install.sh');
  writeFileSync(script, installer.slice(0, installer.indexOf('for dep in python3 curl')) + '\nsummary\n(( ${#errors[@]} == 0 ))\n');
  const executable = (name, code) => writeFileSync(join(commands, name), `#!/bin/bash\n${code}\n`, { mode: 0o755 });
  symlinkSync('/usr/bin/dirname', join(commands, 'dirname'));
  executable('node', 'if [[ -f "$TASK_NODE_READY" ]]; then echo v22.23.1; else echo "$TASK_NODE_VERSION"; fi');
  for (const dep of ['npm', 'lsof', 'ss', ...(rg ? ['rg'] : [])]) executable(dep, 'exit 0');
  if (brew) executable('brew', `printf '%s\\n' "$*" >> "$TASK_BREW_LOG"
    [[ "$TASK_BREW_FAILED" == false ]] || exit 1
    for package in "$@"; do
      if [[ "$package" == node ]]; then : > "$TASK_NODE_READY"; fi
      if [[ "$package" == ripgrep ]]; then
        printf '#!/bin/bash\\nexit 0\\n' > "$TASK_RG_COMMAND"
        /bin/chmod +x "$TASK_RG_COMMAND"
      fi
    done`);
  const env = { ...process.env, PATH: commands, HOME: root, LC_ALL: locale,
    TASK_PLATFORM: platform, TASK_NODE_VERSION: version, TASK_NODE_READY: join(root, 'node-ready'),
    TASK_BREW_LOG: join(root, 'brew-log'), TASK_RG_COMMAND: join(commands, 'rg'), TASK_BREW_FAILED: String(failed) };
  const args = [script, ...(readonly ? ['--check'] : [])];
  let result;
  if (!tty) result = spawnSync('/bin/bash', args, { env, encoding: 'utf8', timeout: 8000 });
  else result = await new Promise((resolve, reject) => {
    const pty = spawn('/bin/bash', args, { env, cwd: root, name: 'xterm', cols: 200, rows: 30 });
    let stdout = ''; let answered = false;
    const timeout = setTimeout(() => { pty.kill(); reject(new Error('dependency fixture timed out')); }, 8000);
    pty.onData(data => {
      stdout += data;
      if (!answered && stdout.includes('[Y/n]')) { answered = true; pty.write(`${answer}\r`); }
    });
    pty.onExit(({ exitCode }) => { clearTimeout(timeout); resolve({ status: exitCode, stdout }); });
  });
  let calls = '';
  try { calls = readFileSync(env.TASK_BREW_LOG, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}
for (const answer of ['', 'Y']) {
  const result = await check({ answer });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.calls, 'install node ripgrep\n', '所有缺失依赖只询问/安装一次');
  assert.equal((result.stdout.match(/\[Y\/n\]/g) ?? []).length, 1);
  assert(result.stdout.includes('Node v22.23.1'), '安装后重新检测 Node');
  assert(result.stdout.includes('rg installed'), '安装后重新检测 rg');
}
assert.equal((await check({ version: '', rg: true })).calls, 'install node\n', '未安装 Node 也自动安装');
assert.equal((await check({ version: 'v22.12.0' })).calls, 'install ripgrep\n', '只装缺失的依赖');
for (const options of [{ answer: 'n' }, { tty: false }, { brew: false }, { readonly: true }, { platform: 'linux' }, { platform: 'wsl' }]) {
  const result = await check(options);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.calls, '', '拒绝、非 TTY、无 brew、--check、Linux/WSL 不调用 brew');
}
const failed = await check({ failed: true });
assert.equal(failed.status, 1, failed.stdout);
assert.equal(failed.calls, 'install node ripgrep\n');
assert(failed.stdout.includes('Homebrew install failed'));
assert(failed.stdout.includes('brew install ripgrep'), '失败后仍给手动提示');
const chinese = await check({ locale: 'zh_CN.UTF-8' });
assert.equal(chinese.status, 0, chinese.stdout);
assert(chinese.stdout.includes('通过 Homebrew 安装'));
assert(chinese.stdout.includes('重新检查依赖'));
console.log('Install dependencies OK: stubbed TTY confirmation/recheck, failure/decline, --check/non-TTY/no-brew, Linux/WSL, bilingual');
