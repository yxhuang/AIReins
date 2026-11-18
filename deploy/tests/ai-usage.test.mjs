import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const fixtures = mkdtempSync(join(tmpdir(), 'aireins-ai-usage-'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(name, options = {}) {
  const root = join(fixtures, name);
  const home = join(root, 'home');
  const installerRepo = join(root, 'AIReins');
  const commands = join(root, 'commands');
  const aiDir = join(root, 'ai-usage');
  const callsPath = join(root, 'calls');
  for (const directory of [home, commands, join(installerRepo, 'bin')]) mkdirSync(directory, { recursive: true });
  copyFileSync(join(repo, 'install.sh'), join(installerRepo, 'install.sh'));
  writeFileSync(callsPath, '');
  const manifestPath = join(home, '.workbench/pages/ai-usage/manifest.json');
  if (options.manifest !== undefined) {
    mkdirSync(join(home, '.workbench/pages/ai-usage'), { recursive: true });
    writeFileSync(manifestPath, options.manifest);
  }
  if (options.customPage) {
    mkdirSync(join(home, '.workbench/pages/custom'), { recursive: true });
    writeFileSync(join(home, '.workbench/pages/custom/manifest.json'), JSON.stringify(options.customPage));
  }
  writeFileSync(join(installerRepo, 'bin/aireins'), `#!/bin/sh
if [ "\${BASH_SOURCE:-$0}" != "$0" ]; then
  PLATFORM="\${TEST_PLATFORM:-linux}"
  return 0
fi
printf 'launcher %s\\n' "$*" >> "$TEST_CALLS"
[ "$1" = status ] || exit 99
printf 'Running (PID 12345)\\n'
`, { mode: 0o755 });
  const writeCommand = (cmdName, script) => writeFileSync(join(commands, cmdName), '#!/usr/bin/env bash\n' + script, { mode: 0o755 });
  for (const cmdName of ['ss', 'rg', 'lsof', 'claude', 'agy', 'codex', 'kimi', 'python3']) writeCommand(cmdName, 'exit 0\n');
  writeCommand('npm', 'printf "npm %s\\n" "$*" >> "$TEST_CALLS"\nexit 0\n');
  writeCommand('node', `if [[ "$1" == --version ]]; then echo v22.23.1
elif [[ "$1" == -e ]]; then exec ${quote(process.execPath)} "$@"
else printf 'node-script %s\\n' "$*" >> "$TEST_CALLS"; exit 0; fi
`);
  writeCommand('uv', 'printf "uv %s\\n" "$*" >> "$TEST_CALLS"\nexit 99\n');
  writeCommand('systemctl', 'printf "systemctl %s\\n" "$*" >> "$TEST_CALLS"\nexit 99\n');
  writeCommand('git', 'printf "git %s\\n" "$*" >> "$TEST_CALLS"\nexit 0\n');
  writeCommand('curl', `printf 'curl %s\\n' "$*" >> "$TEST_CALLS"
case "\${@: -1}" in
  */api/meta) printf '{"code":0}\\n200' ;;
  */assets/test.js) printf 'console.log(1)\\n200' ;;
  */) printf '<script src="/assets/test.js"></script>\\n200' ;;
  *) exit 99 ;;
esac
`);
  const env = {
    ...process.env,
    HOME: home,
    WORKBENCH_HOME: join(home, '.workbench'),
    WORKBENCH_LOG: join(home, '.workbench/server.log'),
    PATH: `${commands}:${home}/.local/bin:/usr/bin:/bin`,
    LC_ALL: options.locale ?? 'C.UTF-8',
    TEST_CALLS: callsPath,
    TEST_PLATFORM: options.platform ?? 'linux',
    AI_USAGE_DIR: aiDir,
  };
  const run = (args = [], expectedStatus = 0) => {
    const result = spawnSync('bash', [join(installerRepo, 'install.sh'), ...args], {
      env, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}\n${result.stdout}`);
    return result.stdout + result.stderr;
  };
  return { root, home, aiDir, manifestPath, run, calls: () => readFileSync(callsPath, 'utf8') };
}

const snapshot = path => !existsSync(path) ? null : readdirSync(path, { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const full = join(path, entry.name); const stat = lstatSync(full);
    return [entry.name, stat.mode, stat.mtimeMs, entry.isSymbolicLink() ? readlinkSync(full)
      : entry.isDirectory() ? snapshot(full) : readFileSync(full, 'utf8')];
  });
const aiCalls = f => f.calls().replace(/^git -C \S+ (?:rev-parse --git-dir|config --local (?:--get )?core\.hooksPath\b).*\n/gm, '');

// Default install: no ai-usage clone/uv/systemd, no manifest created.
const def = fixture('default-install');
def.run();
assert(!existsSync(def.manifestPath));
assert(!existsSync(def.aiDir));
assert(!/^(?:git|uv|systemctl)\b/m.test(aiCalls(def)), aiCalls(def));

// --with-ai-usage prints bilingual migration notice, leaves existing manifest untouched, and never deploys Python/uv/systemd.
const preserved = '{"id":"ai-usage","name":"AI 用量","icon":"📊","type":"iframe","url":"http://127.0.0.1:8788","proxy":true}\n';
for (const [locale, expected] of [
  ['C.UTF-8', /built into AIReins.*Antigravity/],
  ['zh_CN.UTF-8', /已内置于 AIReins.*Antigravity/],
]) {
  const migrated = fixture(`with-flag-${locale}`, {
    locale,
    manifest: preserved,
    customPage: { id: 'grafana', name: 'Grafana', icon: '📈', type: 'iframe', url: 'https://example.com' },
  });
  const output = migrated.run(['--with-ai-usage']);
  assert.match(output, expected);
  if (!locale.startsWith('zh')) assert(!/\p{Script=Han}/u.test(output), output);
  assert.equal(readFileSync(migrated.manifestPath, 'utf8'), preserved, 'existing manifest file preserved on disk');
  assert(!/^(?:git|uv|systemctl)\b/m.test(aiCalls(migrated)), aiCalls(migrated));

  // Server scanPages skips legacy ai-usage manifest while keeping other extension pages.
  const parsed = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    `import { scanPages } from './server/pages.ts'; const pages = scanPages(process.argv[1]); if (pages.length !== 1 || pages[0].id !== 'grafana') process.exit(1);`,
    join(migrated.home, '.workbench/pages')], {
    cwd: repo, env: { ...process.env, HOME: migrated.home, WORKBENCH_HOME: join(migrated.home, '.workbench') }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(parsed.status, 0, parsed.stderr + parsed.stdout);
}

// --without-ai-usage succeeds silently without touching anything.
const without = fixture('without-flag');
without.run(['--without-ai-usage']);
assert(!existsSync(without.manifestPath));

// Conflicting flags still exit 2.
const conflict = fixture('conflict-flags');
conflict.run(['--with-ai-usage', '--without-ai-usage'], 2);
conflict.run(['--update', '--with-ai-usage'], 2);

// --check is strictly read-only and reports built-in usage status in both locales.
for (const locale of ['C.UTF-8', 'zh_CN.UTF-8']) {
  const checked = fixture(`check-${locale}`, { locale, manifest: preserved });
  const before = snapshot(checked.home);
  const output = checked.run(['--check', '--with-ai-usage']);
  assert.match(output, /ai-usage/);
  if (!locale.startsWith('zh')) assert(!/\p{Script=Han}/u.test(output), output);
  assert.deepEqual(snapshot(checked.home), before, '--check must not modify files');
  assert(!/^(?:curl|git|uv|systemctl|npm)\b/m.test(checked.calls()), checked.calls());
}

console.log('ai-usage migration installer OK: built-in notice, legacy manifest skip, read-only checks, zero Python/uv/systemd dependency');
