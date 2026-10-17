import assert from 'node:assert/strict';
globalThis.WebSocket={CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3};
const {Store}=await import('../src/store.ts');

function fixture({chromiumHash=false,mobile=false}={}){
  const entries=[{hash:'#/session/fixture',state:null}],pending=[];let index=0;
  const store=new Store();store.currentId='fixture';store.ensureLoaded=async()=>{};
  const location={get hash(){return entries[index].hash},set hash(hash){entries.splice(index+1);entries.push({hash,state:null});index++;
    // Chromium fires popstate synchronously inside the hash write, hashchange later.
    if(chromiumHash){store.onPopState();pending.push(()=>store.onHashChange())}}};
  const history={get state(){return entries[index].state},get length(){return entries.length},
    replaceState(state,_title,hash){entries[index]={state:structuredClone(state),hash}},
    pushState(state,_title,hash){entries.splice(index+1);entries.push({state:structuredClone(state),hash});index++},
    back(){pending.push(()=>{if(!index)return;index--;store.onPopState();store.onHashChange()})},
    forward(){pending.push(()=>{if(index>=entries.length-1)return;index++;store.onPopState();store.onHashChange()})},
  };
  globalThis.window={location,history,matchMedia:()=>({matches:mobile})};
  const settle=()=>{while(pending.length)pending.shift()()};
  return {store,history,settle,back(){history.back();settle()}};
}
// These fail when desktop files/terminal omit browser history, or popstate restores stale panels.
for(const open of [s=>s.setFilesOpen(true),s=>s.setTerminalOpen(true),s=>s.toggleDispatches()]){
  const f=fixture();open(f.store);f.back();
  assert.equal(f.store.filesOpen||f.store.termOpen||f.store.dispatchesOpen,false,'Back closes the right panel');
  assert.equal(f.store.currentId,'fixture','Back retains the current session');
}
for(const open of [s=>s.navigateHistory(),s=>s.navigatePage('ai-usage')]){
  const f=fixture();open(f.store);f.back();
  assert.equal(f.store.historyOpen,false);assert.equal(f.store.currentPageId,null);
  assert.equal(f.store.currentId,'fixture');
}
for(const leftLast of [false,true]){
  const f=fixture(),s=f.store;
  if(leftLast){s.setFilesOpen(true);s.navigateHistory()}else{s.navigateHistory();s.setFilesOpen(true)}
  f.back();assert.equal(s.filesOpen,leftLast);assert.equal(s.historyOpen,!leftLast);
  f.back();assert.equal(s.filesOpen,false);assert.equal(s.historyOpen,false);assert.equal(s.currentId,'fixture');
}
{
  const f=fixture(),s=f.store;s.navigateHistory();s.setFilesOpen(true);s.navigatePage('ai-usage');
  f.back();assert.equal(s.currentPageId,null);assert.equal(s.historyOpen,false);assert.equal(s.filesOpen,true);
  f.back();assert.equal(s.filesOpen,false);assert.equal(s.historyOpen,false,'older sidebar pages do not reappear');
}
{
  const f=fixture(),s=f.store;s.setFilesOpen(true);s.setTerminalOpen(true);s.toggleDispatches();
  f.back();assert.equal(s.filesOpen||s.termOpen||s.dispatchesOpen,false,'right-panel switches close as one panel');
}
{
  const f=fixture(),s=f.store;s.navigateHistory();s.setFilesOpen(true);s.setFilesOpen(false);f.settle();
  f.back();assert.equal(s.historyOpen,false,'manual right close leaves left as the latest open panel');
}
{
  const f=fixture(),s=f.store;s.setFilesOpen(true);s.filePreview={draft:'unsaved',file:{editable:true,text:'original'}};f.back();
  assert.equal(s.filePreview.draft,'unsaved','panel back preserves the file draft');
  f.history.forward();f.settle();assert.equal(s.filesOpen,true,'Forward restores the panel');
}
{
  const f=fixture(),s=f.store;s.setTerminalOpen(true);
  s.meta={capabilities:{terminal:false}};s.onHashChange();f.settle();
  assert.equal(s.termOpen,false,'restoring desktop state respects terminal capability');
}
console.log('PASS: desktop panel Back ordering, switches, manual close, draft and Forward');
{
  const f=fixture(),s=f.store;let previous=2;
  s.setFilesOpen(true);s.navigateHistory();
  s.fileBrowserBack=()=>previous>0?(previous--,true):false;
  f.back();assert.equal(previous,1);assert.equal(s.filesOpen,true);assert.equal(s.historyOpen,true,'directory Back precedes sidebar closing');
  f.back();assert.equal(previous,0);assert.equal(s.filesOpen,true);
  f.back();assert.equal(s.historyOpen,false,'after directory history, original sidebar Back resumes');
  f.back();assert.equal(s.filesOpen,false);
}
{
  const f=fixture(),s=f.store;let calls=0;
  s.setFilesOpen(true);s.fileBrowserBack=()=>{calls++;return true};
  s.setFilesOpen(false);f.settle();assert.equal(calls,0,'manual collapse bypasses directory history');
  s.setFilesOpen(true);s.filePreview={draft:'unsaved',file:{editable:true,text:'original'}};
  f.back();assert.equal(calls,0,'file previews keep the previous draft-preserving panel Back');assert.equal(s.filePreview.draft,'unsaved');
}
console.log('PASS: directory Back priority and manual/preview bypass');
{
  // 历史面板「打开会话」：Chromium 同步 popstate 曾被当成 Back 关面板，把 URL 改回旧会话。
  const f=fixture({chromiumHash:true}),s=f.store;
  s.sessions=[{id:'fixture'},{id:'other'}];
  s.navigateHistory();s.navigate('other');f.settle();
  assert.equal(s.currentId,'other','open-session from history lands on the target session');
  assert.equal(s.historyOpen,false);
  assert.equal(window.location.hash,'#/session/other');
}
console.log('PASS: navigate under synchronous popstate');

