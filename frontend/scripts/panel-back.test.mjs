import assert from 'node:assert/strict';
globalThis.WebSocket={CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3};
const {Store}=await import('../src/store.ts');

function fixture(){
  const entries=[{hash:'#/session/fixture',state:null}],pending=[];let index=0;
  const store=new Store();store.currentId='fixture';store.ensureLoaded=async()=>{};
  const location={get hash(){return entries[index].hash},set hash(hash){entries.splice(index+1);entries.push({hash,state:null});index++}};
  const history={get state(){return entries[index].state},get length(){return entries.length},
    replaceState(state,_title,hash){entries[index]={state:structuredClone(state),hash}},
    pushState(state,_title,hash){entries.splice(index+1);entries.push({state:structuredClone(state),hash});index++},
    back(){pending.push(()=>{if(!index)return;index--;store.onPopState();store.onHashChange()})},
    forward(){pending.push(()=>{if(index>=entries.length-1)return;index++;store.onPopState();store.onHashChange()})},
  };
  globalThis.window={location,history,matchMedia:()=>({matches:false})};
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
