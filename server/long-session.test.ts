import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WORKBENCH_HOME = mkdtempSync(join(tmpdir(), 'wb-long-test-'));
const p = await import('./persistence.js');
const { selectEventPage, snapshotState } = await import('./event-pages.js');
const ev = (seq: number, type: any, payload: Record<string, unknown> = {}) => ({ seq, type, payload, sessionId: 's', agentId: 'a', timestamp: '2026-10-05T00:00:00Z' });
const events = [];
for (let i = 0; i < 100; i++) {
  events.push(ev(events.length + 1, 'user_message', { text: 'turn ' + i }));
  if (i === 8) events.push(ev(events.length + 1, 'tool_call_started', { toolCallId: 'cross' }));
  if (i === 15) events.push(ev(events.length + 1, 'tool_call_completed', { toolCallId: 'cross' }));
  if (i === 60) events.push(ev(events.length + 1, 'tool_call_updated', { toolCallId: 'cross', input: 'late' }));
  if (i === 65) events.push(ev(events.length + 1, 'permission_request', { requestId: 'g' }));
  if (i === 70) events.push(ev(events.length + 1, 'permission_resolved', { requestId: 'g' }));
  events.push(ev(events.length + 1, 'agent_text_delta', { text: i === 99 ? '界'.repeat(20000) : 'answer' }));
  events.push(ev(events.length + 1, 'usage_updated', { usage: { cache_creation: { ephemeral_5m_input_tokens: i % 10 === 0 ? 1 : 0 } } }));
}
const path = p.transcriptPathFor('test');
fs.mkdirSync(join(process.env.WORKBENCH_HOME, 'transcripts'));
fs.writeFileSync(path, events.map(e => JSON.stringify(e) + '\n').join(''));
const check = () => {
  const all = p.readTranscript(path);
  let cursor: number | undefined;
  do {
    const actual = p.readTranscriptPage(path, cursor);
    const expected = selectEventPage(all, cursor);
    assert.deepEqual(actual, expected);
    assert.deepEqual(p.readTranscriptDerived(path).state, snapshotState(all));
    if (!actual.hasMore) break;
    cursor = actual.firstSeq;
  } while (true);
};
check();
for (const ending of ['{"bad":', JSON.stringify(ev(9999, 'user_message', { text: 'unterminated but valid' })), 'bad-middle\n' + JSON.stringify(ev(9999, 'turn_completed')) + '\n']) {
  fs.writeFileSync(path, events.map(e => JSON.stringify(e) + '\n').join('') + ending);
  check();
  if (!ending.endsWith('\n')) { p.appendTranscript(path, ev(10000, 'turn_completed')); check(); assert.equal(p.readTranscriptState(path).damaged, false); }
  else assert.throws(() => p.appendTranscript(path, ev(10000, 'turn_completed')), /损坏/);
}
const writePath = p.transcriptPathFor('write');
const countAppend = fs.appendFileSync;
let writes = 0;
fs.appendFileSync = ((file, data, options) => {
  if (file === writePath) writes++;
  return countAppend(file, data, options);
}) as typeof fs.appendFileSync;
syncBuiltinESMExports();
try {
  p.appendTranscript(writePath, ev(1, 'user_message', { text: 'one' }));
  for (let i = 2; i <= 1001; i++) p.appendTranscript(writePath, ev(i, 'agent_text_delta', { text: 'delta' }));
  assert.equal(writes, 1, 'same-tick appends are queued after the first synchronous write');
  assert.equal(p.readTranscript(writePath).length, 1001, 'read flushes queued events');
  assert.equal(writes, 2, '1000 queued appends share one physical append');
} finally { fs.appendFileSync = countAppend; syncBuiltinESMExports(); }
p.appendTranscript(writePath, ev(1002, 'turn_completed'));
p.flushTranscripts();
assert.equal(fs.readFileSync(writePath, 'utf8').trim().split('\n').length, 1002);
console.log('✅ transcript pages, derived state, corrupt tail and read/explicit flush equivalence');