// 新建页和目录属于导航快照；面板及会话不能覆盖返回的新建目录。
for(const mobile of [false,true]){
  const f=fixture({mobile}),s=f.store;
  s.navigate(null);
  s.navigateNew('/project/explicit');
  assert.equal(window.location.hash,'#/new');
  assert.equal(s.newSessionOpen,true);assert.equal(s.currentId,null);
  assert.equal(s.newSessionCwd,'/project/explicit');
  s.setNewSessionCwd('/project/selected');
  for(const open of [()=>s.setFilesOpen(true),()=>s.setTerminalOpen(true),()=>s.toggleDispatches()]){
    open();f.back();
    assert.equal(s.newSessionOpen,true,'panel Back restores the new page');
    assert.equal(s.newSessionCwd,'/project/selected');
    assert.equal(window.location.hash,'#/new');
  }
  s.navigate('created');f.back();
  assert.equal(s.newSessionOpen,true);assert.equal(s.currentId,null);
  assert.equal(s.newSessionCwd,'/project/selected');
  f.history.forward();f.settle();
  assert.equal(s.newSessionOpen,false);assert.equal(s.currentId,'created');
}
{
  const f=fixture({mobile:true}),s=f.store;s.navigate(null);s.navigateNew('/first');
  const length=f.history.length;
  s.navigateNew('/second');
  assert.equal(s.newSessionRequest,2);assert.equal(s.newSessionCwd,'/second');
  assert.equal(f.history.length,length,'reopening new focuses without another history entry');
  f.back();assert.equal(s.newSessionOpen,false);assert.equal(window.location.hash,'#/');
  f.history.forward();f.settle();assert.equal(s.newSessionCwd,'/second');
}
{
  const f=fixture({mobile:true}),s=f.store;s.navigateNew('/explicit');
  const state=structuredClone(f.history.state);
  delete state.workbenchNavigation.route.newSessionOpen;
  delete state.workbenchNavigation.route.newSessionCwd;
  f.history.replaceState(state,'','#/new');s.onHashChange();
  assert.equal(s.newSessionOpen,true,'old snapshots infer the new page from its hash');
  assert.equal(s.newSessionCwd,undefined,'old snapshots leave directory fallback to the form');
  s.navigate('old-session');
  const sessionState=structuredClone(f.history.state);
  delete sessionState.workbenchNavigation.route.newSessionOpen;
  delete sessionState.workbenchNavigation.route.newSessionCwd;
  f.history.replaceState(sessionState,'','#/session/old-session');s.onHashChange();
  assert.equal(s.newSessionOpen,false);assert.equal(s.currentId,'old-session');
}
console.log('PASS: AIReins new-page routes, directory snapshots, panel and session Back/Forward, old state');

{
  const f=fixture(),s=f.store;
  s.navigateNew('/older');s.setFilesOpen(true);f.back();
  s.navigate('between');s.navigateNew('/newer');f.back();f.back();
  assert.equal(s.newSessionCwd,'/older','desktop panels retain earlier new-page directory snapshots');
}
{
  const f=fixture();window.location.hash='#/new';f.store.onHashChange();
  assert.equal(f.store.newSessionOpen,true);assert.equal(f.store.newSessionCwd,undefined);
  assert.ok(f.history.state.workbenchNavigation,'desktop direct new links have a complete route snapshot');
}
