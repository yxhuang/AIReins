import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseSync } from 'rolldown/experimental';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const han = /\p{Script=Han}/u;

function parse(file, source) {
  const result = parseSync(file, source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  if (result.errors.length) throw new Error(`${file}: ${JSON.stringify(result.errors)}`);
  return result.program;
}

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'comments') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visitor));
    else if (value && typeof value === 'object') walk(value, visitor);
  }
}

export function chineseSourceSites(file, source) {
  const sites = [];
  walk(parse(file, source), node => {
    let text;
    if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    if (node.type === 'Literal' && node.regex) text = source.slice(node.start, node.end);
    if (node.type === 'TemplateLiteral') text = node.quasis.map((part, index) =>
      (part.value.cooked ?? part.value.raw) + (index < node.expressions.length ? `{p${index}}` : '')).join('');
    if (text === undefined || !han.test(text)) return;
    sites.push({ file, line: source.slice(0, node.start).split('\n').length, text });
  });
  return sites;
}

function readSources(root) {
  const sources = new Map();
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!['tests', '__tests__'].includes(entry.name)) visit(path); }
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        sources.set(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
      }
    }
  }
  visit(join(root, 'server'));
  return sources;
}

function readDictionary(root) {
  const dictionary = {};
  const file = 'frontend/src/i18n/server.zh-CN.ts';
  walk(parse(file, readFileSync(join(root, file), 'utf8')), node => {
    if (node.type === 'Property' && typeof node.key?.value === 'string' && typeof node.value?.value === 'string') {
      dictionary[node.key.value] = node.value.value;
    }
  });
  return dictionary;
}

function templateMatches(template, text) {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{product\\\}/g, '(?:Workbench|workbench|工作台|WB)');
  return new RegExp(`^${escaped}$`).test(text);
}

/** Strict registration, including logs: every Chinese literal needs a template or an exact justified exception. */
export function checkServerI18n({ root = repository, sources = readSources(root),
  coverage = JSON.parse(readFileSync(join(root, 'server/i18n/coverage.json'), 'utf8')),
  dictionary = readDictionary(root) } = {}) {
  const failures = [];
  const sites = [...sources].flatMap(([file, source]) => chineseSourceSites(file, source));
  const pending = new Set(sites);
  for (const entry of [...coverage.sources, ...coverage.excluded]) {
    const template = entry.key ? dictionary[entry.key] : entry.text;
    if (!template || (!entry.key && !entry.reason?.trim())) {
      failures.push(`${entry.file}:${entry.line}: ${entry.key ?? entry.text}: missing template or exception reason; update the paired dictionaries/coverage.json.`);
      continue;
    }
    const matches = [...pending].filter(site => site.file === entry.file && (entry.sha256
      ? createHash('sha256').update(site.text).digest('hex') === entry.sha256
      : templateMatches(template, site.text)));
    const site = matches.find(site => site.line === entry.line);
    if (site) pending.delete(site);
    else if (matches.length) {
      pending.delete(matches[0]);
      failures.push(`${entry.file}:${entry.line}: ${entry.key ?? entry.text}: location drift; current line ${matches.map(site => site.line).join(', ')}. Update this coverage.json entry's line.`);
    }
    else failures.push(`${entry.file}:${entry.line}: ${entry.key ?? entry.text}: registered template no longer exists in source. Remove or update this coverage.json entry and any unused dictionary key.`);
  }
  for (const site of pending) {
    failures.push(`${site.file}:${site.line}: unregistered Chinese literal ${JSON.stringify(site.text.slice(0, 160))}. Add a paired server dictionary template and coverage.sources entry, or an exact coverage.excluded entry with a reason.`);
  }
  return { failures, sourceSites: sites.length, templateCount: new Set(coverage.sources.map(entry => entry.key)).size, exceptionCount: coverage.excluded.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkServerI18n();
  if (result.failures.length) { console.error(result.failures.join('\n')); process.exitCode = 1; }
  else console.log(`Server i18n coverage OK: ${result.sourceSites} literals, ${result.templateCount} templates, ${result.exceptionCount} exceptions`);
}