// Deliberately hold scheduled batch callbacks, proving shutdown flushes queued data
// rather than accidentally observing an earlier setImmediate write.
for (const trigger of ['SIGINT', 'SIGTERM', 'process.exit']) {
  const childHome = mkdtempSync(join(tmpdir(), 'wb-long-exit-'));
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const p = await import(${JSON.stringify(new URL('./persistence.ts', import.meta.url).href)});
    const { SessionManager } = await import(${JSON.stringify(new URL('./session-manager.ts', import.meta.url).href)});
    const manager = new SessionManager();
    const path = p.transcriptPathFor('exit');
    const immediate = globalThis.setImmediate;
    globalThis.setImmediate = () => immediate(() => {});
    const stop = async () => {
      assert.equal(fs.readFileSync(path, 'utf8').trim().split('\\n').length, 1, 'batch is still pending at shutdown');
      await manager.shutdown();
      console.log('TRIGGER ' + ${JSON.stringify(trigger)});
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    for (let seq = 1; seq <= 64; seq++) p.appendTranscript(path, { seq, type: 'agent_text_delta', payload: { text: 'delta' }, sessionId: 'exit', agentId: 'a', timestamp: '2026-10-05T00:00:00Z' });
    if (${JSON.stringify(trigger)} === 'process.exit') {
      assert.equal(fs.readFileSync(path, 'utf8').trim().split('\\n').length, 1);
      console.log('TRIGGER process.exit');
      process.exit(0);
    }
    setTimeout(() => process.exit(91), 5000);
    process.kill(process.pid, ${JSON.stringify(trigger === 'process.exit' ? 'SIGTERM' : trigger)});
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, WORKBENCH_HOME: childHome }, timeout: 8000, encoding: 'utf8',
  });
  assert.equal(child.status, 0, `${trigger}: ${child.error ?? ''} ${child.stdout} ${child.stderr}`);
  assert.match(child.stdout, new RegExp('TRIGGER ' + trigger.replace('.', '\\.')));
  const disk = fs.readFileSync(join(childHome, 'transcripts/exit.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(disk.map(event => event.seq), Array.from({ length: 64 }, (_, i) => i + 1));
}
console.log('✅ child SIGINT, SIGTERM and process.exit flush all same-tick events');

const failurePath = p.transcriptPathFor('delayed-failure');
p.appendTranscript(failurePath, ev(1, 'user_message'));
p.appendTranscript(failurePath, ev(2, 'agent_text_delta', { text: 'pending' }));
const append = fs.appendFileSync, errorLog = console.error;
const messages: string[] = [];
fs.appendFileSync = ((file, data, options) => {
  if (file === failurePath) { append(file, String(data).slice(0, 12), options); throw new Error('injected batch ENOSPC'); }
  return append(file, data, options);
}) as typeof fs.appendFileSync;
syncBuiltinESMExports();
console.error = (...args) => { messages.push(args.join(' ')); };
try {
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(messages.some(message => message.includes('transcript batch append failed') && message.includes('ENOSPC')));
  assert.throws(() => p.appendTranscript(failurePath, ev(3, 'turn_completed')), /损坏|只读/);
  assert.equal(p.readTranscriptState(failurePath).damaged, true);
  assert.throws(() => p.appendTranscript(failurePath, ev(3, 'turn_completed')), /损坏|只读/, 'reading cannot silently unlock a failed batch');
} finally { fs.appendFileSync = append; syncBuiltinESMExports(); console.error = errorLog; }
console.log('✅ delayed partial write failure is logged, does not crash and stays read-only');

// External rewrite between read and append must not be hidden by the new fingerprint.
const externalPath = p.transcriptPathFor('external-change');
p.appendTranscript(externalPath, ev(1, 'user_message', { text: 'old' }));
p.readTranscript(externalPath);
fs.writeFileSync(externalPath, JSON.stringify(ev(1, 'user_message', { text: 'replaced' })) + '\n');
p.appendTranscript(externalPath, ev(2, 'agent_text_delta', { text: 'new' }));
assert.equal(p.readTranscript(externalPath)[0]!.payload.text, 'replaced');
const page = p.readTranscriptPage(externalPath);
page.events[0]!.payload.text = 'caller mutation';
assert.equal(p.readTranscriptPage(externalPath).events[0]!.payload.text, 'replaced');
console.log('✅ external file changes and returned-page mutation cannot poison the cache');

const { EventPageIndex } = await import('./event-pages.js');
let seed = 9917;
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let run = 0; run < 12; run++) {
  const index = new EventPageIndex();
  const all = [];
  const types = ['user_message', 'agent_text_delta', 'tool_call_started', 'tool_call_updated', 'tool_call_completed', 'permission_request', 'permission_resolved', 'usage_updated', 'commands_updated', 'config_update_started', 'config_updated', 'session_error'];
  for (let i = 1; i <= 180; i++) {
    const event = ev(i % 19 === 0 ? i - 4 : i, types[random(types.length)], {
      text: 'x'.repeat(run === 0 && i % 101 === 0 ? 1600000 : 5), steer: i % 11 === 0,
      toolCallId: 't' + random(4), requestId: 'g' + random(4),
      usage: { cache_creation: { ephemeral_1h_input_tokens: i % 7 === 0 ? 2 : 0, ephemeral_5m_input_tokens: i % 3 === 0 ? 1 : 0 } },
      commands: i % 2 ? [{ name: 'cmd' }] : 'invalid', message: i % 2 ? 'switching' : '',
    });
    if (i % 23 === 0) event.timestamp = 'invalid-date';
    all.push(event); index.append(event);
    assert.deepEqual(index.state, snapshotState(all));
    for (const cursor of [undefined, i, 1, 9999, NaN, -2]) {
      let expected, expectedError;
      try { expected = selectEventPage(all, cursor); } catch (error) { expectedError = (error as Error).message; }
      if (expectedError) assert.throws(() => index.page(cursor), error => (error as Error).message === expectedError);
      else assert.deepEqual(index.page(cursor), expected);
    }
  }
}
console.log('✅ incremental page/state random equivalence, duplicate IDs, late updates, out-of-order seq and invalid cursors');

