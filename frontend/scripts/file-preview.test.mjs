import assert from 'node:assert/strict';
import { imageNeighbors, parseDelimited, resolveLocalFileLink } from '../src/file-preview.ts';
import { Store } from '../src/store.ts';
const cwd='/home/u/项目';
for (const [link,path] of [
 ['README.md',`${cwd}/README.md`], ['./有 空格.md',`${cwd}/有 空格.md`],
 ['../shared/a.ts:12:4','/home/u/shared/a.ts'], ['/tmp/a.md#L12','/tmp/a.md'],
 ['file:///home/u/%E4%B8%AD%E6%96%87%20a.md','/home/u/中文 a.md'],
 [String.raw`C:\My Files\中文.txt`,'/mnt/c/My Files/中文.txt'],
 ['file:///C:/My%20Files/a.txt','/mnt/c/My Files/a.txt'],
 ['vscode://file/home/u/a.ts:12','/home/u/a.ts'],
 ['vscode://file/C:/My%20Files/a.ts:12:4','/mnt/c/My Files/a.ts'],
 ['/a%20b.md','/a b.md'], ['notes/hash%23name.md',`${cwd}/notes/hash#name.md`],
]) assert.equal(resolveLocalFileLink(link,cwd),path,link);
for (const link of ['https://example.com/a.md','http://example.com','mailto:a@b.com','javascript:alert(1)','data:text/html,hi','//example.com/file','#title','file://other-host/a.md','C:relative','/a%00b']) assert.equal(resolveLocalFileLink(link,cwd),null,link);
assert.equal(resolveLocalFileLink('a.md',undefined),null);
assert.deepEqual(parseDelimited('\ufeffa,b\r\n"x,y","line1\nline2"\r\n"escaped ""quote""",z\r\n',',').rows,[['a','b'],['x,y','line1\nline2'],['escaped "quote"','z']]);
assert.deepEqual(parseDelimited('a\tb\n"one\ttwo"\t3','\t').rows,[['a','b'],['one\ttwo','3']]);
assert.deepEqual(parseDelimited('a,b,\n',',').rows,[['a','b','']]);
assert.equal(parseDelimited('',',').rows.length,0);
assert.equal(parseDelimited('a\nb\nc',',',2).truncated,true);
assert.equal(parseDelimited('a\nb\n',',',2).truncated,false);
assert.match(parseDelimited('"unclosed',',').error,/引号/);
assert.match(parseDelimited('a,"x"bad',',').error,/引号/);
assert.equal(parseDelimited('a,b,c',',',200,2).truncated,true);
console.log('✅ 本地链接路径与带引号 CSV/TSV 有限预览');
{
  const entry=name=>({name,path:`/d/${name}`});
  const files=['slide10.png','notes.txt','Slide2.JPG','slide1.png','a.svg'].map(entry);
  assert.deepEqual(imageNeighbors(files,'/d/Slide2.JPG'),{index:2,total:4,prev:'/d/slide1.png',next:'/d/slide10.png'});
  assert.deepEqual(imageNeighbors(files,'/d/a.svg'),{index:0,total:4,prev:null,next:'/d/slide1.png'});
  assert.equal(imageNeighbors(files,'/d/slide10.png').next,null);
  assert.equal(imageNeighbors(files,'/d/notes.txt'),null);
  assert.equal(imageNeighbors([entry('only.png')],'/d/only.png'),null);
}
console.log('✅ 同目录图片按自然序左右切换');

