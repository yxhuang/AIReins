import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { disconnectComposerHistory, moveComposerHistory, readComposerHistory, rememberComposerInput } from '../src/composer-history.ts';
globalThis.WebSocket = { OPEN: 1 };
const saved = new Map();
globalThis.localStorage = { get length() { return saved.size; }, key(i) { return [...saved.keys()][i] ?? null; }, getItem(k) { return saved.get(k) ?? null; }, setItem(k,v) { saved.set(k,v); }, removeItem(k) { saved.delete(k); } };
const s = new Store();
const frames = [];
s.socket = { readyState: 1, send(raw) { frames.push(JSON.parse(raw)); } };
const historyKey = 'workbench-composer-history';
saved.set(historyKey, JSON.stringify(['old unscoped input']));
s.handleFrame({type:'ready',serverInstanceId:'first'});
assert.equal(saved.has(historyKey), false, 'discard legacy history on the first ready frame');
s.setDraft('a', 'hello');
await s.sendComposerInput('a', 'hello', [{type:'file',path:'/tmp/a'}]);
assert.deepEqual(readComposerHistory(), ['hello'], 'both composer entry points remember submitted text without attachments');
assert.equal(s.pendingMessages('a').length, 1);
const requestId = frames[0].clientRequestId;
const refreshed = new Store();
disconnectComposerHistory();
assert.deepEqual(readComposerHistory(), [], 'history is unavailable before confirming the connected process');
refreshed.handleFrame({type:'ready',serverInstanceId:'first'});
assert.deepEqual(readComposerHistory(), ['hello'], 'history can be read by a fresh composer');
assert.equal(refreshed.pendingMessages('a')[0].text, 'hello');
assert.ok(s.pendingMessages('a')[0].sentAt > 0);
assert.equal(refreshed.pendingMessages('a')[0].sentAt, s.pendingMessages('a')[0].sentAt, 'reload preserves the original send time');
refreshed.setDraft('a', 'new input');
assert.equal(refreshed.restorePendingMessage(requestId), false);
assert.equal(refreshed.getDraft('a'), 'new input');
refreshed.clearDraft('a');
assert.equal(refreshed.restorePendingMessage(requestId), true);
assert.equal(refreshed.getDraft('a'), 'hello');
assert.equal(refreshed.sendTextRestore.mentions.length, 1);
s.handleFrame({type:'ack',action:'user_message',sessionId:'wrong',clientRequestId:requestId});
assert.equal(s.pendingMessages('a').length, 1);
s.handleFrame({type:'ack',action:'user_message',sessionId:'a',clientRequestId:requestId});
assert.equal(s.pendingMessages('a').length, 0);
assert.equal(new Store().pendingMessages('a').length, 0);
assert.equal(s.resolvePermission('a','gate','allow'), true);
assert.equal(s.permissionSubmitting('a','gate'), true);
s.handleFrame({type:'error',action:'permission_resolved',sessionId:'a',clientRequestId:frames.at(-1).clientRequestId,msg:'retry'});
assert.equal(s.permissionSubmitting('a','gate'), false);
assert.equal(s.resolvePermission('a','gate','allow'), true);
s.handleFrame({type:'ack',action:'permission_resolved',sessionId:'a',clientRequestId:frames.at(-1).clientRequestId});
assert.equal(s.permissionSubmitting('a','gate'), false);
console.log('PASS pending messages persist, explicit recovery preserves newer drafts, permission errors unlock');
const echo = new Store();
echo.socket = s.socket;
await echo.sendComposerInput('a', '', [{type:'image',path:'/tmp/picture.png',mimeType:'image/png'}]);
const imageId = frames.at(-1).clientRequestId;
assert.equal(echo.pendingMessages('a').length, 1);
echo.applySnapshot('a', {id:'a',status:'idle',seq:1,agent:'claude',config:{}}, 1, [{type:'user_message',sessionId:'a',seq:1,payload:{clientRequestId:imageId}}], false, 1);
assert.equal(echo.pendingMessages('a').length, 0, 'durable snapshot confirms a lost ack, including image-only sends');
await echo.sendComposerInput('a', 'rejected');
const rejectedId = frames.at(-1).clientRequestId;
echo.setDraft('a', 'newer');
echo.handleFrame({type:'error',action:'user_message',sessionId:'a',clientRequestId:rejectedId,msg:'rejected'});
assert.equal(echo.getDraft('a'),'newer');
assert.equal(echo.pendingMessages('a').length,1,'rejected input remains recoverable behind a newer draft');
echo.dismissPendingMessage(rejectedId);

assert.equal(s.resolvePermission('a','lost-gate','allow'), true);
class ReplacementSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  addEventListener() {}
  close() {}
}
globalThis.WebSocket = ReplacementSocket;
globalThis.window = {location:{protocol:'http:',host:'127.0.0.1:8790'}};
s.socket.close = () => {};
s.reconnectNow(true);
assert.equal(s.permissionSubmitting('a','lost-gate'), false, 'force reconnect releases a submission whose frame was lost');

