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

// Local maintainer state must never be tracked, even through git add -f.
const forbiddenFiles = new Set(['HANDOFF.md']);
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

const usage = 'Usage: node scripts/check-privacy.mjs [--staged | --range <base>..<head> | --commit-msg <file>] [--patterns <file>]';
let mode = 'worktree', range, messageFile;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (['--staged', '--range', '--commit-msg'].includes(arg)) {
    if (mode !== 'worktree') throw new Error(usage);
    mode = arg.slice(2);
    if (arg !== '--staged') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) throw new Error(usage);
      if (arg === '--range') range = value;
      else messageFile = resolve(value);
    }
  }
  else if (arg === '--patterns' && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    const file = resolve(process.argv[++index]);
    for (const [line, source] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
      const pattern = source.trim();
      if (!pattern || pattern.startsWith('#')) continue;
      try { rules.push({ id: `private-pattern-${line + 1}`, pattern: new RegExp(pattern, 'gi') }); }
      catch { throw new Error(`Invalid private pattern at line ${line + 1}`); }
    }
  } else throw new Error(usage);
}

const git = args => execFileSync('git', ['--literal-pathspecs', ...args], { maxBuffer: 64 * 1024 * 1024 });
const root = git(['rev-parse', '--show-toplevel']).toString().trim();
process.chdir(root);
let checked = 0, lines = 0;
const failures = [], skipped = [];
function inspect(label, line, text, file) {
  lines++;
  let matched = false;
  for (const rule of rules) {
    if (exceptions.some(item => item.file === file && item.rules.includes(rule.id) && item.text === text.trim())) continue;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.username && placeholders.has(match[1].trim().toLowerCase())) continue;
      // Do not echo the matched value: a finding may contain a real credential.
      failures.push(`${label}:${line}: ${rule.id}`);
      matched = true;
      break;
    }
  }
  return matched;
}
function inspectLines(label, text, file) {
  text.split('\n').forEach((line, index) => inspect(label, index + 1, line, file));
}
function inspectFile(file, data, diff, prefix = '') {
  // Never echo a filename which itself contains a private value.
  const privateName = inspect(`${prefix}<filename>`, 1, file);
  const label = prefix + (privateName ? '<redacted-path>' : file);
  if (forbiddenFiles.has(file)) {
    failures.push(`${label}:1: forbidden-file`);
    return;
  }
  if (data === undefined) return; // Still inspect tracked paths absent from the worktree.
  if (data.includes(0) || !isUtf8(data)) {
    skipped.push(label);
    return;
  }
  checked++;
  if (diff === undefined) inspectLines(label, data.toString(), file);
  else {
    let line;
    for (const text of diff.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (text.startsWith('diff --git ')) line = undefined;
      else if (hunk) line = Number(hunk[1]);
      else if (line !== undefined && text.startsWith('+')) inspect(label, line++, text.slice(1), file);
      else if (line !== undefined && text.startsWith(' ')) line++;
    }
  }
}
const diffOptions = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
function inspectChanges(base, revision = '') {
  const files = git([...base, ...diffOptions, '--diff-filter=ACMT', '--name-only', '-z']).toString().split('\0').filter(Boolean);
  for (const file of files) {
    const data = git(['show', `${revision}:${file}`]);
    const diff = data.includes(0) || !isUtf8(data) ? ''
      : git([...base, ...diffOptions, '--text', '--unified=0', '--', file]).toString();
    inspectFile(file, data, diff, revision ? `${revision}:` : '');
  }
  // Catch an unchanged forbidden file too; a staged deletion is allowed.
  const handoff = git(revision ? ['ls-tree', '--name-only', revision, '--', 'HANDOFF.md'] : ['ls-files', '--', 'HANDOFF.md']);
  if (handoff.length && !files.includes('HANDOFF.md')) failures.push(`${revision ? revision + ':' : ''}HANDOFF.md:1: forbidden-file`);
}
if (mode === 'range') {
  const refs = range.split('..');
  if (refs.length !== 2 || refs.some(ref => !ref)) throw new Error(usage);
  const commit = ref => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim();
  const head = commit(refs[1]);
  const revisions = /^0{40}(?:0{24})?$/.test(refs[0]) ? head : `${commit(refs[0])}..${head}`;
  const commits = git(['rev-list', '--reverse', '--topo-order', '--parents', revisions]).toString().trim();
  for (const entry of commits ? commits.split('\n') : []) {
    const [sha, parent] = entry.split(' ');
    const metadata = git(['show', '-s', '--no-show-signature', '--no-notes', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha]).toString().split('\0');
    for (const [index, field] of ['author-name', 'author-email', 'committer-name', 'committer-email', 'commit-message'].entries()) {
      inspectLines(`${sha}:<${field}>`, metadata[index]);
    }
    // A merge is compared to its first parent; roots compare to the empty tree.
    inspectChanges(parent ? ['diff', parent, sha] : ['diff-tree', '--root', '--no-commit-id', '-r', sha], sha);
  }
} else if (mode === 'commit-msg') {
  inspectLines('<commit-message>', readFileSync(messageFile, 'utf8'));
  for (const field of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    inspectLines(`<${field}>`, git(['var', field]).toString());
  }
} else if (mode === 'staged') inspectChanges(['diff', '--cached']);
else {
  const files = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
  for (const file of files) {
    if (forbiddenFiles.has(file)) {
      failures.push(`${file}:1: forbidden-file`);
      continue;
    }
    try {
      const path = join(root, file), stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) { inspectFile(file); continue; }
      inspectFile(file, stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path));
    } catch (error) {
      if (error.code === 'ENOENT') { inspectFile(file); continue; }
      throw error;
    }
  }
}
if (skipped.length) console.warn(`Skipped content (binary/non-UTF-8, not verified; 请人工检查):\n${skipped.join('\n')}`);
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`Privacy check failed: ${failures.length} matches`);
  process.exitCode = 1;
} else console.log(`Privacy text check OK: ${checked} text files, ${lines} inspected lines, 0 matches${skipped.length ? `; ${skipped.length} skipped files remain unverified` : ''}`);
