import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'aireins-privacy-test-'));
const script = fileURLToPath(new URL('./check-privacy.mjs', import.meta.url));
const git = (...args) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
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
expect(0);
console.log('Privacy checks passed: generic rules, private patterns, binary skip, read-only index and staged additions (negative control exits 1)');
