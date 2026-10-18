import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'aireins-privacy-test-'));
const script = fileURLToPath(new URL('./check-privacy.mjs', import.meta.url));
const git = (...args) => {
  const result = spawnSync('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const scan = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
const expect = (status, ...args) => {
  const result = scan(...args);
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result;
};
git('init', '-q');
mkdirSync(join(root, 'scripts'));
copyFileSync(script, join(root, 'scripts/check-privacy.mjs'));
copyFileSync(fileURLToPath(import.meta.url), join(root, 'scripts/check-privacy.test.mjs'));
git('add', '--', 'scripts'); // New checker sources must also pass when tracked.
const name = 'example 中文.txt', file = join(root, name);
writeFileSync(file, '/home/user/project\n/Users/runner/project\nC:\\Users\\demo\\project\n');
git('add', '--', name);
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture baseline');
expect(0); expect(0, '--staged');

// Construct a synthetic negative control without putting a flagged path in this source.
const scratchPath = ['/tmp', 'claude-1000', 'x'].join('/');
writeFileSync(file, scratchPath + '\n');
expect(1); expect(0, '--staged'); // Unstaged content must not enter the staged scan.
git('add', '--', name);
const indexBefore = readFileSync(join(root, '.git/index'));
assert.match(expect(1, '--staged').stderr, /example 中文\.txt:1: claude-temp/);
assert.deepEqual(readFileSync(join(root, '.git/index')), indexBefore, 'scanner must not change the index');
writeFileSync(file, 'clean worktree\n');
expect(0); expect(1, '--staged'); // Staged content, not the clean worktree, is checked.
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'synthetic negative baseline');
git('add', '--', name);
expect(0, '--staged'); // Removed private-looking lines are not additions.

const owner = 'private-owner';
for (const input of [`/home/${owner}/project`, `/Users/${owner}/project`, `/mnt/c/Users/${owner}/project`,
  `C:\\Users\\${owner}\\project`, `C:\\\\Users\\\\${owner}\\\\project`, `-home-${owner}--repo`,
  ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  ...['sk-ant-', 'ghp_', 'github_pat_', 'AKIA'].map(prefix => prefix + 'A'.repeat(prefix === 'AKIA' ? 16 : 40))]) {
  writeFileSync(file, input + '\n');
  expect(1);
}
writeFileSync(file, 'ordinary line\nINTERNAL_ONLY_MARKER\n');
const patterns = join(root, 'private-patterns.txt');
writeFileSync(patterns, '# local rules\n\ninternal_only_marker\n');
expect(0);
assert.match(expect(1, '--patterns', patterns).stderr, /private-pattern-3/);
git('add', '--', name);
expect(1, '--staged', '--patterns', patterns);
writeFileSync(patterns, '[invalid\n');
expect(1, '--patterns', patterns);
expect(1, '--unknown');
writeFileSync(file, Buffer.from([0, 255, 1]));
assert.match(expect(0).stderr, /not verified/);

// Keep every Git write below inside this disposable fixture repository.
const commit = message => {
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', message);
  return git('rev-parse', 'HEAD');
};
writeFileSync(file, 'ordinary line\n');
git('add', '--', name);
const clean = commit('clean baseline');
git('config', '--local', 'user.name', 'Fixture');
git('config', '--local', 'user.email', 'fixture@example.test');
writeFileSync(patterns, 'internal_only_marker\n');
const marker = ['INTERNAL', 'ONLY', 'MARKER'].join('_');

// A renamed filename is checked even when its content is empty or binary.
const publicName = 'public.txt', privateName = `${marker}.txt`;
writeFileSync(join(root, publicName), '');
git('add', '--', publicName);
commit('public empty file');
renameSync(join(root, publicName), join(root, privateName));
git('add', '--', publicName, privateName);
for (const args of [[], ['--staged']]) {
  const result = expect(1, ...args, '--patterns', patterns);
  assert.match(result.stderr, /<filename>:1: private-pattern-1/);
  assert.ok(!result.stderr.includes(marker), 'private filenames must be redacted');
}
unlinkSync(join(root, privateName));
assert.match(expect(1, '--patterns', patterns).stderr, /<filename>:1: private-pattern-1/);
writeFileSync(join(root, privateName), '');
commit('synthetic private filename');
renameSync(join(root, privateName), join(root, publicName));
git('add', '--', privateName, publicName);
commit('public filename again');

// Type changes must inspect the staged symlink target, not the former file.
unlinkSync(join(root, publicName));
symlinkSync(`/home/${owner}/project`, join(root, publicName));
git('add', '--', publicName);
assert.match(expect(1, '--staged').stderr, /public\.txt:1: home-path/);
commit('synthetic symlink target');
unlinkSync(join(root, publicName));
writeFileSync(join(root, publicName), 'ordinary line\n');
git('add', '--', publicName);
commit('ordinary file again');

// Force-adding HANDOFF is forbidden, including when unchanged in the index.
writeFileSync(join(root, '.gitignore'), 'HANDOFF.md\n');
writeFileSync(join(root, 'HANDOFF.md'), 'local state\n');
git('add', '-f', '--', 'HANDOFF.md');
assert.match(expect(1).stderr, /HANDOFF\.md:1: forbidden-file/);
assert.match(expect(1, '--staged').stderr, /HANDOFF\.md:1: forbidden-file/);
const handoffCommit = commit('synthetic forbidden file');
assert.match(expect(1, '--staged').stderr, /forbidden-file/);
unlinkSync(join(root, 'HANDOFF.md'));
git('add', '--', 'HANDOFF.md');
expect(0, '--staged');
commit('remove local state');
assert.match(expect(1, '--range', `${handoffCommit}^..HEAD`).stderr, /HANDOFF\.md:1: forbidden-file/);

for (const [binaryName, bytes] of [['image.bin', [0, 255]], ['non-utf8.txt', [255, 254]]]) {
  writeFileSync(join(root, binaryName), Buffer.from(bytes));
  git('add', '--', binaryName);
}
for (const args of [[], ['--staged']]) {
  const result = expect(0, ...args);
  assert.match(result.stderr, /请人工检查/);
  assert.match(result.stderr, /image\.bin/);
  assert.match(result.stderr, /non-utf8\.txt/);
  assert.match(result.stdout, /2 skipped files remain unverified/);
}
const binaryCommit = commit('binary fixtures');
assert.match(expect(0, '--range', `${binaryCommit}^..HEAD`).stderr, /not verified/);

// Deleting a value later must not hide the earlier commit in the range.
const before = git('rev-parse', 'HEAD');
writeFileSync(file, `${marker}\n`);
git('add', '--', name);
const leaked = commit('synthetic private content');
writeFileSync(file, 'ordinary line\n');
git('add', '--', name);
const removed = commit('remove synthetic private content');
const history = expect(1, '--range', `${before}..${removed}`, '--patterns', patterns);
assert.match(history.stderr, new RegExp(`${leaked}:${name}:1: private-pattern-1`));
assert.ok(!history.stderr.includes(marker));
expect(0, '--range', `${removed}..${removed}`, '--patterns', patterns);
expect(0, '--range', `${removed}^..${removed}`, '--patterns', patterns);

// Git attributes and pathspec syntax cannot hide otherwise valid UTF-8 text.
writeFileSync(join(root, '.gitattributes'), 'attribute.txt -diff\n');
git('add', '--', '.gitattributes');
const edgeBase = commit('text diff attribute');
for (const edgeName of ['attribute.txt', ':(exclude)*']) {
  writeFileSync(join(root, edgeName), `${marker}\n`);
  git('add', '--', edgeName);
  assert.match(expect(1, '--staged', '--patterns', patterns).stderr, /private-pattern-1/);
}
const edgeLeak = commit('synthetic attribute and pathspec content');
for (const edgeName of ['attribute.txt', ':(exclude)*']) {
  writeFileSync(join(root, edgeName), 'ordinary line\n');
  git('add', '--', edgeName);
}
commit('remove synthetic edge content');
const edgeResult = expect(1, '--range', `${edgeBase}..HEAD`, '--patterns', patterns);
for (const edgeName of ['attribute.txt', ':(exclude)*']) {
  assert.ok(edgeResult.stderr.includes(`${edgeLeak}:${edgeName}:1: private-pattern-1`));
}
const first = git('rev-list', '--max-parents=0', 'HEAD');
expect(0, '--range', `${'0'.repeat(40)}..${first}`);
assert.match(expect(1, '--range', `${'0'.repeat(40)}..${removed}`, '--patterns', patterns).stderr, new RegExp(leaked));

git('-c', `user.name=${marker}`, '-c', `user.email=${marker}@example.test`, 'commit', '--allow-empty', '-qm', marker);
const metadataCommit = git('rev-parse', 'HEAD');
const metadata = expect(1, '--range', `${removed}..${metadataCommit}`, '--patterns', patterns);
for (const field of ['author-name', 'author-email', 'committer-name', 'committer-email', 'commit-message']) {
  assert.ok(metadata.stderr.includes(`<${field}>:1: private-pattern-1`));
}
assert.ok(!metadata.stderr.includes(marker));

// Merge resolution content is compared to the first parent, not omitted.
const branch = git('symbolic-ref', '--short', 'HEAD');
git('checkout', '-qb', 'privacy-side', clean);
writeFileSync(join(root, 'side.txt'), 'side\n');
git('add', '--', 'side.txt');
commit('side branch');
git('checkout', '-q', branch);
git('merge', '--no-ff', '--no-commit', 'privacy-side');
writeFileSync(join(root, 'side.txt'), `${marker}\n`);
git('add', '--', 'side.txt');
const merge = commit('merge resolution');
assert.match(expect(1, '--range', `${merge}^1..${merge}`, '--patterns', patterns).stderr, new RegExp(`${merge}:side.txt:1: private-pattern-1`));
expect(1, '--range', 'HEAD...HEAD');
expect(1, '--range');
expect(1, '--staged', '--range', 'HEAD..HEAD');

const message = join(root, '.git/COMMIT_EDITMSG');
writeFileSync(message, marker);
assert.match(expect(1, '--commit-msg', message, '--patterns', patterns).stderr, /<commit-message>:1: private-pattern-1/);
writeFileSync(message, 'ordinary message\n');
expect(0, '--commit-msg', message);
for (const field of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
  const result = spawnSync(process.execPath, [script, '--commit-msg', message, '--patterns', patterns], {
    cwd: root, encoding: 'utf8', env: { ...process.env, [field]: field.endsWith('EMAIL') ? `${marker}@example.test` : marker },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /<GIT_(?:AUTHOR|COMMITTER)_IDENT>:1: private-pattern-1/);
  assert.ok(!result.stderr.includes(marker));
}

// Exercise the versioned /bin/sh hooks and installer only in the fixture.
const hooks = join(root, 'scripts/git-hooks');
mkdirSync(hooks);
for (const hook of ['pre-commit', 'commit-msg', 'check-privacy.sh']) {
  copyFileSync(new URL(`./git-hooks/${hook}`, import.meta.url), join(hooks, hook));
}
const runHook = (hook, ...args) => spawnSync('/bin/sh', [join(hooks, hook), ...args], { cwd: root, encoding: 'utf8' });
for (const hook of ['pre-commit', 'commit-msg']) {
  const result = runHook(hook, message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning/i);
}
git('config', '--local', 'aireins.privatePatterns', join(root, 'missing-patterns.txt'));
assert.match(runHook('commit-msg', message).stderr, /warning/i);
const spacedPatterns = join(root, 'private patterns.txt');
copyFileSync(patterns, spacedPatterns);
git('config', '--local', 'aireins.privatePatterns', spacedPatterns);
writeFileSync(message, marker);
const hookMessage = runHook('commit-msg', message);
assert.equal(hookMessage.status, 1, hookMessage.stderr);
assert.ok(!hookMessage.stderr.includes(marker));
writeFileSync(file, `${marker}\n`);
git('add', '--', name);
assert.equal(runHook('pre-commit').status, 1);
const install = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts['hooks:install'];
const installed = spawnSync('/bin/sh', ['-c', install], { cwd: root, encoding: 'utf8' });
assert.equal(installed.status, 0, installed.stderr);
assert.equal(git('config', '--local', '--get', 'core.hooksPath'), 'scripts/git-hooks');
const realCommit = (...args) => spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', ...args], { cwd: root, encoding: 'utf8' });
writeFileSync(file, 'ordinary line\n');
const safeCommit = realCommit('--allow-empty', '-am', 'safe commit through installed hooks');
assert.equal(safeCommit.status, 0, safeCommit.stdout + safeCommit.stderr);
writeFileSync(file, `${marker}\n`);
const blockedContent = realCommit('-am', 'must be blocked');
assert.equal(blockedContent.status, 1, blockedContent.stderr);
assert.match(blockedContent.stderr, /private-pattern-1/);
writeFileSync(file, 'ordinary line\n');
git('add', '--', name);
for (const args of [
  ['--amend', '--allow-empty', '-m', marker],
  ['--allow-empty', '--author', `${marker} <fixture@example.test>`, '-m', 'ordinary message'],
]) {
  const result = realCommit(...args);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /private-pattern-1/);
  assert.ok(!result.stderr.includes(marker));
}
console.log('Privacy checks passed: staged content/type changes, filenames, forbidden files, binary warnings, commit ranges (root/merge/history), metadata, commit messages and versioned hooks');
