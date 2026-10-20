import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixture: an upstream repo and a clone with the versioned hooks; the build script just drops a marker file.
const base = mkdtempSync(join(tmpdir(), 'aireins-after-pull-test-'));
const upstream = join(base, 'upstream'), clone = join(base, 'clone');
const run = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, LANG: 'C' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
};
const commit = (path, message) => {
  mkdirSync(join(upstream, path, '..'), { recursive: true });
  writeFileSync(join(upstream, path), `${message}\n`);
  run(upstream, 'add', '--', path);
  run(upstream, 'commit', '-qm', message);
};
mkdirSync(upstream);
run(upstream, 'init', '-q', '-b', 'main');
writeFileSync(join(upstream, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'built\', \'\')"' } }));
run(upstream, 'add', '--', 'package.json');
run(upstream, 'commit', '-qm', 'baseline');
run(base, 'clone', '-q', upstream, clone);
mkdirSync(join(clone, 'scripts/git-hooks'), { recursive: true });
for (const hook of ['after-pull.sh', 'post-merge', 'post-rewrite']) {
  copyFileSync(new URL(`./git-hooks/${hook}`, import.meta.url), join(clone, 'scripts/git-hooks', hook));
}
run(clone, 'config', '--local', 'core.hooksPath', 'scripts/git-hooks');
const built = join(clone, 'built');

commit('docs/note.md', 'docs only');
let out = run(clone, 'pull', '-q', '--ff-only');
assert.ok(!existsSync(built), out);

commit('frontend/app.ts', 'frontend change');
out = run(clone, 'pull', '-q', '--ff-only');
assert.ok(existsSync(built), out);
assert.match(out, /Frontend built/);
rmSync(built);

commit('server/index.ts', 'backend change');
out = run(clone, 'pull', '-q', '--rebase');
assert.ok(!existsSync(built), out);
assert.match(out, /aireins restart/);

commit('shared/x.ts', 'shared change');
writeFileSync(join(clone, 'local.txt'), 'local\n');
run(clone, 'add', '--', 'local.txt');
run(clone, 'commit', '-qm', 'local commit');
out = run(clone, 'pull', '-q', '--rebase');
assert.ok(existsSync(built), out);
rmSync(built);

writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'built\', \'\')"' } }));
run(upstream, 'commit', '-qam', 'dependency change');
out = run(clone, 'pull', '-q', '--rebase');
assert.match(out, /Dependencies installed/);
assert.ok(existsSync(built), out);
rmSync(built);

run(clone, 'commit', '-q', '--amend', '-m', 'amended');
assert.ok(!existsSync(built));

rmSync(base, { recursive: true, force: true });
console.log('✅ after-pull hooks');