let confirmed=false;
const listeners=new Map();
globalThis.window={innerWidth:1280,location:{hash:'#/'},addEventListener:(name,listener)=>listeners.set(name,listener),confirm:()=>confirmed};
const s=new Store();
const pending=[];
globalThis.fetch=(_url,init)=>new Promise(resolve=>pending.push({resolve,init}));
const target=name=>({path:`/project/${name}`,root:'/project'});
const response=data=>({json:async()=>({code:0,data})});
const file=(path,text,version='v1')=>({path,name:path.split('/').pop(),size:text.length,kind:'text',mimeType:'text/plain',text,version,editable:true});
const a=s.openFilePreview(target('a.txt'));
const b=s.openFilePreview(target('b.txt'));
pending[0].resolve(response(file('/project/a.txt','old')));await a;
assert.equal(s.filePreview.target.path,'/project/b.txt');
pending[1].resolve(response(file('/project/b.txt','original')));await b;
s.updateFileDraft('draft');
assert.equal(s.clearFilePreview(),false,'取消不能丢弃草稿');
s.setFilesOpen(false);
assert.equal(s.filePreview.draft,'draft','收起保留草稿');
let prevented=false;
listeners.get('beforeunload')({preventDefault(){prevented=true}});
assert.equal(prevented,true);
const failedSave=s.saveFilePreview();
pending[2].resolve({json:async()=>({code:40900,msg:'磁盘文件已变更，请重新读取后保存'})});await failedSave;
assert.equal(s.filePreview.draft,'draft');assert.equal(s.filePreview.file.version,'v1');assert.match(s.filePreview.error,/变更/);
const goodSave=s.saveFilePreview();
assert.deepEqual(JSON.parse(pending[3].init.body),{...target('b.txt'),version:'v1',text:'draft'});
pending[3].resolve(response(file('/project/b.txt','draft','v2')));await goodSave;
assert.equal(s.filePreview.file.version,'v2');assert.equal(s.clearFilePreview(),true);
const imageLoad=s.openFilePreview(target('image.png'));
pending[4].resolve(response({path:'/project/image.png',name:'image.png',kind:'image',size:1,mimeType:'image/png',editable:false}));await imageLoad;
assert.equal(s.clearFilePreview(),true,'只读媒体无需放弃草稿确认');
{
  const link=new Store(),calls=[],dirCalls=[],folders=new Set();let reply;
  // 文件夹探测单独记账：文件路径列目录失败，再走原有文件流程。
  globalThis.fetch=async(url,init)=>{
    url=String(url);
    if(url.includes('/api/fs/dirs')){const path=new URL(url,'http://x').searchParams.get('path');dirCalls.push(path);
      return folders.has(path)?{json:async()=>({code:0,data:{path,parent:'/',dirs:[],truncated:false}})}:{json:async()=>({code:40035,msg:'目录不存在、不是目录或无权限读取'})};}
    calls.push(url);return reply(url,init);
  };
  const ok=data=>({json:async()=>({code:0,data})});
  const office={path:'/project/a.pptx',name:'a.pptx',size:1,kind:'unsupported',mimeType:'application/octet-stream',editable:false,reason:'x'};
  reply=()=>ok(office);
  await link.openFileLink(target('a.pptx'));
  assert.equal(calls.length,1,'远程/无系统能力直接预览，不探测也不调用系统');
  assert.ok(calls.every(url=>url.includes('/api/fs/file')));assert.ok(link.filePreview);
  assert.equal(link.clearFilePreview(),true);link.setFilesOpen(false);
  link.meta={capabilities:{systemOpen:true}};calls.length=0;
  reply=url=>url.includes('open-system')?ok({opened:true}):ok(office);
  await link.openFileLink(target('a.pptx'));
  assert.ok(calls.some(url=>url.includes('/api/fs/open-system')));
  assert.equal(link.filePreview,null,'交给系统后不留空白面板');assert.equal(link.filesOpen,false);assert.equal(link.lastError,null);
  reply=url=>url.includes('open-system')?{json:async()=>({code:50390,msg:'无法用系统程序打开'})}:ok(office);
  await link.openFileLink(target('a.pptx'));
  assert.match(link.lastError.message,/无法用系统程序打开/);assert.equal(link.filePreview,null);
  calls.length=0;reply=()=>ok(file('/project/b.txt','text'));
  await link.openFileLink(target('b.txt'));
  assert.ok(!calls.some(url=>url.includes('open-system')));assert.equal(link.filePreview.file.text,'text','可预览的仍进面板');
  assert.equal(calls.filter(url=>url.includes('/api/fs/file')).length,1,'探测结果直接给预览复用，不重复读文件');
  link.clearFilePreview();calls.length=0;
  let autoBody;link.lastError=null;
  reply=(url,init)=>{if(url.includes('open-system')){autoBody=JSON.parse(init.body);return {json:async()=>({code:41590,msg:'此类型不会自动交给系统程序打开'})};}return ok({...office,path:'/project/setup.exe',name:'setup.exe'});};
  await link.openFileLink(target('setup.exe'));
  assert.equal(autoBody.auto,true,'自动交接带 auto，由服务端按真实路径判定');
  assert.equal(link.lastError,null);assert.equal(link.filePreview.file.kind,'unsupported','服务端拒绝自动打开时留在面板由用户决定');
  assert.equal(calls.filter(url=>url.includes('/api/fs/file')).length,1,'拒绝后预览复用探测结果');
  link.clearFilePreview();
  assert.equal(await link.openUnpreviewableInSystem(target('b.txt')),false,'文件面板单击：可预览的交回调用方开标签');
  reply=url=>url.includes('open-system')?ok({opened:true}):ok(office);
  assert.equal(await link.openUnpreviewableInSystem(target('a.pptx')),true);assert.equal(link.filePreview,null);
  calls.length=0;
  reply=()=>({json:async()=>({code:40400,msg:'文件不存在'})});
  await link.openFileLink(target('gone.txt'));
  assert.ok(!calls.some(url=>url.includes('open-system')));assert.match(link.filePreview.error,/不存在/);
  assert.ok(dirCalls.includes('/project/gone.txt'),'每个链接先探测是否文件夹');
  link.clearFilePreview();link.setFilesOpen(false);calls.length=0;folders.add('/project/samples');
  const before=link.fileTabs.length;
  await link.openFileLink(target('samples'));
  assert.equal(calls.length,0,'文件夹链接不再按文件读取，也不交系统打开');
  assert.equal(link.filesOpen,true);assert.equal(link.filePreview,null);
  assert.equal(link.fileTabs.find(tab=>tab.id===link.fileTabId).directory.path,'/project/samples','右侧开该文件夹');
  const tabs=link.fileTabs.length;assert.equal(tabs,before+1);
  await link.openFileLink(target('samples'));
  assert.equal(link.fileTabs.length,tabs,'同一文件夹再点切回已有标签');
}
console.log('✅ 会话文件入口：文件夹开目录标签，网页不支持的交系统打开，可预览/无能力/读失败走面板');
confirmed=true;
console.log('✅ 文件请求竞态、草稿保留/取消、卸载提醒与冲突后的版本保护');
