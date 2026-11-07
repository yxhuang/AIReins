import assert from 'node:assert/strict';
import { parseDelimited, resolveLocalFileLink } from '../src/file-preview.ts';
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
  const link=new Store(),calls=[];let reply;
  globalThis.fetch=async(url,init)=>{calls.push(String(url));return reply(String(url),init);};
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
  link.clearFilePreview();calls.length=0;
  reply=()=>({json:async()=>({code:40400,msg:'文件不存在'})});
  await link.openFileLink(target('gone.txt'));
  assert.ok(!calls.some(url=>url.includes('open-system')));assert.match(link.filePreview.error,/不存在/);
}
console.log('✅ 会话文件入口：网页不支持的交系统打开，可预览/无能力/读失败走面板');
confirmed=true;
console.log('✅ 文件请求竞态、草稿保留/取消、卸载提醒与冲突后的版本保护');
