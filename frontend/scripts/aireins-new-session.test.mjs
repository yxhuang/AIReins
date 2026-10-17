// 阶段 B 合成 API 浏览器检查；由 sidebar-resize.test.mjs 复用同一 Chromium/CDP 入口执行。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultShots = join(tmpdir(), 'aireins-new-session-shots');
const fixture = (locale, theme, options = {}) => `
  const options=${JSON.stringify(options)};
  localStorage.setItem('workbench-language',${JSON.stringify(locale)});
  localStorage.setItem('workbench-theme',${JSON.stringify(theme)});
  localStorage.setItem('workbench-sidebar-default-width','300');
  localStorage.setItem('workbench-sidebar-width','300');
  localStorage.setItem('workbench-sidebar-collapsed','0');
  localStorage.setItem('aireins-project-folds','{}');
  localStorage.removeItem('workbench-last-cwd');
  localStorage.removeItem('workbench-last-session');
  Object.keys(localStorage).filter(key=>key.startsWith('workbench-draft-created-')).forEach(key=>localStorage.removeItem(key));
  if(options.saved!==null)localStorage.setItem('workbench-last-cwd',options.saved??'/saved/project');
  const stamp=new Date().toISOString();
  const session=(id,cwd,hours=0)=>({id,cwd,title:'Synthetic '+id,agent:'claude',status:'idle',config:{},seq:0,
    createdAt:stamp,lastActivityAt:new Date(Date.now()-hours*3600000).toISOString()});
  const sessions=options.empty?[]:[session('recent','/repo/recent'),session('second','/repo/second',1)];
  const model={id:'model',name:'Model',default:'synthetic-model',mutable:true,values:[{value:null,label:'Default'},{value:'synthetic-model',label:'Synthetic model'}]};
  const effort={id:'effort',name:'Effort',default:'high',mutable:true,values:[{value:'low',label:'Low'},{value:'high',label:'High'}]};
  const permission={id:'permissionMode',name:'Permissions',default:'default',mutable:true,values:[{value:'default',label:'Ask'},{value:'auto-review',label:'Auto'},{value:'auto',label:'Auto'}]};
  const meta={claudeDefaults:{model:'opus',effort:'high'},defaultCwd:options.defaultCwd??'/meta/default',homeDir:'/home/demo',
    capabilities:options.mac?{terminal:false}:{terminal:false,windowsPaths:true,windowsDirectoryPicker:true},
    drivers:Object.fromEntries(['claude','codex','kimi'].map(id=>[id,{options:[id==='claude'?{...model,default:null,values:[{value:null,label:'Follow Claude settings'},{value:'opus',label:'Opus'},{value:'synthetic-model',label:'Synthetic model'}]}:model,effort,permission],available:true,usage:false,interrupt:false,commands:true,mentions:true}]))};
  const fixtures={'/api/meta':meta,'/api/sessions':{sessions},'/api/project-order':{paths:['/repo/recent','/repo/second']},
    '/api/pages':{pages:[]},'/api/links':{links:[]},'/api/prefs':{idleReleaseMinutes:0},'/api/claude/settings':{remoteControlAtStartup:false}};
  const f=window.__newFixture={manyDirs:!!options.manyDirs,sessions,sent:[],uploads:[],creates:[],writes:[],directories:[],history:[],fail:false,hold:false};
  const response=(data,code=0,msg='')=>new Response(JSON.stringify({code,data,msg,request_id:'aireins-new-fixture'}),{headers:{'content-type':'application/json'}});
  const realFetch=window.fetch;
  window.fetch=(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname;
    if(!path.startsWith('/api/'))return realFetch(input,init);
    if(path==='/api/uploads'){
      const name=url.searchParams.get('name');f.uploads.push({name,sessionId:url.searchParams.get('sessionId'),size:init.body.size});
      if(f.uploadFail)return Promise.resolve(response({},50001,'Synthetic upload failed'));
      return Promise.resolve(response({path:'/synthetic/uploads/'+name,name,size:init.body.size,mimeType:init.body.type||'text/plain'}));
    }
    if(init?.method&&init.method!=='GET'){
      const body=JSON.parse(init.body??'{}');f.writes.push({path,body});
      if(path==='/api/fs/pick-directory')return Promise.resolve(response({path:'/mnt/c/selected'}));
      if(path!=='/api/sessions'||init.method!=='POST')throw new Error('Unexpected synthetic write '+path);
      f.creates.push(body);
      if(f.fail)return Promise.resolve(response({},50001,'Synthetic create failed'));
      const created={...session('created-'+f.creates.length,body.cwd),agent:body.agent,config:body.config??{}};
      sessions.push(created);
      if(f.hold)return new Promise(resolve=>{f.finish=()=>resolve(response({session:created}));});
      return Promise.resolve(response({session:created}));
    }
    if(path==='/api/meta'&&options.delayMeta)return new Promise(resolve=>{f.finishMeta=()=>resolve(response(meta));});
    if(path==='/api/sessions'&&options.delaySessions)return new Promise(resolve=>{f.finishSessions=()=>resolve(response({sessions}));});
    if(path==='/api/fs/dirs'){
      const current=url.searchParams.get('path')??'/meta/default';f.directories.push(current);
      const names=f.manyDirs?Array.from({length:60},(_,index)=>'folder-'+String(index).padStart(2,'0')):['nested'];
      return Promise.resolve(response({path:current,parent:'/',dirs:names.map(name=>({name,path:current+'/'+name})),files:[]}));
    }
    if(path==='/api/history'){
      f.history.push(Object.fromEntries(url.searchParams));
      return Promise.resolve(response({sessions:[],truncated:false,skipped:0,empty:0,discovered:0,durationMs:0}));
    }
    if(path.endsWith('/snapshot')){
      const id=decodeURIComponent(path.split('/')[3]);return Promise.resolve(response({session:sessions.find(item=>item.id===id),seq:0,events:[],hasMore:false,firstSeq:0}));
    }
    if(path.endsWith('/commands'))return Promise.resolve(response({commands:[{name:'review',description:'Review changes',argHint:'Instructions',source:'codex'},{name:'help',description:'Help',source:'claude'}]}));
    return Promise.resolve(response(fixtures[path]??{}));
  };
  window.WebSocket=class{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=1;addEventListener(){}close(){}send(raw){f.sent.push(JSON.parse(raw));}};
`;