const { SessionManager } = await import('./session-manager.js');
const managerPath = p.transcriptPathFor('manager-fail');
p.appendTranscript(managerPath, ev(1, 'user_message', { text: 'session' }));
p.saveRegistry([{ id: 'manager-fail', agent: 'codex', agentId: 'a', cwd: process.cwd(), config: {}, riskyMode: false, status: 'idle', seq: 1, createdAt: '2026-10-05T00:00:00Z', lastActivityAt: '2026-10-05T00:00:00Z', transcriptPath: managerPath }]);
const manager = new SessionManager();
const internal = manager as any;
const worker = { stop: async () => {} };
internal.workers.set('manager-fail', worker);
const callbacks = internal.driverCallbacks('manager-fail', () => worker);
callbacks.emit('agent_text_delta', { text: 'queued' });
const originalAppend = fs.appendFileSync;
fs.appendFileSync = ((file, data, options) => {
  if (file === managerPath) throw new Error('manager batch ENOSPC');
  return originalAppend(file, data, options);
}) as typeof fs.appendFileSync;
syncBuiltinESMExports();
try {
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(manager.get('manager-fail')!.status, 'error');
  const seq = manager.get('manager-fail')!.seq;
  assert.equal(callbacks.emit('agent_text_delta', { text: 'late driver callback' }), undefined);
  assert.doesNotThrow(() => callbacks.exited({ code: 1 }));
  assert.equal(manager.get('manager-fail')!.seq, seq, 'failed transcript cannot accept later events');
  assert.throws(() => manager.updateOrganization('manager-fail', { customTitle: 'new' }), /损坏|只读/);
  assert.equal(p.readTranscriptState(managerPath).damaged, true, 'even a zero-byte batch failure stays read-only');
} finally { fs.appendFileSync = originalAppend; syncBuiltinESMExports(); }
await manager.shutdown();
console.log('✅ delayed failure marks session error, ignores driver callbacks and rejects further writes');

