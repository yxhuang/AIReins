import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const fixtures = mkdtempSync(join(tmpdir(), 'aireins-ai-usage-'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const summary = {
  updated_at: '2026-10-14T00:00:00+00:00',
  providers: [{ id: 'codex', name: 'Codex', plan: null, status: 'ok', error: null,
    fetched_at: '2026-10-14T00:00:00+00:00',
    windows: [{ id: '5h', label: '5 hours', used_pct: 12, resets_at: null, note: null }] }],
};
const deployStub = `#!/usr/bin/env bash
printf 'deploy\\n' >> "$TEST_CALLS"
[[ "\${TEST_DEPLOY_FAILURE:-false}" == false ]] || exit 1
touch "$TEST_READY"
`;
function fixture(name, options = {}) {
  const root = join(fixtures, name);
  const home = join(root, 'home');
  const installerRepo = join(root, 'AIReins');
  const commands = join(root, 'commands');
  const aiDir = options.defaultDir ? join(root, 'ai-usage') : join(root, 'custom-ai-usage');
  const callsPath = join(root, 'calls');
  const ready = join(root, 'ready');
  for (const directory of [home, commands, join(installerRepo, 'bin')]) mkdirSync(directory, { recursive: true });
  copyFileSync(join(repo, 'install.sh'), join(installerRepo, 'install.sh'));
  writeFileSync(callsPath, '');
  writeFileSync(join(root, 'summary.json'), JSON.stringify(options.summary ?? summary));
  writeFileSync(join(root, 'deploy-stub.sh'), deployStub);
  if (!options.missing) {
    mkdirSync(join(aiDir, 'deploy'), { recursive: true });
    writeFileSync(join(aiDir, 'pyproject.toml'), `[project]\nname = "${options.invalid ? 'other-project' : 'ai-usage'}"\nversion = "0.0.0"\n`);
    writeFileSync(join(aiDir, 'deploy/install.sh'), deployStub, { mode: 0o755 });
  }
  if (options.ready !== false) writeFileSync(ready, '');
  const manifestPath = join(home, '.workbench/pages/ai-usage/manifest.json');
  if (options.manifest !== undefined) {
    mkdirSync(join(home, '.workbench/pages/ai-usage'), { recursive: true });
    writeFileSync(manifestPath, options.manifest);
  }
  writeFileSync(join(installerRepo, 'bin/aireins'), `#!/bin/sh
if [ -n "\${BASH_SOURCE:-}" ]; then
  PLATFORM="\${TEST_PLATFORM:-linux}"
  port_pid() { [ "\${TEST_LISTENING:-false}" != true ] || printf '3456\\n'; }
  process_command() { printf 'python -m server.main\\n'; }
  return 0
fi
printf 'launcher %s\\n' "$*" >> "$TEST_CALLS"
[ "$1" = status ] || exit 99
printf 'Running (PID 12345)\\n'
`, { mode: 0o755 });
  const writeCommand = (name, script) => writeFileSync(join(commands, name), '#!/usr/bin/env bash\n' + script, { mode: 0o755 });
  for (const name of ['ss', 'rg', 'lsof', 'claude', 'codex', 'kimi']) writeCommand(name, 'exit 0\n');
  writeCommand('npm', 'printf "npm %s\\n" "$*" >> "$TEST_CALLS"\nexit 0\n');
  writeCommand('node', `if [[ "$1" == --version ]]; then echo v22.23.1
elif [[ "$1" == -e ]]; then exec ${quote(process.execPath)} "$@"
else printf 'node-script %s\\n' "$*" >> "$TEST_CALLS"; exit 0; fi
`);
  writeCommand('python3', 'printf "python %s\\n" "$*" >> "$TEST_CALLS"\nprintf "%s\\n" "${TEST_AI_PORT:-8788}"\n');
  writeCommand('uv', 'printf "uv %s\\n" "$*" >> "$TEST_CALLS"\nexit 0\n');
  writeCommand('systemctl', `printf 'systemctl %s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  *is-system-running*) [[ "\${TEST_SYSTEMD:-true}" == true ]] ;;
  *is-active*) [[ -f "$TEST_READY" ]] ;;
  *) exit 0 ;;
esac
`);
  writeCommand('readlink', `if [[ "$1" == /proc/3456/cwd ]]; then printf '%s\\n' "$TEST_AI_DIR"
else exec /usr/bin/readlink "$@"; fi
`);
  writeCommand('git', `printf 'git %s\\n' "$*" >> "$TEST_CALLS"
[[ "\${TEST_GIT_FAILURE:-false}" == false ]] || exit 1
if [[ "$1" == clone ]]; then
  target="\${@: -1}"
  mkdir -p "$target/deploy"
  printf '[project]\\nname = "ai-usage"\\n' > "$target/pyproject.toml"
  cp "$TEST_DEPLOY_STUB" "$target/deploy/install.sh"
fi
`);
  writeCommand('curl', `printf 'curl %s\\n' "$*" >> "$TEST_CALLS"
case "\${@: -1}" in
  */api/summary) [[ -f "$TEST_READY" ]] || exit 7; cat "$TEST_SUMMARY" ;;
  */api/meta) printf '{"code":0}\\n200' ;;
  */assets/test.js) printf 'console.log(1)\\n200' ;;
  */) printf '<script src="/assets/test.js"></script>\\n200' ;;
  *) exit 99 ;;
esac
`);
  const env = { ...process.env, HOME: home, WORKBENCH_HOME: join(home, '.workbench'),
    WORKBENCH_LOG: join(home, '.workbench/server.log'),
    PATH: `${commands}:${home}/.local/bin:/usr/bin:/bin`, LC_ALL: options.locale ?? 'C.UTF-8',
    TEST_CALLS: callsPath, TEST_READY: ready, TEST_SUMMARY: join(root, 'summary.json'),
    TEST_AI_DIR: aiDir, TEST_DEPLOY_STUB: join(root, 'deploy-stub.sh'),
    TEST_PLATFORM: options.platform ?? 'linux', TEST_LISTENING: String(options.listening ?? false),
    TEST_AI_PORT: String(options.port ?? 8788), TEST_SYSTEMD: String(options.systemd ?? true),
    TEST_DEPLOY_FAILURE: String(options.deployFailure ?? false), TEST_GIT_FAILURE: String(options.gitFailure ?? false),
  };
  delete env.AI_USAGE_REF;
  delete env.AI_USAGE_DIR;
  if (!options.defaultDir) env.AI_USAGE_DIR = aiDir;
  const run = (args = [], extraEnv = {}) => {
    const result = spawnSync('bash', [join(installerRepo, 'install.sh'), ...args], {
      env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  return { root, home, aiDir, manifestPath, run, calls: () => readFileSync(callsPath, 'utf8') };
}
const snapshot = path => !existsSync(path) ? null : readdirSync(path, { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const full = join(path, entry.name); const stat = lstatSync(full);
    return [entry.name, stat.mode, stat.mtimeMs, entry.isSymbolicLink() ? readlinkSync(full)
      : entry.isDirectory() ? snapshot(full) : readFileSync(full, 'utf8')];
  });
const notDeployed = f => {
  assert(!existsSync(f.manifestPath));
  assert(!/^(?:git|deploy|uv|systemctl)\b/m.test(f.calls()), f.calls());
};

const nonTty = fixture('non-tty');
assert(nonTty.run().includes('--with-ai-usage'));
notDeployed(nonTty);
const without = fixture('explicit-without');
without.run(['--without-ai-usage']);
notDeployed(without);
const invalid = fixture('foreign-directory', { invalid: true });
const invalidBefore = snapshot(invalid.aiDir);
assert.match(invalid.run(['--with-ai-usage']), /⚠.*ai-usage/);
assert.deepEqual(snapshot(invalid.aiDir), invalidBefore);
notDeployed(invalid);

const preserved = '{"custom":"existing manifest, keep exactly"}\n';
const existing = fixture('existing-manifest', { manifest: preserved });
existing.run(['--with-ai-usage']);
assert.equal(readFileSync(existing.manifestPath, 'utf8'), preserved);
assert(!/^deploy$/m.test(existing.calls()), existing.calls());
for (const [name, body] of [
  ['unrelated-api', { code: 0 }],
  ['invalid-provider', { updated_at: null, providers: [{}] }],
  ['invalid-window', { ...summary, providers: [{ ...summary.providers[0], windows: [{}] }] }],
]) {
  const rejected = fixture(name, { summary: body });
  assert.match(rejected.run(['--with-ai-usage']), /⚠.*ai-usage/);
  assert(!existsSync(rejected.manifestPath), name);
}

for (const [name, locale, body] of [
  ['valid-english', 'C.UTF-8', summary],
  ['valid-chinese', 'zh_CN.UTF-8', { updated_at: null, providers: [] }],
]) {
  const valid = fixture(name, { port: 9876, locale, summary: body });
  const output = valid.run(['--with-ai-usage']);
  const manifest = JSON.parse(readFileSync(valid.manifestPath, 'utf8'));
  assert.equal(manifest.id, 'ai-usage');
  assert.equal(manifest.name, locale.startsWith('zh') ? 'AI 用量' : 'AI usage');
  assert.equal(manifest.icon, '📊');
  assert.equal(manifest.type, 'iframe');
  assert.equal(new URL(manifest.url).origin, 'http://127.0.0.1:9876');
  assert.equal(manifest.healthCheck, 'http://127.0.0.1:9876/api/summary');
  assert.equal(manifest.maxWidth, '33%');
  assert.equal(manifest.proxy, true);
  assert.equal(typeof manifest.description, 'string');
  assert(!/proxy client|\/home\/|\/tmp\//.test(manifest.description));
  assert.match(output, /aireins restart/);
  assert(!/^deploy$/m.test(valid.calls()), valid.calls());
  assert(!/^git /m.test(valid.calls()), valid.calls());
  assert(valid.calls().includes('http://127.0.0.1:9876/api/summary'));
  if (!locale.startsWith('zh')) assert(!/\p{Script=Han}/u.test(output), output);
  const parsed = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    `import { scanPages } from './server/pages.ts'; const pages = scanPages(process.argv[1]); if (pages.length !== 1 || pages[0].id !== 'ai-usage') process.exit(1);`,
    join(valid.home, '.workbench/pages')], {
    cwd: repo, env: { ...process.env, HOME: valid.home, WORKBENCH_HOME: join(valid.home, '.workbench') }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(parsed.status, 0, parsed.stderr + parsed.stdout);
}

const clone = fixture('clone-default-dir', { missing: true, defaultDir: true, ready: false });
clone.run(['--with-ai-usage']);
assert(clone.calls().includes(`git clone https://github.com/yxhuang/ai-usage.git ${clone.aiDir}`), clone.calls());
assert.match(clone.calls(), /^git .*checkout.*e67d06b/m);
assert.match(clone.calls(), /^deploy$/m);
assert(existsSync(clone.manifestPath));
const pinned = fixture('clone-override', { missing: true, ready: false });
pinned.run(['--with-ai-usage'], { AI_USAGE_REF: 'custom-ref' });
assert.match(pinned.calls(), /^git .*checkout.*custom-ref/m);
const failedClone = fixture('clone-failure', { missing: true, gitFailure: true });
assert.match(failedClone.run(['--with-ai-usage']), /⚠.*ai-usage/);
assert(!existsSync(failedClone.manifestPath));
const failedDeploy = fixture('deploy-failure', { ready: false, deployFailure: true });
assert.match(failedDeploy.run(['--with-ai-usage']), /⚠.*ai-usage/);
assert(!existsSync(failedDeploy.manifestPath));
const noSystemd = fixture('unavailable-systemd', { ready: false, systemd: false });
assert.match(noSystemd.run(['--with-ai-usage']), /systemd/);
assert(!/^deploy$/m.test(noSystemd.calls()));
assert(!existsSync(noSystemd.manifestPath));
const mac = fixture('mac-manual', { platform: 'darwin', ready: false });
const macOutput = mac.run(['--with-ai-usage']);
assert(macOutput.includes('uv run python -m server'));
assert(!/^(?:systemctl|deploy)\b/m.test(mac.calls()), mac.calls());
assert(!existsSync(mac.manifestPath));

for (const [name, options, state] of [
  ['check-missing', { missing: true }, 'not found'],
  ['check-stopped', {}, 'found, not running'],
  ['check-running', { listening: true }, 'running, not integrated'],
  ['check-integrated', { listening: true, manifest: preserved }, 'integrated'],
]) {
  const checked = fixture(name, options);
  const before = [snapshot(checked.home), snapshot(checked.aiDir)];
  const output = checked.run(['--with-ai-usage', '--check']);
  assert(output.includes(`ai-usage: ${state}`), output);
  assert.deepEqual([snapshot(checked.home), snapshot(checked.aiDir)], before, `${name}: --check changed files`);
  assert(!/^(?:curl|git|deploy|uv|npm)\b/m.test(checked.calls()), checked.calls());
}
const checkedWithout = fixture('check-without');
assert(checkedWithout.run(['--check', '--without-ai-usage']).includes('ai-usage: found, not running'));
notDeployed(checkedWithout);
console.log('ai-usage installer OK: opt-in/skip, identity, safe cloning/deployment, validated manifests, bilingual output and read-only checks');