// 新建页地址栏即工作目录：已读出的目录看当前面包屑，未读出或空目录看输入框。
export const NEW_CWD = "(document.querySelector('.new-form .dir-address-crumbs [aria-current=location]')?.title ?? document.querySelector('.new-form .dir-address input')?.value ?? '')";

export async function runNewSessionBrowserChecks({ send, evaluate, settle, waitFor, rect, click, key, check, base, activate, shots = defaultShots }) {
  mkdirSync(shots, { recursive: true });
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot');
    writeFileSync(join(shots, name+'.png'), Buffer.from(result.data, 'base64'));
  };
  const input = async text => {
    await evaluate(`(() => {const field=document.querySelector('.new-form textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});
      field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();})()`);
    await settle();
  };
  const select = async value => {
    await click('.new-form .dir-recent-toggle');
    await click(`.new-form .dir-recent-option[title=${JSON.stringify(value)}]`);
    await waitFor(`${NEW_CWD}===${JSON.stringify(value)}`);
  };
  const cwd = () => evaluate(NEW_CWD);
  const showNew = async path => {
    await evaluate(`import('/src/store.ts').then(({store})=>store.navigateNew(${JSON.stringify(path)}))`);
    await waitFor("document.querySelector('.new-form textarea')"); await settle();
  };
  const open = async (width, locale, theme, options) => {
    const target = await send('Target.createTarget',{url:'about:blank'},null);
    activate((await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId);
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:900,deviceScaleFactor:1,mobile:width===390});
    await send('Emulation.setTouchEmulationEnabled',{enabled:width===390});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:fixture(locale,theme,options)});
    await send('Page.navigate',{url:base});
    await waitFor("document.querySelector('.btn-new-session')");
    await click('.btn-new-session');
    await waitFor("document.querySelector('.new-form .new-project-row .dir-address')"); await settle();
    return target.targetId;
  };
  for (const width of [1440,390]) for (const locale of ['zh-CN','en']) for (const theme of ['light','dark']) {
    const variant=`${width}-${locale}-${theme}`;
    await check(`阶段 B ${variant}：主页输入、目录选择、组与历史预选、提交及手机路由`,async()=>{
      const target=await open(width,locale,theme);
      assert.equal(await cwd(),'/saved/project','上次成功目录优先');
      assert.equal(await evaluate("document.activeElement===document.querySelector('.new-form textarea')"),width!==390,'桌面新建聚焦输入框，手机不弹输入法');
      assert.equal(await evaluate("document.querySelector('.new-project-row').getAttribute('aria-label')"),locale==='en'?'Project':'项目');
      assert.ok(await evaluate("!document.querySelector('.sidebar .new-form') && !!document.querySelector('.main .new-form')"));
      const area=await rect('.new-form textarea');
      assert.ok(area.height>=80 && area.width>250,'主页大输入框');
      {const box=await rect('.new-form .composer-box'),view=await rect('.welcome-view');
        assert.ok(Math.abs((box.y+box.height/2)-(view.y+view.height/2))<=2,`输入卡片在主区垂直居中 ${JSON.stringify({box,view})}`);}
      assert.equal(await evaluate("document.documentElement.dataset.theme"),theme);
      if(width===390){
        assert.equal(await evaluate('location.hash'),'#/new');
        assert.ok((await rect('.main')).width>=389,'手机新建全屏主区');
        assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.new-form textarea')).fontSize)>=16"),'触屏输入字号至少16px');
      }
      await screenshot(variant+'-home');
      assert.ok(await evaluate("!document.querySelector('.new-form .dir-list') && !document.querySelector('.dir-dialog')"),'目录列表默认收起、不弹窗');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.new-form .dir-nav .btn')].map(node=>node.textContent)"),['WSL','Windows',locale==='en'?'Browse folders':'浏览文件夹'],'WSL/Windows 在左下，列表开关在右');
      if(width===1440) assert.ok((await rect('.new-form .composer-box')).width>=700,'桌面输入卡片约 800px');
      assert.ok((await rect('.new-agents')).width < (await rect('.new-form .composer-box')).width,'agent分段按钮随内容');
      for(const kind of ['claude','codex','kimi']) {
        await click('.new-agent.agent-'+kind);
        assert.ok(!(await evaluate("document.querySelector('.new-form .cfg-pill-model').textContent")).includes('默认'),'显示真实默认模型');
        await screenshot(variant+'-model-'+kind);
      }
      await click('.new-agent.agent-claude');
      assert.ok(await evaluate("document.querySelector('.new-slash').disabled"),'无已加载表时命令入口禁用');
      await evaluate(`import('/src/store.ts').then(({store})=>{store.commands.set('recent',[
        {name:'write',description:'Write a draft',argHint:'Topic',source:'claude'},
        {name:'compact',description:'Existing session action',source:'claude'},
        {name:'btw',description:'Side question',source:'claude'}]);store.notify();})`);
      await waitFor("!document.querySelector('.new-slash').disabled");
      await click('.new-slash'); await waitFor("document.querySelector('.new-command-panel')");
      assert.equal(await evaluate("document.querySelectorAll('.new-command-panel .cmd-item').length"),1,'仅提供新会话可插入命令');
      if(width===390) assert.ok((await rect('.new-command-panel .cmd-item')).height>=44,'命令候选触控44px');
      await screenshot(variant+'-slash-menu');
      await input('/wr');
      await key('Tab');
      assert.equal(await evaluate("document.querySelector('.new-form textarea').value"),'/write ','Tab只插入不发送');
      assert.equal(await evaluate('window.__newFixture.creates.length'),0);
      await input('');
      await evaluate(`(() => {const files=new DataTransfer();files.items.add(new File(['Attachment contents'],'notes.txt',{type:'text/plain'}));
        const field=document.querySelector('.new-form input[type=file]');field.files=files.files;field.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle();
      await evaluate(`(() => {const data=new DataTransfer();
        data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'}));
        document.querySelector('.new-form textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);await settle();
      await evaluate(`(() => {const data=new DataTransfer();data.items.add(new File(['Drop file'],'drop.txt',{type:'text/plain'}));
        document.querySelector('.new-form .composer-box').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`);await settle();
      assert.equal(await evaluate("document.querySelectorAll('.new-form .attach-card').length"),3,'选择、粘贴、拖放复用附件卡片');
      assert.equal(await evaluate('window.__newFixture.uploads.length'),0,'真实会话创建之前附件仅保留本地');
      if(width===390) {const hit=await rect('.new-form .attach-remove');assert.ok(hit.width>=44 && hit.height>=44,'附件移除触控44px');}
      await screenshot(variant+'-attachments');
      await evaluate("document.querySelectorAll('.new-form .attach-remove').forEach(button=>button.click())");await settle();
      if(width===390){
        const targets=await evaluate("[...document.querySelectorAll('.new-agent,.new-form .attach-btn,.new-form .send-btn,.new-form .dir-nav .btn,.new-form .cfg-pill')].map(node=>({cls:node.className,w:node.getBoundingClientRect().width,h:node.getBoundingClientRect().height}))");
        assert.ok(targets.every(target=>target.w>=44&&target.h>=44),JSON.stringify(targets));
      }
      await click('.new-form .dir-recent-toggle'); await waitFor("document.querySelector('.new-form .dir-recent-option')");
      assert.ok(await evaluate("!document.querySelector('.new-form .dir-list')"),'最近下拉不展开浏览列表');
      await screenshot(variant+'-project-dropdown');
      await key('Escape');

      await click('.new-form .dir-list-toggle'); await waitFor("document.querySelector('.new-form .dir-entry')");
      await click('.new-form .dir-entry[aria-label="nested"]');
      await waitFor(`${NEW_CWD}==='/saved/project/nested'`);
      assert.ok(await evaluate("!!document.querySelector('.new-form .dir-list')"),'进子目录后列表保持展开');
      await screenshot(variant+'-browse');
      await evaluate("document.querySelector('.new-form .dir-entry').focus()");
      await key('Escape');
      assert.ok(await evaluate("!document.querySelector('.new-form .dir-list')"),'Esc 收起列表');
      await click('.new-form .dir-address-crumbs button[title="/saved/project"]');
      await waitFor(`${NEW_CWD}==='/saved/project' && !!document.querySelector('.new-form .dir-entry')`);
      assert.equal(await cwd(),'/saved/project','点上层面包屑即选定并展开列表');
      await select('/repo/recent');
      assert.ok(await evaluate("!document.querySelector('.new-form .dir-list')"),'选最近目录后收起列表');
      await click('.new-form .dir-list-toggle'); await waitFor("document.querySelector('.new-form .dir-entry')");
      await click('.new-form .dir-entry[aria-label="nested"]');
      await waitFor(`${NEW_CWD}==='/repo/recent/nested'`);
      await input('Preserve draft'); await click('.new-agent.agent-codex');
      if(width===390)await click('.new-session-back');
      await click('.sidebar-project[data-project-path="/repo/second"] .project-action:not([aria-haspopup])');
      assert.equal(await cwd(),'/repo/second','组+预选目录');
      assert.equal(await evaluate("document.querySelector('.new-form textarea').value"),'Preserve draft','组+保留首条消息草稿');
      assert.ok(await evaluate("!!document.querySelector('.new-agent.agent-codex.selected')"),'组+保留agent选择');
      if(width===1440){
        assert.equal(await evaluate("document.querySelector('.new-form textarea').value"),'Preserve draft','换组保留输入草稿');
        assert.ok(await evaluate("!!document.querySelector('.new-agent.agent-codex.selected')"),'换组保留agent');
      }
      await screenshot(variant+'-group-new');
      if(width===390){
        await evaluate('history.back()'); await waitFor("!document.querySelector('.app').classList.contains('has-main')");
        await evaluate('history.forward()'); await waitFor(`${NEW_CWD}==='/repo/second'`);
        assert.equal(await evaluate('location.hash'),'#/new','前进恢复新建路由及目录');
        await click('.new-session-back');
      }
      await evaluate("import('/src/store.ts').then(({store})=>store.navigateHistory('/repo/recent'))");
      await waitFor("document.querySelector('.history-cwd-chip')");
      await click('.btn-new-session');
      await waitFor(`${NEW_CWD}==='/repo/recent'`);
      await screenshot(variant+'-history-new');
      await select('/repo/second');
      await click('.new-agent.agent-codex');
      await click('.new-form .cfg-pill-model');
      await evaluate("[...document.querySelectorAll('.cfg-item')].find(node=>node.textContent.includes('Synthetic model')).click()"); await settle();
      await input('  Hello from AIReins  ');
      await key('Enter');
      await waitFor("window.__newFixture.creates.length===1 && location.hash.startsWith('#/session/created-')");
      assert.deepEqual(await evaluate('window.__newFixture.creates[0]'),{snapshot:'skip',agent:'codex',cwd:'/repo/second',config:{permissionMode:'auto-review',model:'synthetic-model'}});
      assert.equal(await evaluate("localStorage.getItem('workbench-last-cwd')"),'/repo/second');
      assert.ok(await evaluate("window.__newFixture.sent.some(frame=>frame.type==='user_message' && frame.text==='Hello from AIReins')"),'首条消息通过统一 WS 发送，不带 initialMessage');
      await screenshot(variant+'-created');
      await showNew('/repo/second');
      await evaluate("import('/src/store.ts').then(({store})=>{store.meta={...store.meta,defaultCwd:''};store.sessions=[];localStorage.removeItem('workbench-last-cwd');store.navigateNew('');})"); await settle();
      assert.ok(await evaluate("document.querySelector('.new-submit').disabled && !!document.querySelector('.new-hint')?.textContent.trim()"),'空目录禁用并提示');
      await evaluate("document.querySelector('.new-form').requestSubmit()");await settle();
      assert.equal(await evaluate('window.__newFixture.creates.length'),1,'空目录不能触发POST');
      await screenshot(variant+'-no-directory');
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'主页无横向溢出');
      await send('Target.closeTarget',{targetId:target},null);
    });
  }
  await check('阶段 B 回填、Enter/Shift+Enter/IME、失败与busy防重复、Windows选择请求',async()=>{
    let target=await open(1280,'en','light',{saved:null});
    assert.equal(await cwd(),'/repo/recent','无保存目录时取最近活跃会话');
    await send('Target.closeTarget',{targetId:target},null);
    target=await open(1280,'en','light',{saved:null,empty:true});
    assert.equal(await cwd(),'/meta/default','无会话时取meta默认目录');
    await send('Target.closeTarget',{targetId:target},null);
    for(const delayed of ['delayMeta','delaySessions']){
      target=await open(1280,'en','light',{saved:null,empty:delayed==='delayMeta',defaultCwd:delayed==='delayMeta'?'/meta/late':'',[delayed]:true});
      assert.equal(await cwd(),'','数据晚到之前不凭空选目录');
      await evaluate(`window.__newFixture.${delayed==='delayMeta'?'finishMeta':'finishSessions'}()`);
      await waitFor(`${NEW_CWD}===${JSON.stringify(delayed==='delayMeta'?'/meta/late':'/repo/recent')}`);
      await send('Target.closeTarget',{targetId:target},null);
    }
    target=await open(1280,'en','light');
    await waitFor("document.querySelector('.new-form .dir-windows-picker:not(:disabled)')");
    await click('.new-form .dir-windows-picker');
    // 内嵌地址栏不传 onSelectDirectory：原生窗口确认后 load() 该目录，导航即选定。
    await waitFor(`${NEW_CWD}==='/mnt/c/selected'`);
    const nativeSelection = await evaluate(`import('/src/store.ts').then(({store})=>({request:window.__newFixture.writes.at(-1),project:${NEW_CWD},routeCwd:store.newSessionCwd,directoryRequests:window.__newFixture.directories}))`);
    console.log('Windows picker evidence:', JSON.stringify(nativeSelection));
    assert.deepEqual(nativeSelection.request,{path:'/api/fs/pick-directory',body:{path:'/saved/project'}});
    assert.equal(nativeSelection.project,'/mnt/c/selected','原生确认后直接应用目录');
    assert.equal(nativeSelection.routeCwd,'/mnt/c/selected','目录同时写入路由快照');
    await input('draft');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,modifiers:8,text:'\r',unmodifiedText:'\r'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,modifiers:8});await settle();
    assert.equal(await evaluate('window.__newFixture.creates.length'),0,'Shift Enter不发送');
    assert.ok(await evaluate("document.querySelector('.new-form textarea').value.includes('\\n')"),'Shift Enter换行');
    await evaluate("document.querySelector('.new-form textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true}))");await settle();
    assert.equal(await evaluate('window.__newFixture.creates.length'),0,'IME Enter不发送');
    await evaluate('window.__newFixture.fail=true');await key('Enter');
    await waitFor("document.querySelector('.new-form').textContent.includes('Synthetic create failed')");
    await screenshot('1280-en-light-create-error');
    await evaluate('window.__newFixture.fail=false;window.__newFixture.hold=true');
    // 创建期间禁用输入会失去焦点；失败后的重试显式点击创建按钮。
    await click('.new-submit');await waitFor('!!window.__newFixture.finish');
    await evaluate("document.querySelector('.new-form').requestSubmit();document.querySelector('.new-form').requestSubmit()");await settle();
    assert.equal(await evaluate('window.__newFixture.creates.length'),2,'创建中重复提交仅一个请求');
    await evaluate('window.__newFixture.finish()');
    await waitFor("location.hash.startsWith('#/session/created-')");
    await send('Target.closeTarget',{targetId:target},null);
  });
  await check('新建页非 Windows（Mac/Linux）：无 WSL/Windows 按钮，左侧图标展开列表',async()=>{
    const target=await open(1280,'en','light',{mac:true,manyDirs:true});
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.new-form .dir-nav .btn')].map(node=>node.textContent)"),['Browse folders']);
    const logo=await rect('.empty-logo'),box=await rect('.new-form .composer-box'),view=await rect('.welcome-view');
    assert.ok(Math.abs((box.y+box.height/2)-(view.y+view.height/2))<=2,'输入卡片本身在整个主区（含顶栏）垂直居中');
    await click('.new-form .dir-windows-picker'); await waitFor("document.querySelectorAll('.new-form .dir-entry').length===60");
    assert.equal((await rect('.empty-logo')).y,logo.y,'展开列表不挪动标志与输入框');
    assert.ok(await evaluate("(()=>{const v=document.querySelector('.welcome-view'),l=document.querySelector('.new-form .dir-list');return v.scrollHeight<=v.clientHeight&&l.scrollHeight>l.clientHeight&&l.getBoundingClientRect().bottom<=innerHeight;})()"),'长列表只在列表内滚动，首页不出现滚动条');
    assert.equal(await evaluate("document.querySelector('.new-form .dir-windows-picker').getAttribute('aria-expanded')"),'true');
    assert.equal(await evaluate("window.__newFixture.writes.length"),0,'不请求原生选择窗口');
    await screenshot('1280-en-light-mac-browse');
    await send('Target.closeTarget',{targetId:target},null);
  });
  await check('阶段 C 首条附件/命令同路发送、上传失败重试、断线与服务端拒绝回填',async()=>{
    let target=await open(1440,'en','light');
    await input('Attachment first');
    await evaluate(`(() => {const data=new DataTransfer();data.items.add(new File(['Document'],'first.txt',{type:'text/plain'}));
      const field=document.querySelector('.new-form input[type=file]');field.files=data.files;field.dispatchEvent(new Event('change',{bubbles:true}));window.__newFixture.uploadFail=true;})()`);await settle();
    await click('.new-submit');await waitFor("document.querySelector('.new-error')?.textContent.includes('Synthetic upload failed')");
    assert.equal(await evaluate('window.__newFixture.creates.length'),1);
    assert.equal(await evaluate("document.querySelector('.new-form textarea').value"),'Attachment first');
    await evaluate('window.__newFixture.uploadFail=false');await click('.new-submit');
    await waitFor("location.hash.startsWith('#/session/created-')");
    assert.equal(await evaluate('window.__newFixture.creates.length'),1,'上传失败重试不重复建会话');
    const frame=await evaluate("window.__newFixture.sent.find(frame=>frame.type==='user_message')");
    assert.equal(frame.text,'Attachment first');assert.deepEqual(frame.mentions,[{type:'file',path:'/synthetic/uploads/first.txt',name:'first.txt'}]);
    await evaluate(`import('/src/store.ts').then(({store})=>store.handleFrame({type:'error',sessionId:${JSON.stringify('created-1')},clientRequestId:${JSON.stringify(frame.clientRequestId)},msg:'Synthetic send rejected'}))`);
    await waitFor("document.querySelector('.composer textarea')?.value==='Attachment first'");
    assert.ok(await evaluate("document.querySelector('.composer .attach-card')?.textContent.includes('first.txt')"),'异步拒绝还回文本与附件');
    await screenshot('1440-en-light-rejected-first-attachment');
    await send('Target.closeTarget',{targetId:target},null);
    target=await open(1440,'en','light');
    await click('.new-agent.agent-codex');await input('/review Check types');await click('.new-submit');
    await waitFor("window.__newFixture.sent.some(frame=>frame.command?.name==='review')");
    assert.deepEqual(await evaluate("window.__newFixture.sent.find(frame=>frame.command)?.command"),{name:'review',arguments:'Check types'});
    assert.ok(await evaluate("!('initialMessage' in window.__newFixture.creates[0])"));
    await send('Target.closeTarget',{targetId:target},null);
    target=await open(1440,'en','light');
    await input('Offline first');
    await evaluate("import('/src/store.ts').then(({store})=>{store.socket={readyState:3};})");
    await click('.new-submit');await waitFor("document.querySelector('.composer textarea')?.value==='Offline first'");
    await send('Target.closeTarget',{targetId:target},null);
  });
  console.log(`阶段 C 新建页截图：${shots}（8种组合：整体、三家模型、附件、命令、原生项目选择及创建/错误状态）`);
}