for (const mode of ['io', 'exit', 'direct'] as const) {
  const id = `sync-manager-${mode}`;
  const file = p.transcriptPathFor(id);
  p.appendTranscript(file, { ...ev(1, 'user_message', { text: 'saved' }), sessionId: id });
  p.saveRegistry([{ id, agent: 'codex', agentId: 'a', cwd: process.cwd(), config: {}, riskyMode: false,
    status: 'idle', seq: 1, createdAt: '2026-10-05T00:00:00Z', lastActivityAt: '2026-10-05T00:00:00Z', transcriptPath: file }]);
  const current = new SessionManager();
  const state = current as any;
  const driver = { stop: async () => {} };
  state.workers.set(id, driver);
  const io = state.driverCallbacks(id, () => driver);
  const published: unknown[] = [];
  current.onEvent(event => published.push(event));
  await new Promise<void>(resolve => setImmediate(resolve)); // Exercise the synchronous first append of a tick.
  const original = fs.appendFileSync;
  fs.appendFileSync = ((path, data, options) => {
    if (path === file) throw new Error('sync manager ENOSPC');
    return original(path, data, options);
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  try {
    const emit = () => mode === 'exit' ? io.exited({ code: 1 })
      : mode === 'direct' ? state.emit(id, 'agent_text_delta', { text: 'lost' })
      : io.emit('agent_text_delta', { text: 'lost' });
    if (mode === 'direct') assert.throws(emit, /sync manager ENOSPC/);
    else assert.doesNotThrow(emit, 'driver IO must not turn one transcript failure into a server crash');
    assert.equal(current.get(id)!.status, 'error');
    assert.equal(current.get(id)!.seq, 1, 'a rejected synchronous append cannot advance the published cursor');
    assert.deepEqual(published, [], 'unwritten events cannot reach event listeners');
    assert.equal(p.readTranscriptState(file).damaged, true, 'even a zero-byte synchronous failure stays read-only');
    assert.throws(() => p.appendTranscript(file, { ...ev(2, 'turn_completed'), sessionId: id }), /损坏|只读/);
    assert.doesNotThrow(() => { io.status('idle'); io.metadata({ nativeTitle: 'late' }); io.exited({ code: 0 }); });
    assert.equal(current.get(id)!.seq, 1);
    assert.throws(() => current.updateOrganization(id, { customTitle: 'late' }), /损坏|只读/);
  } finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
  await current.shutdown();
}
console.log('✅ synchronous transcript failure is isolated from driver IO/exit, reported to direct callers and never published');

const orderPath = p.transcriptPathFor('batch-order');
p.appendTranscript(orderPath, ev(1, 'agent_text_delta'));
const interleaved = new Promise<void>(resolve => setImmediate(() => {
  p.appendTranscript(orderPath, ev(3, 'agent_text_delta')); resolve();
}));
p.appendTranscript(orderPath, ev(2, 'agent_text_delta'));
await interleaved;
assert.deepEqual(p.readTranscript(orderPath).map(event => event.seq), [1, 2, 3]);
console.log('✅ append order survives interleaved setImmediate callbacks');

const shutdownPath = p.transcriptPathFor('shutdown-failure');
p.appendTranscript(shutdownPath, ev(1, 'user_message'));
p.saveRegistry([{ id: 'shutdown-failure', agent: 'codex', agentId: 'a', cwd: process.cwd(), config: {}, riskyMode: false, status: 'idle', seq: 1, createdAt: '2026-10-05T00:00:00Z', lastActivityAt: '2026-10-05T00:00:00Z', transcriptPath: shutdownPath }]);
const shuttingDown = new SessionManager();
let stopped = false;
(shuttingDown as any).workers.set('shutdown-failure', { stop: async () => { stopped = true; } });
(shuttingDown as any).emit('shutdown-failure', 'agent_text_delta', { text: 'pending at shutdown' });
const shutdownAppend = fs.appendFileSync;
fs.appendFileSync = ((file, data, options) => {
  if (file === shutdownPath) throw new Error('shutdown ENOSPC');
  return shutdownAppend(file, data, options);
}) as typeof fs.appendFileSync;
syncBuiltinESMExports();
try {
  await assert.rejects(shuttingDown.shutdown(), /shutdown ENOSPC/);
  assert.equal(stopped, true, 'flush failure must not abandon worker shutdown');
} finally { fs.appendFileSync = shutdownAppend; syncBuiltinESMExports(); }
console.log('✅ shutdown stops its workers even when the initial transcript flush fails');
