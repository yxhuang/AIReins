// Extracts the WbTitle regex from wb-tray.ps1 and checks it against the
// workbenchWindowTitle samples (frontend/src/host-connections.ts) in both
// interface languages, plus the legacy formats kept for unrefreshed pages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = readFileSync(fileURLToPath(new URL('../wb-tray.ps1', import.meta.url)), 'utf8');
const match = source.match(/WbTitle\s*=\s*new\s+System\.Text\.RegularExpressions\.Regex\(\s*@"(?<regex>[^"]*)"/);
assert.ok(match, 'wb-tray.ps1 must define WbTitle with a @"..." verbatim string');
const regex = new RegExp(match.groups.regex);

for (const title of [
  '(2) 个闸门待处理 · AIReins · 本机',
  'AIReins · 本机',
  'AIReins · 远程 alice-desktop',
  '(1) pending approval · AIReins · Local',
  '(1,000) pending approvals · AIReins · Local',
  '(1,000) 个闸门待处理 · AIReins · 本机',
  'AIReins · Remote x1c',
  'AIReins',
  '(2) 个闸门待处理 · Workbench · 本机',
  'Workbench · 本机',
  'Workbench · 远程 alice-desktop',
  '(1) pending approval · Workbench · Local',
  '(2) pending approvals · Workbench · Remote alice-desktop',
  'Workbench · Local',
  'Workbench · Remote x1c',
  'workbench',
  '某应用 · workbench',
]) {
  test(`matches: ${title}`, () => assert.ok(regex.test(title)));
}
for (const title of [
  'Workbench · 工作台',
  'Other App',
  'Workbench · ',
  '(2) 个闸门待处理 · Other · 本机',
  'Workbench ·Remote x1c',
  'AIReins · 工作台',
  'AIReins - Google Chrome',
]) {
  test(`rejects: ${title}`, () => assert.ok(!regex.test(title)));
}

// PowerShell passes $null to a .NET string parameter as "", so FindWindowEx would look for an empty class name.
test('FindWindowEx call passes a real null class name', () => {
  const call = source.match(/\[WbNative\]::FindWindowEx\(([^\n]*)\)/);
  assert.ok(call, 'wb-tray.ps1 must call FindWindowEx');
  assert.match(call[1], /\[NullString\]::Value/);
});