const restoredImage = new Store();
restoredImage.socket = {readyState:1,send(){}};
await restoredImage.sendComposerInput('image-only','',[{type:'image',path:'/tmp/recover.png',mimeType:'image/png'}]);
const imageRecoveryId = restoredImage.pendingMessages('image-only')[0].id;
assert.equal(restoredImage.restorePendingMessage(imageRecoveryId),true);
assert.equal(restoredImage.restorePendingMessage(imageRecoveryId),false,'cannot repeatedly append image attachments');
assert.equal(new Store().pendingMessages('image-only')[0].mentions[0].path,'/tmp/recover.png','restoring image-only input preserves a durable backup across reload');

echo.handleFrame({type:'ready',serverInstanceId:'second'});
assert.deepEqual(readComposerHistory(), [], 'a new process begins with empty history');
assert.equal(saved.has(historyKey), false, 'reconnecting after a restart removes the old cache');
assert.equal(echo.getDraft('a'), 'newer', 'clear affects history only');
rememberComposerInput('older\nmessage');
rememberComposerInput('/status');
const draft = { text: 'draft\nsecond line', caret: 3 };
const history = readComposerHistory();
assert.equal(moveComposerHistory(history, { ...draft, caret: draft.text.length }, null, 'ArrowUp'), null);
const newest = moveComposerHistory(history, draft, null, 'ArrowUp');
assert.equal(newest.text, '/status');
const older = moveComposerHistory(history, newest, newest.browse, 'ArrowUp');
assert.equal(older.text, 'older\nmessage');
assert.equal(moveComposerHistory(history, { ...older, caret: 5 }, older.browse, 'ArrowDown'), null);
assert.deepEqual(moveComposerHistory(history, newest, newest.browse, 'ArrowDown'), { ...draft, browse: null });
assert.deepEqual(moveComposerHistory([], newest, newest.browse, 'ArrowDown'), { ...draft, browse: null });
rememberComposerInput('older\nmessage');
assert.deepEqual(readComposerHistory(), ['older\nmessage', '/status']);
for (let i = 0; i < 105; i++) rememberComposerInput(`entry ${i}`);
assert.equal(readComposerHistory().length, 100);
assert.equal(readComposerHistory()[0], 'entry 104');
disconnectComposerHistory(true);
assert.equal(saved.has(historyKey), false, 'normal server shutdown clears the local cache');
echo.handleFrame({type:'ready',serverInstanceId:'third'});
assert.deepEqual(readComposerHistory(), []);
assert.equal(await new Store().sendComposerInput('a', 'offline'), false);
assert.deepEqual(readComposerHistory(), [], 'a locally rejected send does not add an entry');

// 验证真实组件的延时、确认清理与每条消息独立计时，不等待墙钟时间。
const { default: React } = await import('react');
globalThis.React = React;
const { PendingMessages } = await import('../src/components/PendingMessages.tsx');
const { store } = await import('../src/store.ts');
const originalNow = Date.now;
const originalWindow = globalThis.window;
let now = 100000;
const timers = new Map();
const slots = [];
let cursor = 0;
let effect;
let cleanup;
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const originalDispatcher = internals.H;
const dispatcher = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useEffect(callback, deps) {
    const index = cursor++;
    if (!slots[index] || !Object.is(slots[index][0], deps[0])) { slots[index] = deps; effect = callback; }
  },
  useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, get) => get(),
};
function render(sessionId = 'notice') {
  cursor = 0; effect = null; internals.H = dispatcher;
  const tree = PendingMessages({ sessionId });
  internals.H = originalDispatcher;
  if (effect) { cleanup?.(); cleanup = effect(); }
  return tree;
}
function advance(ms) {
  now += ms;
  for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
}
try {
  Date.now = () => now;
  globalThis.window = {
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  store.socket = { readyState: 1, send() {} };
  assert.equal(render(), null);
  await store.sendComposerInput('notice', 'normal send');
  assert.equal(render(), null, 'no notice on send');
  advance(4999);
  assert.equal(render(), null, 'no notice before five seconds');
  store.dismissPendingMessage(store.pendingMessages('notice')[0].id);
  assert.equal(render(), null);
  assert.equal(timers.size, 0, 'confirmation before deadline cancels the timer');
  await store.sendComposerInput('notice', 'slow send');
  assert.equal(render(), null);
  advance(5000);
  assert.equal(render().props.className, 'pending-message-notice');
  const first = store.pendingMessages('notice')[0].id;
  await store.sendComposerInput('notice', 'second send');
  assert.equal(render().props.children[1].length, 1, 'a new send has its own grace period');
  store.handleFrame({ type: 'ack', action: 'user_message', sessionId: 'notice', clientRequestId: first });
  assert.equal(render(), null, 'ack hides the notice while the newer send is still within its grace period');
  advance(5000);
  assert.ok(render());
  assert.equal(render('another-session'), null, 'never show a different session backup');
  assert.ok(render(), 'switching back does not restart the delay');
  store.dismissPendingMessage(store.pendingMessages('notice')[0].id);
  assert.equal(render(), null);
  assert.equal(timers.size, 0);
  saved.set('workbench-pending-send-legacy', JSON.stringify({ sessionId: 'legacy', text: 'older backup' }));
  assert.equal(new Store().pendingMessages('legacy')[0].sentAt, 0, 'old backups remain immediately recoverable');
  console.log('PASS pending notice grace period, independent deadlines, ack cleanup, session isolation and legacy recovery');
} finally {
  cleanup?.();
  Date.now = originalNow;
  globalThis.window = originalWindow;
  internals.H = originalDispatcher;
}
