import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.WORKBENCH_HOME = fs.mkdtempSync(join(tmpdir(), 'wb-review-fix-'));
const p = await import('./persistence.js');
const ev = (seq: number, text = '') => ({ seq, type: 'user_message' as const, payload: { text }, sessionId: 's', agentId: 'a', timestamp: '2026-10-05T00:00:00Z' });
const cases: Record<string, () => Promise<void>> = {
  '1': async () => {
    for (const tail of ['{"cut":', JSON.stringify(ev(7, 'unterminated valid JSON'))]) {
      const path = p.transcriptPathFor('tail-' + tail.length);
      p.appendTranscript(path, ev(1)); p.readTranscript(path);
      fs.writeFileSync(path, tail);
      p.appendTranscript(path, ev(8, 'new')); p.flushTranscripts(path);
      const actual = p.readTranscriptState(path);
      assert.equal(actual.damaged, false);
      assert.deepEqual(actual.events.map(event => event.seq), [8]);
      assert(fs.readFileSync(path, 'utf8').startsWith(tail + '\n{"_wbSkippedTail":'));
    }
    const queued = p.transcriptPathFor('queued-rewrite');
    p.appendTranscript(queued, ev(1)); p.appendTranscript(queued, ev(2));
    fs.writeFileSync(queued, '{"cut":');
    p.flushTranscripts(queued);
    assert.deepEqual(p.readTranscript(queued).map(event => event.seq), [2], 'queued flush must rejudge tail too');
    const path = p.transcriptPathFor('middle');
    p.appendTranscript(path, ev(1)); p.readTranscript(path);
    const corrupt = 'bad-middle\n' + JSON.stringify(ev(7)) + '\n';
    fs.writeFileSync(path, corrupt);
    assert.throws(() => p.appendTranscript(path, ev(8)), /损坏|只读/);
    assert.equal(fs.readFileSync(path, 'utf8'), corrupt);
  },
  '2': async () => {
    const { EventPageIndex } = await import('./event-pages.js');
    const append = EventPageIndex.prototype.append;
    let builds = 0;
    EventPageIndex.prototype.append = function (event) { builds++; return append.call(this, event); };
    fs.mkdirSync(join(process.env.WORKBENCH_HOME!, 'transcripts'), { recursive: true });
    const sessions = Array.from({ length: 4 }, (_, i) => {
      const path = p.transcriptPathFor('cold-' + i);
      fs.writeFileSync(path, JSON.stringify(ev(1, 'short title')) + '\n' + JSON.stringify({ ...ev(2, 'x'.repeat(1024 * 1024)), type: 'agent_text_delta' }) + '\n');
      return { id: 'cold-' + i, agent: 'codex' as const, agentId: 'a', cwd: process.cwd(), config: {}, riskyMode: false, status: 'idle' as const, released: true, seq: 1, createdAt: '2026-10-05T00:00:00Z', lastActivityAt: '2026-10-05T00:00:00Z', transcriptPath: path };
    });
    p.saveRegistry(sessions);
    const { SessionManager } = await import('./session-manager.js');
    const manager = new SessionManager();
    EventPageIndex.prototype.append = append;
    assert.equal(builds, 0, 'startup must not build complete event caches or paging indices for every session');
    assert.equal(p.transcriptCacheStats().entries, 0);
    for (const session of sessions) {
      const page = manager.getSnapshot(session.id, true)!;
      assert.equal(String(page.events[1].payload.text).length, 1024 * 1024);
      assert(p.transcriptCacheStats().accountedBytes <= p.transcriptCacheStats().maxBytes);
    }
    const stats = p.transcriptCacheStats();
    assert(stats.accountedBytes < 128 * 1024, 'indices must not retain the 4MiB message bodies');
    await manager.shutdown();
    // A warm idle entry is evicted before older active entries when the total
    // index budget is reached; large individual entries are never retained.
    const paths = Array.from({ length: 12 }, (_, i) => p.transcriptPathFor('budget-' + i));
    const events = Array.from({ length: 6000 }, (_, i) => ev(i + 1, 'small'));
    const raw = events.map(event => JSON.stringify(event) + '\n').join('');
    for (const path of paths) { fs.writeFileSync(path, raw); p.readTranscriptPage(path); }
    p.setTranscriptCacheIdle(paths.at(-1)!, true);
    const extra = p.transcriptPathFor('budget-extra'); fs.writeFileSync(extra, raw); p.readTranscriptPage(extra);
    let indexed = 0;
    EventPageIndex.prototype.append = function (event) { indexed++; return append.call(this, event); };
    try {
      p.readTranscriptPage(paths[2]!);
      assert.equal(indexed, 0, 'active index survives while newer idle entry is evicted');
      p.readTranscriptPage(paths.at(-1)!);
      assert.equal(indexed, 6000, 'idle index was evicted despite being newer');
    } finally { EventPageIndex.prototype.append = append; }
    assert(p.transcriptCacheStats().accountedBytes <= p.transcriptCacheStats().maxBytes);
    const oversized = p.transcriptPathFor('oversized-state');
    fs.writeFileSync(oversized, JSON.stringify({ ...ev(1), type: 'usage_updated', payload: { large: 'x'.repeat(3 * 1024 * 1024) } }) + '\n');
    const entries = p.transcriptCacheStats().entries;
    p.readTranscriptDerived(oversized);
    p.readTranscriptDerived(oversized);
    assert.equal(p.transcriptCacheStats().entries, entries, 'oversized derived payload is transient and leaves other entries intact');
  },
  '3': async () => {
    const path = p.transcriptPathFor('read-race');
    fs.mkdirSync(join(process.env.WORKBENCH_HOME!, 'transcripts'), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(ev(10)) + '\n');
    const read = fs.readFileSync, open = fs.openSync, readChunk = fs.readSync;
    const fds = new Set<number>(); let rewritten = false;
    const rewrite = () => { if (!rewritten) { rewritten = true; fs.writeFileSync(path, JSON.stringify(ev(20)) + '\n'); } };
    fs.readFileSync = ((file, ...args) => { const bytes = (read as any)(file, ...args); if (file === path) rewrite(); return bytes; }) as typeof fs.readFileSync;
    fs.openSync = ((file, ...args) => { const fd = (open as any)(file, ...args); if (file === path) fds.add(fd); return fd; }) as typeof fs.openSync;
    fs.readSync = ((fd, ...args) => { const count = (readChunk as any)(fd, ...args); if (fds.has(fd) && count > 0) rewrite(); return count; }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try { p.readTranscriptPage(path); } finally { fs.readFileSync = read; fs.openSync = open; fs.readSync = readChunk; syncBuiltinESMExports(); }
    assert(rewritten);
    assert.deepEqual(p.readTranscriptPage(path).events.map(event => event.seq), [20], 'old bytes must never be cached under the new fingerprint');
    // Also invalidate a warm offset index if the file changes during page I/O.
    rewritten = false;
    fs.readSync = ((fd, ...args) => {
      const count = (readChunk as any)(fd, ...args);
      if (count > 0 && !rewritten) { rewritten = true; fs.writeFileSync(path, JSON.stringify(ev(30)) + '\n'); }
      return count;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try { assert.deepEqual(p.readTranscriptPage(path).events.map(event => event.seq), [30]); }
    finally { fs.readSync = readChunk; syncBuiltinESMExports(); }
  },
  '3a': async () => {
    const path = p.transcriptPathFor('full-rejudge-cache');
    fs.mkdirSync(join(process.env.WORKBENCH_HOME!, 'transcripts'), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(ev(1, 'old long cached body'.repeat(10))) + '\n');
    p.readTranscriptPage(path);
    const entries = p.transcriptCacheStats().entries;
    fs.writeFileSync(path, JSON.stringify(ev(10, 'replacement')) + '\n');
    assert.deepEqual(p.readTranscript(path).map(event => event.seq), [10]);
    assert.equal(p.transcriptCacheStats().entries, entries - 1, 'full health rejudge must invalidate the old paging index');
    p.appendTranscript(path, ev(11, 'appended')); p.flushTranscripts(path);
    assert.deepEqual(p.readTranscriptPage(path).events, p.readTranscript(path));
    assert.equal(p.readTranscriptDerived(path).title, 'replacement');
  },
  '3b': async () => {
    for (const sameSize of [false, true]) {
      const path = p.transcriptPathFor('write-race-' + sameSize);
      fs.mkdirSync(join(process.env.WORKBENCH_HOME!, 'transcripts'), { recursive: true });
      fs.writeFileSync(path, JSON.stringify(ev(1, 'old cached body')) + '\n');
      p.readTranscriptPage(path);
      const append = fs.appendFileSync;
      let injected = false;
      fs.appendFileSync = ((file, data, options) => {
        append(file, data, options);
        if (file === path && !injected) {
          injected = true;
          let replacement = JSON.stringify(ev(20, 'external version')) + '\n';
          if (sameSize) replacement += ' '.repeat(fs.statSync(path).size - Buffer.byteLength(replacement) - 1) + '\n';
          fs.writeFileSync(path, replacement);
        }
      }) as typeof fs.appendFileSync;
      syncBuiltinESMExports();
      try { p.appendTranscript(path, ev(2, 'own append')); p.flushTranscripts(path); }
      finally { fs.appendFileSync = append; syncBuiltinESMExports(); }
      assert(injected);
      assert.deepEqual(p.readTranscriptPage(path).events.map(event => event.seq), [20], 'post-write external version must not inherit the old offsets');
      assert.equal(p.readTranscriptDerived(path).title, 'external version');
      // The next write rejudges health rather than trusting a raced write stamp.
      p.appendTranscript(path, ev(21)); p.flushTranscripts(path);
      assert.deepEqual(p.readTranscriptPage(path).events, p.readTranscript(path));
    }
  },
  'tail-once': async () => {
    const { EventPageIndex } = await import('./event-pages.js');
    const path = p.transcriptPathFor('uncached-large');
    const events = Array.from({ length: 70000 }, (_, i) => ev(i + 1, 'short'));
    fs.mkdirSync(join(process.env.WORKBENCH_HOME!, 'transcripts'), { recursive: true });
    fs.writeFileSync(path, events.map(event => JSON.stringify(event) + '\n').join(''));
    p.saveRegistry([{ id: 'uncached-large', agent: 'codex', agentId: 'a', cwd: process.cwd(), config: {}, riskyMode: false, status: 'idle', released: true, seq: 70000, createdAt: events[0].timestamp, lastActivityAt: events[0].timestamp, transcriptPath: path }]);
    const { SessionManager } = await import('./session-manager.js');
    const manager = new SessionManager();
    const append = EventPageIndex.prototype.append;
    let indexed = 0;
    EventPageIndex.prototype.append = function (event) { indexed++; return append.call(this, event); };
    try {
      const snapshot = manager.getSnapshot('uncached-large', true)!;
      assert.equal(indexed, 70000, 'oversized uncached tail must build the index once, sharing derived/page');
      assert.deepEqual(snapshot.events, events.slice(-30));
      assert.equal(snapshot.session.title, 'short');
    } finally { EventPageIndex.prototype.append = append; await manager.shutdown(); }
  },

};
for (const key of process.argv[2] ? [process.argv[2]] : Object.keys(cases)) { await cases[key](); console.log('PASS review ' + key); }
