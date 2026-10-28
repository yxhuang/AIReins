import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
globalThis.WebSocket = { OPEN: 1 };
const saved = new Map();
globalThis.localStorage = { get length() { return saved.size; }, key(i) { return [...saved.keys()][i] ?? null; }, getItem(k) { return saved.get(k) ?? null; }, setItem(k,v) { saved.set(k,v); }, removeItem(k) { saved.delete(k); } };
const s = new Store();
const frames = [];
s.socket = { readyState: 1, send(raw) { frames.push(JSON.parse(raw)); } };
s.setDraft('a', 'hello');
await s.sendComposerInput('a', 'hello', [{type:'file',path:'/tmp/a'}]);
assert.equal(s.pendingMessages('a').length, 1);
const requestId = frames[0].clientRequestId;
const refreshed = new Store();
assert.equal(refreshed.pendingMessages('a')[0].text, 'hello');
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
