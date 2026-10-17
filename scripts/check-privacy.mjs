// Read-only source scan. Private patterns belong outside version control.
import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Neutral fixture names; the two space variants exercise VS Code URI encoding.
const placeholders = new Set(['user', 'runner', 'me', 'you', 'u', 'a', 'a b', 'a%20b', 'test', 'test user',
  'demo', 'repo', 'project', 'archive', 'local']);
const rules = [
  { id: 'home-path', pattern: /\/(?:home|Users)\/([^/\\\r\n"'`<>${}]+)/gi, username: true },
  { id: 'windows-home', pattern: /(?:\b[A-Z]:[\\/]+|\/mnt\/[a-z]\/)Users[\\/]+([^/\\\r\n"'`<>${}]+)/gi, username: true },
  { id: 'claude-temp', pattern: /\/(?:private\/)?tmp\/claude-\d+(?=\/|$|[\\\s"'`])/g },
  { id: 'claude-project', pattern: /-home-([\w-]+?)--/gi, username: true },
  { id: 'private-key', pattern: /-----BEGIN (?:(?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g },
  { id: 'token', pattern: /\b(?:sk-ant-[\w-]{10,}|sk-(?:proj-)?[\w-]{20,}|gh[pousr]_[a-z\d]{20,}|github_pat_[a-z\d_]{20,}|AKIA[A-Z\d]{16}|AIza[\w-]{30,}|xox[baprs]-[\w-]{15,})\b/gi },
];

// Local handoff is removed from public history; this is not a public source document.
const excludedFiles = [{ file: 'HANDOFF.md', reason: 'Local maintainer state, excluded from the public release.' }];
// Exact source lines only: exceptions do not suppress other rules or private patterns.
const scratch = '/tmp/' + 'claude-1000/';
// Assemble synthetic path examples so the exception declarations also pass the scan.
const windows = '/mnt/c/' + 'Users/';
const windowsDisplay = 'C:' + '/Users/';
const windowsEscaped = 'C:' + String.raw`\\Users\\`;
const exceptions = [
  { file: 'frontend/scripts/tool-card-title.test.mjs', rules: ['claude-temp'],
    text: `rawInput: { files: ["${scratch}p/s/scratchpad/地图.html", "docs/a.md", "/work/report#1 100%.csv"], caption: "看这个", display: "render" } };`,
    reason: 'Synthetic SendUserFile path verifies scratchpad directory rendering.' },
  { file: 'server/history.test.ts', rules: ['claude-temp'],
    text: 'const sentFiles = { files: Array.from({ length: 60 }, (_, i) => `' + scratch + 'project/session/scratchpad/file-${i}.html`), caption: "c" };',
    reason: 'Synthetic 60-file payload verifies that native history preserves all attachment paths.' },
  { file: 'frontend/scripts/sidebar-resize.test.mjs', rules: ['home-path', 'windows-home'],
    text: `session('pin','${windows}Research/pinned','Pinned beyond 72h',120,{pinned:true,status:'dead'}),`,
    reason: 'Synthetic pinned Windows project is reused by the row-menu path assertion.' },
  { file: 'frontend/scripts/sidebar-resize.test.mjs', rules: ['home-path', 'windows-home'],
    text: `assert.equal(await evaluate("document.querySelector('.row-menu-path').textContent"),'${windowsDisplay}Research/pinned');`,
    reason: 'Expected Windows display path for the synthetic pinned project above.' },
  { file: 'server/terminals.test.ts', rules: ['home-path', 'windows-home'],
    text: `assert.equal(windowsHome("${windows}Gone/bin", () => false), "/mnt/c", "目录不存在不用");`,
    reason: 'An intentionally nonexistent Windows user verifies fallback to the drive root.' },
  { file: 'server/work-files.test.ts', rules: ['home-path', 'windows-home'],
    text: `assert.equal(normalizeWorkPath("${windowsEscaped}中文 文件.txt", "wsl"), "${windows}中文 文件.txt");`,
    reason: 'This is a synthetic filename immediately under Users, not a username.' },
  { file: 'server/work-files.test.ts', rules: ['windows-home'],
    text: `for (const os of ["linux", "darwin"] as const) assert.throws(() => normalizeWorkPath("${windowsEscaped}file.txt", os), fails(400));`,
    reason: 'Synthetic Windows filename verifies rejection on non-WSL platforms.' },
];

let staged = false;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--staged') staged = true;
  else if (arg === '--patterns' && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    const file = resolve(process.argv[++index]);
    for (const [line, source] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      const pattern = source.trim();
      if (!pattern || pattern.startsWith('#')) continue;
      try { rules.push({ id: `private-pattern-${line + 1}`, pattern: new RegExp(pattern, 'gi') }); }
      catch { throw new Error(`Invalid private pattern at line ${line + 1}`); }
    }
  } else throw new Error('Usage: node scripts/check-privacy.mjs [--staged] [--patterns <file>]');
}

const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const root = git(['rev-parse', '--show-toplevel']).toString().trim();
process.chdir(root);
const files = git(staged
  ? ['diff', '--cached', '--no-renames', '--diff-filter=ACM', '--name-only', '-z']
  : ['ls-files', '-z']).toString().split('\0').filter(Boolean);
let checked = 0, lines = 0;
const failures = [];
function inspect(file, line, text) {
  lines++;
  for (const rule of rules) {
    if (exceptions.some(item => item.file === file && item.rules.includes(rule.id) && item.text === text.trim())) continue;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.username && placeholders.has(match[1].trim().toLowerCase())) continue;
      // Do not echo the matched value: a finding may contain a real credential.
      failures.push(`${file}:${line}: ${rule.id}`);
      break;
    }
  }
}
for (const file of files) {
  if (excludedFiles.some(item => item.file === file)) continue;
  let data;
  if (staged) data = git(['show', `:${file}`]);
  else {
    try {
      const path = join(root, file), stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      data = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // Deleted worktree file has no current content.
      throw error;
    }
  }
  if (data.includes(0) || !isUtf8(data)) continue;
  checked++;
  if (!staged) data.toString().split('\n').forEach((text, index) => inspect(file, index + 1, text));
  else {
    const diff = git(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--', file]).toString();
    let line;
    for (const text of diff.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (line !== undefined && text.startsWith('+')) inspect(file, line++, text.slice(1));
      else if (line !== undefined && text.startsWith(' ')) line++;
    }
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`Privacy check failed: ${failures.length} matches`);
  process.exitCode = 1;
} else console.log(`Privacy check OK: ${checked} text files, ${lines} ${staged ? 'staged added' : 'worktree'} lines, 0 matches`);
