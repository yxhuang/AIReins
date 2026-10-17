// 真实 Chromium 拖动/布局回归；只使用合成 API，不连接真实会话。
// CHROMIUM 可指定 Linux Chromium；默认复用本机 Playwright 的 headless shell。
import assert from "node:assert/strict";
import { runNewSessionBrowserChecks } from "./aireins-new-session.test.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const output = mkdtempSync(join(tmpdir(), "workbench-sidebar-resize-"));
const cache = join(homedir(), ".cache/ms-playwright");
const chromium = process.env.CHROMIUM ?? join(cache,
  readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().at(-1),
  "chrome-headless-shell-linux64/chrome-headless-shell");
const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = spawn(chromium, ["--no-sandbox", "--headless", "--remote-debugging-pipe",
  `--user-data-dir=${join(output, "profile")}`], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let stderr = "", buffer = "", id = 0, sessionId, onNativeDrag;
const pending = new Map();
const errors = [];
browser.stderr.on("data", (data) => { stderr += data; });
const rejectPending = (error) => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear();
};
browser.on("error", rejectPending);
browser.on("exit", (code) => rejectPending(new Error(`Chromium exited ${code}: ${stderr.slice(-1500)}`)));
browser.stdio[4].on("data", (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "Input.dragIntercepted") onNativeDrag?.(message.params.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
const send = (method, params = {}, target = sessionId) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out: ${stderr.slice(-1000)}`)); }, 10000);
  pending.set(requestId, { resolve, reject, timer });
  browser.stdio[3].write(JSON.stringify({ id: requestId, method, params, ...(target ? { sessionId: target } : {}) }) + "\0");
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
const settle = () => evaluate("new Promise(resolve => setTimeout(resolve, 200))");
const waitFor = (condition) => evaluate(`new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  const check = () => { if (${condition}) resolve(true); else if (Date.now() > deadline) reject(new Error('UI readiness timed out')); else requestAnimationFrame(check); }; check();
})`);
const rect = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`);
const click = async (selector) => {
  // 面板 section 与入口 button 可共享 aria-label，交互必须命中按钮。
  const buttonSelector = selector.startsWith("[aria-label=") ? `button${selector}` : selector;
  await evaluate(`document.querySelector(${JSON.stringify(buttonSelector)}).click()`); await settle();
};
const key = async (value) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: value }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: value }); await settle(); };
const dragTo = async (width) => {
  const handle = await rect(".sidebar-resize"), side = await rect(".sidebar");
  const startX = handle.x + handle.width / 2, y = handle.y + 120;
  const scale = await evaluate("document.querySelector('.sidebar').getBoundingClientRect().width / document.querySelector('.sidebar').offsetWidth");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX + width * scale - side.width, y, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startX + width * scale - side.width, y, button: "left", buttons: 0, clickCount: 1 });
  await settle();
};
const screenshot = async (name) => {
  const result = await send("Page.captureScreenshot");
  writeFileSync(join(output, `${name}.png`), Buffer.from(result.data, "base64"));
};
const checkWidth = async (expected) => assert.equal(await evaluate("document.querySelector('.sidebar').offsetWidth"), expected);
const checkControls = async () => {
  const layout = await evaluate(`(() => {
    const side = document.querySelector('.sidebar').getBoundingClientRect();
    const visible = element => element.getClientRects().length > 0;
    const buttons = [...document.querySelectorAll('.sidebar-head button,.sidebar-new-row button,.sidebar-foot button')].filter(visible);
    const outOfBounds = [], clippedText = [];
    for (const button of buttons) {
      const bounds = button.getBoundingClientRect();
      if (bounds.left < side.left - 1 || bounds.right > side.right + 1) outOfBounds.push(button.className);
      // 检查实际文字，避免把扩展点击区域的伪元素当成内容溢出。
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (!node.textContent.trim() || !visible(node.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        if (text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1) clippedText.push(node.textContent);
      }
    }
    const footer = buttons.filter(button => button.closest('.sidebar-foot')).map(button => {
      const r = button.getBoundingClientRect(); return { name: button.className, x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const overlaps = [];
    for (let i = 0; i < footer.length; i++) for (let j = i + 1; j < footer.length; j++) {
      const a = footer[i], b = footer[j];
      if (Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1) overlaps.push([a.name,b.name]);
    }
    const labels = [...document.querySelectorAll('.sidebar-foot .page-nav-name')].filter(visible).map(label => ({ text:label.textContent, overflow:getComputedStyle(label).overflow }));
    return { outOfBounds, clippedText, overlaps, labels, footer, wrap:getComputedStyle(document.querySelector('.sidebar-foot')).flexWrap, overflowX:document.documentElement.scrollWidth-innerWidth };
  })()`);
  assert.deepEqual(layout.outOfBounds, [], '顶部/底部按钮位于侧栏内');
  assert.deepEqual(layout.clippedText, [], '按钮文字完整显示');
  assert.deepEqual(layout.overlaps, [], '底栏按钮不重叠');
  assert.ok(layout.overflowX <= 0, '页面不横向溢出');
  assert.equal(layout.wrap, 'wrap', '底栏允许换行');
  assert.equal(layout.labels.length, 2, '历史和额度文字均可见');
  for (const label of layout.labels) assert.equal(label.overflow, 'visible', `${label.text} 不通过裁切省略`);
  return layout;
};
let passed = 0;
const check = async (name, task) => { await task(); passed++; console.log(`PASS ${name}`); };
const watchdog = setTimeout(() => browser.kill(), 600000);
try {
  await send("Browser.getVersion");
  const target = await send("Target.createTarget", { url: "about:blank" });
  sessionId = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    localStorage.setItem('workbench-language','en'); // 固定语言，Local 不依赖运行机器。
    // 模拟升级前用户把侧栏拖到了 260px，后续刷新不再覆盖存储。
    if (!localStorage.getItem('sidebar-test-seeded')) {
      localStorage.setItem('workbench-sidebar-width','260');
      localStorage.setItem('sidebar-test-seeded','1');
    }
    const fixtures = {
      '/api/meta': { defaultCwd: '/repo', capabilities: {terminal:false}, drivers: Object.fromEntries(['claude','codex','kimi'].map(id => [id,{configOptions:[], available:true}])) },
      '/api/sessions': { sessions: [{id:'long-title',agent:'codex',agentId:'codex',cwd:'/repo',status:'idle',config:{},seq:0,
        createdAt:new Date().toISOString(),lastActivityAt:new Date().toISOString(),
        title:'拉宽侧栏后应当继续显示完整会话标题和后面更多的详细信息以便查看内容'}] }, '/api/project-order': { paths: ['/repo'] },
      '/api/pages': { pages: [{id:'ai-usage',name:'AI 用量',icon:'📊',type:'iframe',url:'http://127.0.0.1:8788'}] },
      '/api/pages/ai-usage/health': {reachable:false,embeddable:false,reason:'测试页面'},
      '/api/history': {sessions:[],truncated:false,skipped:0,empty:0,discovered:0,durationMs:0},
      '/api/fs/dirs': {path:'/repo',parent:'/',dirs:[],files:[]},
      '/api/links': {links:[]}, '/api/prefs': {idleReleaseMinutes:0}, '/api/claude/settings': {remoteControlAtStartup:false},
      '/api/storage': {totalBytes:0,categories:Object.fromEntries(['transcripts','uploads','logs','other'].map(id=>[id,{bytes:0,files:0}])),cleanable:{bytes:0,rotatedLogs:{bytes:0,files:0},orphans:{bytes:0,files:0,uploadDirs:0},ended:{bytes:0,files:0,sessions:0}}},
    };
    window.__fixtureTitle = fixtures['/api/sessions'].sessions[0].title;
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path.startsWith('/api/')) {
        if (init?.method && init.method !== 'GET') throw new Error('Test attempted API write');
        return Promise.resolve(new Response(JSON.stringify({code:0,data:fixtures[path]??{},msg:'',request_id:'test'}),{headers:{'content-type':'application/json'}}));
      }
      return realFetch(input, init);
    };
    window.WebSocket = class {static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;addEventListener(){}close(){}send(){}};
  ` });
  await send("Page.navigate", { url: base });
  await waitFor("document.querySelector('.sidebar-foot-usage') && document.querySelector('.sidebar-resize')");
  await settle();
  await evaluate("window.__pointerTrace=[]; ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'].forEach(type=>document.addEventListener(type,e=>__pointerTrace.push({type:e.type,x:e.clientX,y:e.clientY,target:e.target.className,primary:e.isPrimary,button:e.button,buttons:e.buttons}),true))");
  await check("将升级前的当前 260px 记为默认，历史/额度文字可见", async () => {
    await checkWidth(260);
    assert.equal(await evaluate("localStorage.getItem('workbench-sidebar-default-width')"), "260");
    assert.ok(await evaluate("Array.from(document.querySelectorAll('.sidebar-foot .page-nav-name')).every(label=>getComputedStyle(label).display!=='none')"));
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.brand-name')).display"), "none");
    await screenshot("default");
  });
  await check("底栏按内容排列，拉宽不拉伸按钮，窄处可换行且文字完整", async () => {
    // 从 320px 起比较：英文侧栏 ≤282px 时胶囊收起图标，宽度本就不同。
    await dragTo(320); await checkWidth(320);
    const initial = await checkControls();
    const launcher = await rect('.sidebar-foot .launcher-button');
    await dragTo(380); await checkWidth(380);
    const wide = await checkControls();
    for (const button of initial.footer) {
      const after = wide.footer.find(item => item.name === button.name);
      assert.ok(Math.abs(button.w - after.w) < 1, `${button.name} 按内容保持宽度`);
      assert.ok(Math.abs(button.h - after.h) < 1, `${button.name} 保持高度`);
    }
    const wideLauncher = await rect('.sidebar-foot .launcher-button');
    const wideFoot = await rect('.sidebar-foot');
    assert.ok(Math.abs(wideFoot.x + wideFoot.width - wideLauncher.x - wideLauncher.width) < 1, '宽侧栏直达按钮靠右');
    assert.equal(wideLauncher.width, launcher.width, '圆钮不随侧栏拉伸');
    await screenshot('wide-fixed-buttons');
    await dragTo(260);
    await evaluate("document.documentElement.setAttribute('data-theme','dark')");
    await checkControls(); await screenshot('footer-dark');
    await evaluate("document.documentElement.setAttribute('data-theme','light')");
  });
  await check("会话标题随拉宽显示更多前缀，记录保留完整原标题", async () => {
    // 本项测量会话行；目录默认折叠时先用真实标题按钮展开。
    if(await evaluate("document.querySelector('.project-toggle').getAttribute('aria-expanded')==='false'")) await click('.project-toggle');
    await waitFor("document.querySelector('.row-title')");
    const original = await evaluate("window.__fixtureTitle");
    const initial = await evaluate("document.querySelector('.row-title').textContent");
    for (const width of [320, 360, 390]) {
      await dragTo(width);
      const displayed = await evaluate("document.querySelector('.row-title').textContent");
      assert.ok(displayed.length > initial.length, `标题在 ${width}px 显示更多文字`);
      assert.ok(original.startsWith(displayed.replace(/…$/, '')), '显示原标题前缀');
      assert.equal(await evaluate("document.querySelector('.row-title').title"), displayed, '悬停提示与可见标题一致');
      assert.ok(await evaluate("document.querySelector('.session-row').scrollWidth <= document.querySelector('.session-row').clientWidth"));
    }
    await screenshot('wide-session-title');
    await dragTo(260);
  });
  await check("最大宽度为默认 260px 的 1.5 倍，即 390px", async () => {
    await dragTo(500); await checkWidth(390);
    assert.equal(await evaluate("document.querySelector('.sidebar-resize').getAttribute('aria-valuemax')"), "390");
    await screenshot("maximum");
  });
  await check("中间宽度的顶部与底部按钮均不溢出", async () => {
    for (const width of [320, 304, 300, 294, 292, 280, 260, 240]) {
      await dragTo(width); await checkWidth(width);
      await checkControls();
    }
  });
  await check("最小 224px，完整主机名、历史/额度文字和两侧圆钮均不溢出", async () => {
    await dragTo(224); await checkWidth(224);
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.brand-name')).display"), "none");
    assert.equal(await evaluate("document.querySelector('.brand-name').textContent"), "Local"); // 测试固定英文，本机入口显示 Local
    const reload = await rect(".sidebar-reload"), toggle = await rect(".sidebar-toggle"), head = await rect(".sidebar-head");
    assert.ok(toggle.x - reload.x - reload.width >= 8 && toggle.x - reload.x - reload.width <= 16, "刷新与收起按钮成组且不重叠");
    assert.ok(Math.abs(head.x + head.width - toggle.x - toggle.width - 4) < 1, "顶部双钮靠头栏右边，保留 4px 点击区留白");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.sidebar-foot .page-nav-name')).display"), "none");
    const buttons = await evaluate("Array.from(document.querySelectorAll('.sidebar-foot button')).filter(b=>b.getBoundingClientRect().width>0).map(b => {const r=b.getBoundingClientRect();return {className:b.className,w:r.width,h:r.height,radius:getComputedStyle(b).borderRadius};})");
    assert.equal(buttons.length, 4);
    for (const button of buttons.filter(button=>!button.className.includes('page-nav-item'))) {
      assert.equal(button.w, button.h); assert.equal(button.radius, "50%");
    }
    const layout = await checkControls();
    assert.equal(new Set(layout.footer.map(button => Math.round(button.y + button.h / 2))).size, 1, '224px 英文底栏收起胶囊图标后仍为一行');
    assert.equal(await evaluate("document.querySelectorAll('.sidebar-foot .page-nav-item .page-icon').length && [...document.querySelectorAll('.sidebar-foot .page-nav-item .page-icon')].every(icon=>getComputedStyle(icon).display==='none')"), true, '窄侧栏收起历史/额度图标');
    await screenshot("minimum");
  });
  await check("最小字号 14 下，224px 英文底栏不溢出、不重叠、不省略", async () => {
    await evaluate(`window.__fontStyles = [...document.querySelectorAll('.sidebar-foot,.sidebar-foot *')].filter(element=>element instanceof HTMLElement && parseFloat(getComputedStyle(element).fontSize)<14).map(element=>[element,element.getAttribute('style')]); for(const [element] of __fontStyles) element.style.setProperty('font-size','14px','important');`);
    await settle(); await checkControls(); await screenshot('minimum-font14');
    await evaluate("for(const [element,style] of __fontStyles) { if(style===null) element.removeAttribute('style'); else element.setAttribute('style',style); } delete window.__fontStyles;");
  });
  await check("最小侧栏宽度打开主页新建，主区表单不横向溢出", async () => {
    await click(".btn-new-session");
    assert.ok(await evaluate("document.querySelector('.new-form').scrollWidth <= document.querySelector('.new-form').clientWidth"));
    await screenshot("minimum-new");
    assert.ok(await evaluate("!document.querySelector('.sidebar .new-form') && !!document.querySelector('.main .new-form')"));
    await evaluate("import('/src/store.ts').then(({store})=>store.navigate(null))"); await settle();
  });
  await check("历史保持宽度；额度临时加宽至 334px，后退恢复打开前的 224px", async () => {
    await click('.sidebar-foot-pages > .page-nav:first-child .page-nav-item'); await checkWidth(224);
    await click('.sidebar-foot-pages > .page-nav:first-child .page-nav-item');
    await click('.sidebar-foot-usage'); await checkWidth(334);
    assert.ok(await evaluate("!!document.querySelector('.sidebar-panel-expanded')"));
    await click('.sidebar-foot-usage');
    await checkWidth(224);
  });
  await check("额度页内拖动后仍恢复原宽度，原本更宽则保持；Escape 也恢复", async () => {
    await dragTo(250);
    await click('.sidebar-foot-usage'); await checkWidth(334);
    await dragTo(380); await checkWidth(380);
    assert.equal(await evaluate("localStorage.getItem('workbench-sidebar-width')"), "250");
    await click('.sidebar-foot-usage'); await checkWidth(250);
    await dragTo(360);
    await click('.sidebar-foot-usage'); await checkWidth(360);
    await key("Escape"); await checkWidth(360);
    await dragTo(224);
  });
  await check("最窄处产生阻力与回弹，超过 48px 后收起，边缘仍能重新拖开", async () => {
    await dragTo(210); await checkWidth(224);
    const handle = await rect(".sidebar-resize"), x = handle.x + handle.width / 2, y = 150;
    await send("Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:x-24,y,button:"left",buttons:1});
    await checkWidth(224);
    assert.ok(await evaluate("document.querySelector('.sidebar').hasAttribute('data-resisting')"));
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.sidebar-resize'),'::after').transform"), "matrix(1, 0, 0, 1, 0, 0)");
    await screenshot("resistance");
    await send("Input.dispatchMouseEvent", {type:"mouseReleased",x:x-24,y,button:"left",buttons:0,clickCount:1});
    await settle();
    assert.ok(await evaluate("!document.querySelector('.sidebar').hasAttribute('data-resisting')"));
    await dragTo(174); await checkWidth(48);
    assert.ok(await evaluate("!document.body.classList.contains('sidebar-resizing') && !!document.querySelector('.sidebar-resize')"));
    assert.ok(await evaluate("document.activeElement.classList.contains('sidebar-toggle')"));
    await screenshot("collapsed");
    await dragTo(260); await checkWidth(260);
    await dragTo(224);
  });
  await check("同一次拖动中收起后反向拉回，指针捕获持续有效", async () => {
    const handle = await rect(".sidebar-resize"), x = handle.x + handle.width / 2, y = 150;
    await send("Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:x-52,y,button:"left",buttons:1});
    await checkWidth(48);
    assert.ok(await evaluate("document.body.classList.contains('sidebar-resizing')"));
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:x-30,y,button:"left",buttons:1});
    await checkWidth(224);
    await send("Input.dispatchMouseEvent", {type:"mouseReleased",x:x-30,y,button:"left",buttons:0,clickCount:1});
    await settle();
    assert.ok(await evaluate("!document.body.classList.contains('sidebar-resizing')"));
  });
  await check("按钮收起后也能从边缘拖回，轻微晃动保持收起", async () => {
    await click(".sidebar-toggle"); await checkWidth(48);
    await dragTo(60); await checkWidth(48);
    await dragTo(304); await checkWidth(304);
    await dragTo(224);
  });
  await check("页面打开时拖过下限关闭页面，效果等同收起按钮", async () => {
    await click('.sidebar-foot-usage'); await dragTo(174); await checkWidth(48);
    assert.ok(await evaluate("!document.querySelector('.sidebar-panel-expanded')"));
    await click(".sidebar-toggle"); await checkWidth(224);
  });
  await check("拖动后刷新仍回到固定默认 260px", async () => {
    assert.equal(await evaluate("localStorage.getItem('workbench-sidebar-width')"), "224");
    await send("Page.reload"); await waitFor("document.querySelector('.sidebar-resize')"); await settle(); await checkWidth(260);
    assert.equal(await evaluate("localStorage.getItem('workbench-sidebar-default-width')"), "260");
  });
  await check("键盘 Home/End/箭头，最窄时左箭头收起", async () => {
    await evaluate("document.querySelector('.sidebar-resize').focus()");
    await key("End"); await checkWidth(390); await key("ArrowLeft"); await checkWidth(378);
    await key("Home"); await checkWidth(224); await key("ArrowLeft"); await checkWidth(48);
    await click(".sidebar-toggle");
  });
  await check("双击回到用户固定默认 260px", async () => {
    const r = await rect(".sidebar-resize"), x = r.x + r.width / 2, y = r.y + 180;
    await send("Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",buttons:1,clickCount:2});
    await send("Input.dispatchMouseEvent", {type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:2});
    await settle(); await checkWidth(260);
  });
  await check("字号 zoom=1.25 下拖动跟手且仍遵守 CSS 宽度上下限", async () => {
    await evaluate("document.documentElement.style.setProperty('--font-scale','1.25')");
    await dragTo(250); await checkWidth(250);
    assert.equal((await rect(".sidebar")).width, 312.5);
    await dragTo(224); await checkWidth(224);
    await checkControls();
    await evaluate("document.documentElement.style.setProperty('--font-scale','1')");
  });
  await check("设置与直达仍可打开", async () => {
    await click('.settings-gear'); assert.ok(await evaluate("!!document.querySelector('.settings-panel[role=dialog]')"));
    await click('.settings-gear'); await click('.launcher-button');
    assert.ok(await evaluate("!!document.querySelector('.launcher-panel[role=dialog]')")); await click('.launcher-button');
  });
  await check("手机 390px 沿用全宽布局，拖动条隐藏且页面不横向溢出", async () => {
    await send("Emulation.setDeviceMetricsOverride", { width:390,height:844,deviceScaleFactor:1,mobile:true });
    await settle();
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.sidebar-resize')).display"), "none");
    assert.equal((await rect(".sidebar")).width, 390);
    await send('Emulation.setTouchEmulationEnabled', { enabled:true });
    await settle();
    assert.ok(await evaluate("matchMedia('(pointer: coarse)').matches"), '手机模拟启用触屏规则');
    await checkControls(); await screenshot('mobile');
    // 列表页顶栏：文件与「⋯」保持 44px 圆钮，派单、终端在「⋯」菜单里
    const launcher = await evaluate("[...document.querySelectorAll('.mobile-panel-launcher .chrome-icon-btn')].map(b=>Math.round(b.getBoundingClientRect().width))");
    assert.deepEqual(launcher, [44, 44]);
    await click('.mobile-panel-launcher .session-more-trigger');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.mobile-panel-launcher .session-more-menu:not([hidden]) .session-more-item')].map(b=>b.textContent.trim())"), ['Dispatches'], '本夹具为英文且无终端能力');
    await screenshot('mobile-launcher-menu');
    await click('.mobile-panel-launcher .session-more-trigger');
  });
  const shotsA = join(output, "projects");
  mkdirSync(shotsA, { recursive: true });
  const shotsC = fileURLToPath(new URL('../../.work-orders/2026-10-16-sidebar-projects/shots-d/', import.meta.url));
  mkdirSync(shotsC, { recursive: true });
  const group = path => `.sidebar-project[data-project-path=${JSON.stringify(path)}]`;
  const visibleOrder = () => evaluate("[...document.querySelectorAll('.sidebar-project')].filter(node=>!node.closest('.sidebar-older-projects')).map(node=>node.dataset.projectPath)");
  const shotA = async name => {
    const result = await send("Page.captureScreenshot");
    writeFileSync(join(shotsA, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const shotC = async name => {
    const result = await send("Page.captureScreenshot");
    writeFileSync(join(shotsC, `${name}.png`), Buffer.from(result.data, "base64"));
  };
  const inputSearch = async text => {
    if (!await evaluate("!!document.querySelector('.sidebar-search-input')")) {
      await click('.sidebar-search');
      assert.ok(await evaluate("document.activeElement===document.querySelector('.sidebar-search-input')"),'打开搜索后自动聚焦');
    }
    await evaluate(`(() => {const input=document.querySelector('.sidebar-search-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await settle();
  };
  const closeSearch = async () => { await evaluate("document.querySelector('.sidebar-search-input').focus()"); await key('Escape'); };
  const projectFixture = (locale, theme, variant) => `
    const phaseD=${JSON.stringify(variant.startsWith('d-'))};
    const fixtureKey = 'aireins-test-project-order-' + ${JSON.stringify(variant)};
    localStorage.setItem('workbench-language',${JSON.stringify(locale)});
    localStorage.setItem('workbench-theme',${JSON.stringify(theme)});
    localStorage.setItem('workbench-font-scale','1');
    localStorage.setItem('workbench-sidebar-default-width','360');
    localStorage.setItem('workbench-sidebar-width','360');
    localStorage.setItem('workbench-sidebar-collapsed','0');
    if(phaseD)localStorage.removeItem('workbench-last-session');
    if (!localStorage.getItem(fixtureKey)) {
      localStorage.setItem(fixtureKey,JSON.stringify(['/teaching/paper','/hidden','/research/paper','/home/demo','/repo/AIReins',...(phaseD?['/repo/many','/archive/batch','/archive/newer']:[])]));
      localStorage.setItem('aireins-project-folds','{}');
      localStorage.setItem('aireins-older-projects-open','0');
    }
    const now=Date.now(), ago=hours=>new Date(now-hours*3600000).toISOString();
    const session=(id,cwd,title,hours,extra={})=>({id,cwd,title,agent:'claude',status:'idle',config:{},seq:0,createdAt:ago(hours),lastActivityAt:ago(hours),...extra});
    const sessions=[
      session('wait','/wait','Always pending',120,{pinned:true,pendingGateCount:1}),
      session('pin','/mnt/c/Users/Research/pinned','Pinned beyond 72h',120,{pinned:true,status:'dead'}),
      session('teach-new','/teaching/paper','Automatic title',0,{customTitle:'Needle teaching'}),
      session('teach-bg','/teaching/paper','Background work',1,{backgroundTasks:[{id:'background',type:'task',description:'Synthetic background'}]}),
      session('research','/research/paper','Research notes',2),
      session('home','/home/demo','Home session',3),
      session('repo','/repo/AIReins','Repository error',4,{status:'error'}),
      session('hidden','/hidden','Invisible old session',120),
    ];
    if(phaseD)sessions.push(
      ...Array.from({length:11},(_,index)=>session('many-'+(index+1),'/repo/many','Recent ordinary '+String(index+1).padStart(2,'0'),index+1)),
      session('many-background','/repo/many','Recent background',0.5,{backgroundTasks:[{id:'recent-bg',type:'task',description:'Synthetic background'}]}),
      session('many-running','/repo/many','Old running',130,{status:'running'}),
      session('many-starting','/repo/many','Old starting',140,{status:'starting'}),
      session('many-current','/repo/many','Old current',160),
      ...Array.from({length:11},(_,index)=>session('older-'+(index+1),'/archive/batch','Older ordinary '+String(index+1).padStart(2,'0'),100+index)),
      session('older-background','/archive/batch','Older background',200,{backgroundTasks:[{id:'older-bg',type:'task',description:'Synthetic background'}]}),
      session('older-newer','/archive/newer','Newest older project',80),
      session('older-dead','/archive/dead','Excluded dead project',1,{status:'dead'}),
    );
    window.__projectFixture={sessions,paths:JSON.parse(localStorage.getItem(fixtureKey)),writes:[],historyQueries:[],directoryQueries:[]};
    const f=window.__projectFixture;
    const fixtures={
      '/api/meta':{defaultCwd:'/repo/AIReins',homeDir:'/home/demo',capabilities:{terminal:false,windowsPaths:true},drivers:Object.fromEntries(['claude','codex','kimi'].map(id=>[id,{configOptions:[],available:true}]))},
      '/api/sessions':{sessions}, '/api/pages':{pages:[]}, '/api/links':{links:[]},
      '/api/prefs':{idleReleaseMinutes:0}, '/api/claude/settings':{remoteControlAtStartup:false},
    };
    const realFetch=window.fetch;
    window.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname;
      if(!path.startsWith('/api/'))return realFetch(input,init);
      let data=fixtures[path]??{};
      if(init?.method&&init.method!=='GET'){
        if(path!=='/api/project-order/move'||init.method!=='POST')throw new Error('Unexpected synthetic API write '+path);
        const operation=JSON.parse(init.body);f.writes.push(operation);
        const paths=f.paths.filter(value=>value!==operation.path),target=operation.before??operation.after;
        paths.splice(paths.indexOf(target)+(operation.after?1:0),0,operation.path);
        f.paths=paths;localStorage.setItem(fixtureKey,JSON.stringify(paths));data={paths};
      }else if(path==='/api/project-order')data={paths:f.paths};
      else if(path==='/api/history'){
        f.historyQueries.push(Object.fromEntries(url.searchParams));
        data={sessions:[],truncated:false,skipped:0,empty:0,discovered:0,durationMs:0};
      }else if(path==='/api/fs/dirs'){
        const directory=url.searchParams.get('path')??'/repo/AIReins';f.directoryQueries.push(directory);
        data={path:directory,parent:'/',dirs:[{name:'nested',path:directory+'/nested'}],files:[],truncated:false};
      }else if(path.endsWith('/snapshot'))data={session:sessions.find(session=>session.id===decodeURIComponent(path.split('/')[3])),seq:0,events:[],hasMore:false,firstSeq:0};
      else if(path.endsWith('/commands'))data={commands:[]};
      return Promise.resolve(new Response(JSON.stringify({code:0,data,msg:'',request_id:'aireins-project-fixture'}),{headers:{'content-type':'application/json'}}));
    };
    window.WebSocket=class{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;addEventListener(){}close(){}send(){}};
  `;
  for (const width of [1280, 390]) for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
    const variant=`${width}-${locale}-${theme}`;
    await check(`阶段 A ${variant}：目录、折叠、排序、搜索与历史入口`, async () => {
      const target=await send('Target.createTarget',{url:'about:blank'},null);
      sessionId=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
      await send('Page.enable'); await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:900,deviceScaleFactor:1,mobile:width===390});
      await send('Emulation.setTouchEmulationEnabled',{enabled:width===390});
      await send('Page.addScriptToEvaluateOnNewDocument',{source:projectFixture(locale,theme,variant)});
      await send('Page.navigate',{url:base});
      await waitFor("[...document.querySelectorAll('.sidebar-project')].filter(node=>!node.closest('.sidebar-older-projects')).length===4"); await settle();
      const original=['/teaching/paper','/research/paper','/home/demo','/repo/AIReins'];
      assert.deepEqual(await visibleOrder(),original);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.project-name')].filter(node=>!node.closest('.sidebar-older-projects')).map(node=>node.textContent)"),['paper · teaching','paper · research','~','AIReins']);
      assert.equal(await evaluate("document.querySelectorAll('.session-row').length"),4,'等待/置顶只出现一次，工作中目录自动展开，空闲目录默认折叠');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('/research/paper')+' .project-toggle')}).getAttribute('aria-expanded')`),'false','空闲目录默认折叠');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('/teaching/paper')+' .project-toggle')}).getAttribute('aria-expanded')`),'true','后台任务自动展开');
      // 阶段 C 状态截图使用工单要求的 1440/390；测量与拖动检查仍沿用既有 1280/390。
      if(width===1280){await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await settle();}
      const shotVariant=`${width===1280?1440:width}-${locale}-${theme}`;
      await evaluate("import('/src/store.ts').then(({store})=>{window.__sidebarBackground=store.sessions.find(session=>session.id==='teach-bg').backgroundTasks;store.sessions=store.sessions.map(session=>session.id==='teach-bg'?{...session,backgroundTasks:[]}:session);store.notify();})");
      await settle();
      assert.equal(await evaluate("[...document.querySelectorAll('.project-toggle')].every(button=>button.getAttribute('aria-expanded')==='false')"),true,'无工作中会话时所有目录默认折叠');
      await shotC(`${shotVariant}-sidebar-default`);
      await evaluate("import('/src/store.ts').then(({store})=>{store.sessions=store.sessions.map(session=>session.id==='teach-bg'?{...session,backgroundTasks:window.__sidebarBackground}:session);store.notify();})");
      await settle();await shotC(`${shotVariant}-sidebar-working`);
      if(width===1280){await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await settle();}
      if(variant==='1280-zh-CN-light'){
        const researchToggle=group('/research/paper')+' .project-toggle';
        const isExpanded=()=>evaluate(`document.querySelector(${JSON.stringify(researchToggle)}).getAttribute('aria-expanded')`);
        const status=async value=>{
          await evaluate(`import('/src/store.ts').then(({store})=>{store.sessions=store.sessions.map(session=>session.id==='research'?{...session,status:${JSON.stringify(value)}}:session);store.notify();})`);
          await settle();
        };
        await status('running'); assert.equal(await isExpanded(),'true','开始工作自动展开');
        await status('idle'); assert.equal(await isExpanded(),'false','结束工作自动折叠');
        await click(researchToggle);
        assert.equal(await evaluate("JSON.parse(localStorage.getItem('aireins-project-folds'))['/research/paper']"),'open','点击按完整路径保存手动展开');
        await status('running'); await status('idle');
        assert.equal(await isExpanded(),'true','手动展开后空闲仍保持展开');
        await click(researchToggle); await status('running');
        assert.equal(await isExpanded(),'false','手动收起后工作中仍保持收起');
        assert.equal(await evaluate("JSON.parse(localStorage.getItem('aireins-project-folds'))['/research/paper']"),'closed');
        await status('idle');
        // 浏览器禁用本键写入时，React 内存态仍能双向切换。
        await evaluate("window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='aireins-project-folds')throw new Error('Private storage');return window.__setItem.call(this,key,value)}");
        try{
          const homeToggle=group('/home/demo')+' .project-toggle';
          await click(homeToggle);
          assert.equal(await evaluate(`document.querySelector(${JSON.stringify(homeToggle)}).getAttribute('aria-expanded')`),'true','隐私模式写失败仍手动展开');
          await click(homeToggle);
          assert.equal(await evaluate(`document.querySelector(${JSON.stringify(homeToggle)}).getAttribute('aria-expanded')`),'false','隐私模式写失败仍手动收起');
        }finally{await evaluate('Storage.prototype.setItem=window.__setItem');}
      }
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('/teaching/paper')+' .project-toggle')}).title`),'/teaching/paper');
      assert.equal(await evaluate("document.documentElement.dataset.theme"),theme);
      assert.equal(await evaluate("document.documentElement.lang"),locale==='zh-CN'?'zh-CN':'en');
      assert.equal(await evaluate("document.querySelector('.sidebar-search').textContent.trim()"),'','搜索按钮仅图标');
      if(width===390){
        const heights=await evaluate("[...document.querySelectorAll('.project-toggle,.project-action')].filter(node=>node.getClientRects().length).map(node=>node.getBoundingClientRect().height)");
        assert.ok(heights.every(height=>height>=44),'触屏目录控件命中区至少44px');
        assert.ok(await evaluate("[...document.querySelectorAll('.project-header')].every(node=>!node.draggable)"),'触屏不启用拖动');
      }
      await shotA(`${variant}-projects`);
      await click(group('/teaching/paper')+' .project-toggle');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('/teaching/paper')+' .project-toggle')}).getAttribute('aria-expanded')`),'false');
      assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(group('/teaching/paper')+' .project-count')}) && !!document.querySelector(${JSON.stringify(group('/teaching/paper')+' .status-running')})`),'折叠显示计数和后台工作状态');
      await shotA(`${variant}-collapsed`);
      await send('Page.reload'); await waitFor("[...document.querySelectorAll('.sidebar-project')].filter(node=>!node.closest('.sidebar-older-projects')).length===4"); await settle();
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('/teaching/paper')+' .project-toggle')}).getAttribute('aria-expanded')`),'false','刷新记住折叠');
      await inputSearch('NEEDLE');
      assert.deepEqual(await visibleOrder(),['/teaching/paper']);
      assert.ok(await evaluate("[...document.querySelectorAll('.row-title')].some(node=>node.textContent.includes('Needle teaching'))"),'搜索忽略目录折叠并匹配显示自定义标题');
      assert.ok(await evaluate("[...document.querySelectorAll('.row-title')].some(node=>node.textContent.includes('Always pending'))"),'等待处理完整显示');
      assert.equal(await evaluate("document.querySelectorAll('.session-row').length"),2,'不匹配置顶和空目录被过滤');
      await shotA(`${variant}-search`);
      await evaluate("import('/src/store.ts').then(({store})=>store.setHistoryCwdFilter('/old-filter'))");
      await click('.sidebar-history-search');
      await waitFor("window.__projectFixture.historyQueries.some(query=>query.q==='NEEDLE')");
      assert.equal(await evaluate("window.__projectFixture.historyQueries.at(-1).cwd??null"),null,'历史关键词入口清旧目录');
      await shotA(`${variant}-history-search`);
      await evaluate("import('/src/store.ts').then(({store})=>store.closeSidebarPanel())"); await settle();
      await inputSearch('/research/paper');
      await click('.sidebar-history-search');
      await waitFor("window.__projectFixture.historyQueries.some(query=>query.cwd==='/research/paper'&&!query.q)");
      await shotA(`${variant}-history-path`);
      await evaluate("import('/src/store.ts').then(({store})=>store.closeSidebarPanel())"); await settle();
      await closeSearch();
      await click(group('/research/paper')+' .project-action[aria-haspopup=menu]');
      await click('.row-menu-item:first-child');
      assert.deepEqual(await visibleOrder(),['/research/paper','/teaching/paper','/home/demo','/repo/AIReins']);
      assert.deepEqual(await evaluate("window.__projectFixture.writes.at(-1)"),{path:'/research/paper',before:'/teaching/paper'},'上移相对于可见邻组');
      await settle();
      await click(group('/research/paper')+' .project-action[aria-haspopup=menu]');
      await evaluate("document.querySelectorAll('.row-menu-item')[1].click()"); await settle();
      assert.deepEqual(await visibleOrder(),original);
      assert.deepEqual(await evaluate("window.__projectFixture.writes.at(-1)"),{path:'/research/paper',after:'/teaching/paper'},'下移相对于可见邻组');
      if(width===1280){
        const before=await evaluate('window.__projectFixture.writes.length');
        assert.ok(await evaluate(`(() => {const header=document.querySelector(${JSON.stringify(group('/repo/AIReins')+' .project-header')});
          header.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'}));
          const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});
          header.dispatchEvent(event);return event.defaultPrevented;})()`),'触屏发起的桌面拖动被拒绝');
        await evaluate(`document.querySelector(${JSON.stringify(group('/repo/AIReins')+' .project-header')}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}))`);
        await evaluate(`window.__projectDrag=new DataTransfer();document.querySelector(${JSON.stringify(group('/repo/AIReins')+' .project-header')}).dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__projectDrag}));
          document.querySelector(${JSON.stringify(group('/teaching/paper'))}).dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__projectDrag}));`);
        await settle();
        assert.deepEqual(await visibleOrder(),['/repo/AIReins',...original.slice(0,-1)],'拖动中只预览');
        assert.equal(await evaluate('window.__projectFixture.writes.length'),before,'拖动中未写服务端');
        assert.ok(await evaluate(`(() => {const event=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__projectDrag});
          document.querySelector(${JSON.stringify(group('/repo/AIReins'))}).dispatchEvent(event);return event.defaultPrevented;})()`),'预览后鼠标下源组仍接受原生drop');
        await evaluate(`document.querySelector(${JSON.stringify(group('/repo/AIReins'))}).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__projectDrag}));
          document.querySelector(${JSON.stringify(group('/repo/AIReins')+' .project-header')}).dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.__projectDrag}));`);
        await settle();
        assert.equal(await evaluate('window.__projectFixture.writes.length'),before+1,'落在已移动源元素时仍只提交一次');
        assert.deepEqual(await evaluate('window.__projectFixture.writes.at(-1)'),{path:'/repo/AIReins',before:'/teaching/paper'});
      }
      if(variant==='1280-zh-CN-light'){
        // 真正鼠标按下/越过拖动阈值触发可信 dragstart；CDP 拦截系统拖动后投递可信 drop。
        const source=await rect(group('/home/demo')+' .project-header'),targetBox=await rect(group('/research/paper')+' .project-header');
        const x=source.x+48,y=source.y+source.height/2,targetY=targetBox.y+targetBox.height/2;
        const before=await evaluate('window.__projectFixture.writes.length');
        await evaluate("window.__nativeDragTrace=[];['dragstart','dragenter','dragover','drop','dragend'].forEach(type=>document.addEventListener(type,event=>{window.__nativeDragTrace.push({type:event.type,path:event.target.closest?.('.sidebar-project')?.dataset.projectPath,trusted:event.isTrusted,prevented:event.defaultPrevented})}));document.addEventListener('dragstart',event=>{window.__nativeDragTrusted=event.isTrusted},{once:true})");
        let timer;
        const intercepted=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(new Error('Native mouse drag was not intercepted')),5000);
          onNativeDrag=data=>{clearTimeout(timer);onNativeDrag=null;resolve(data);};
        });
        await send('Input.setInterceptDrags',{enabled:true});
        try{
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
          await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+10,y:y-10,button:'left',buttons:1});
          await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:targetY,button:'left',buttons:1});
          const data=await intercepted;
          assert.equal(await evaluate('window.__nativeDragTrusted'),true,'原生鼠标路径触发可信dragstart');
          await send('Input.dispatchDragEvent',{type:'dragEnter',x,y:targetY,data});
          await send('Input.dispatchDragEvent',{type:'dragOver',x,y:targetY,data}); await settle();
          // 预览重排后落点下方已换成源元素，真实浏览器要再给该元素一次 dragover。
          await send('Input.dispatchDragEvent',{type:'dragOver',x,y:targetY,data}); await settle();
          assert.equal(await evaluate('window.__projectFixture.writes.length'),before,'原生拖动中仍不写入');
          await send('Input.dispatchDragEvent',{type:'drop',x,y:targetY,data});
          await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:targetY,button:'left',buttons:0,clickCount:1}); await settle();
          assert.equal(await evaluate('window.__projectFixture.writes.length'),before+1,'原生鼠标拖放只提交一次 '+JSON.stringify(await evaluate('window.__nativeDragTrace.slice(-12)')));
          assert.deepEqual(await evaluate('window.__projectFixture.writes.at(-1)'),{path:'/home/demo',before:'/research/paper'});
          assert.deepEqual(await visibleOrder(),['/repo/AIReins','/teaching/paper','/home/demo','/research/paper']);
        }finally{clearTimeout(timer);onNativeDrag=null;await send('Input.setInterceptDrags',{enabled:false});}
      }
      const ordered=await visibleOrder();
      await shotA(`${variant}-reordered`);
      await send('Page.reload'); await waitFor("[...document.querySelectorAll('.sidebar-project')].filter(node=>!node.closest('.sidebar-older-projects')).length===4"); await settle();
      assert.deepEqual(await visibleOrder(),ordered,'服务端合成顺序跨刷新保持');
      await click(group('/research/paper')+' .project-action[aria-haspopup=menu]');
      await evaluate("document.querySelectorAll('.row-menu-item')[2].click()"); await settle();
      await waitFor("window.__projectFixture.historyQueries.some(query=>query.cwd==='/research/paper')");
      assert.equal(await evaluate("document.querySelector('.history-cwd-chip').title"),'/research/paper','目录菜单直接查看历史');
      await shotA(`${variant}-directory-history`);
      await evaluate("import('/src/store.ts').then(({store})=>store.closeSidebarPanel())"); await settle();
      // 置顶行菜单在手机也能读取完整路径；只用现有 ⋮，不导航或删除。
      await evaluate("[...document.querySelectorAll('.session-row')].find(node=>node.textContent.includes('Pinned beyond')).parentElement.querySelector('.session-row-more').click()"); await settle();
      assert.equal(await evaluate("document.querySelector('.row-menu-path').textContent"),'C:/Users/Research/pinned');
      await shotA(`${variant}-row-path`); await key('Escape');
      await click(group('/teaching/paper')+' .project-action:not([aria-haspopup])');
      await waitFor("document.querySelector('.new-form .new-project-select')?.value==='/teaching/paper'");
      assert.equal(await evaluate('location.hash'),'#/new','组标题+打开主页新建');
      assert.ok(await evaluate("!document.querySelector('.sidebar .new-form')"),'侧栏不内嵌新建');
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'页面不横向溢出');
      await send('Target.closeTarget',{targetId:target.targetId},null);
    });
  }
  console.log(`阶段 A 截图：${shotsA}`);
  const shotsD = fileURLToPath(new URL('../../.work-orders/2026-10-16-sidebar-projects/shots-d/', import.meta.url));
  mkdirSync(shotsD, { recursive: true });
  const olderToggle = '.older-projects-toggle';
  const recentProject = group('/repo/many'), olderProject = group('/archive/batch');
  const rows = selector => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector+' .session-row .row-title')})].map(node=>node.textContent.trim())`);
  const expanded = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`);
  const ordinary = prefix => Array.from({length:11},(_,index)=>`${prefix} ordinary ${String(index+1).padStart(2,'0')}`);
  const recentEight = ['Recent background', ...ordinary('Recent').slice(0,8), 'Old running', 'Old starting'];
  const recentAll = ['Recent background', ...ordinary('Recent'), 'Old running', 'Old starting'];
  const olderEight = [...ordinary('Older').slice(0,8), 'Older background'];
  const olderAll = [...ordinary('Older'), 'Older background'];
  const openD = async (width, locale, theme, variant, extra = '') => {
    const target = await send('Target.createTarget',{url:'about:blank'},null);
    sessionId = (await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:900,deviceScaleFactor:1,mobile:width===390});
    await send('Emulation.setTouchEmulationEnabled',{enabled:width===390});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:projectFixture(locale,theme,variant)+extra});
    await send('Page.navigate',{url:base});
    await waitFor("document.querySelector('.older-projects-toggle') && document.querySelector('[data-project-path=\"/repo/many\"] .project-show-more')");
    await settle();
    return target;
  };
  const reloadD = async () => {
    await send('Page.reload');
    await waitFor("document.querySelector('.older-projects-toggle') && document.querySelector('[data-project-path=\"/repo/many\"] .project-show-more')");
    await settle();
  };
  const shotD = async (name, selector) => {
    if(selector)await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    await settle();
    const result = await send('Page.captureScreenshot');
    writeFileSync(join(shotsD,`${name}.png`),Buffer.from(result.data,'base64'));
  };
  for (const width of [1440,390]) for (const locale of ['zh-CN','en']) for (const theme of ['light','dark']) {
    const variant=`${width}-${locale}-${theme}`;
    await check(`阶段 D ${variant}：文件夹、较早目录、8条上限与豁免`,async()=>{
      const target = await openD(width,locale,theme,'d-'+variant);
      assert.deepEqual(await visibleOrder(),['/teaching/paper','/research/paper','/home/demo','/repo/AIReins','/repo/many']);
      assert.equal(await expanded(olderToggle),'false','较早项目默认收起');
      assert.equal(await evaluate("document.querySelector('.older-projects-toggle').textContent.trim()"),
        locale==='zh-CN'?'较早的项目 · 3':'Older projects · 3','较早目录数排除置顶、待处理、dead及活跃目录');
      assert.ok(await evaluate("!!document.querySelector('.older-projects-toggle').getAttribute('aria-controls')"));
      assert.ok(await evaluate("document.querySelector('.sidebar-older-projects')===document.querySelector('.sidebar-older-projects').parentElement.lastElementChild"),'较早区位于项目列表末尾');
      assert.equal(await evaluate("document.querySelectorAll('.older-project-list .session-row').length"),0);
      const folders = await evaluate("[...document.querySelectorAll('.sidebar-project .project-header .project-toggle')].map(button=>({expanded:button.getAttribute('aria-expanded'),state:button.querySelector('svg.project-folder')?.dataset.state,viewBox:button.querySelector('svg.project-folder')?.getAttribute('viewBox')}))");
      assert.ok(folders.some(folder=>folder.state==='open')&&folders.some(folder=>folder.state==='closed'),'文件夹同时覆盖打开与合上');
      assert.ok(folders.every(folder=>folder.state===(folder.expanded==='true'?'open':'closed')&&folder.viewBox==='0 0 24 24'),'文件夹形态跟随真实展开状态');
      assert.equal(await evaluate("document.querySelectorAll('.project-chevron').length"),0,'目录图标已替换为文件夹');
      assert.ok(await evaluate("!!document.querySelector('.older-projects-toggle .older-project-chevron') && !document.querySelector('.older-projects-toggle .project-folder')"),'较早区标题仍使用箭头');
      assert.deepEqual(await rows(recentProject),recentEight,'8条普通会话加后台/过窗running/starting豁免，仍按时间排序');
      const recentMore=recentProject+' .project-show-more', olderMore=olderProject+' .project-show-more';
      assert.equal(await expanded(recentMore),'false');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(recentMore)}).textContent.trim()`),
        locale==='zh-CN'?'显示更多 · 3':'Show more · 3','隐藏计数只含普通会话');
      await shotD(`${variant}-default`);
      await click(recentMore);
      assert.equal(await expanded(recentMore),'true');
      assert.deepEqual(await rows(recentProject),recentAll,'显示更多原地列出所有活跃候选');
      await shotD(`${variant}-show-all`,recentMore);
      await click(recentMore);
      assert.deepEqual(await rows(recentProject),recentEight,'收起恢复8个普通名额');
      if(width===1440){
        await evaluate("import('/src/store.ts').then(({store})=>{store.currentId='many-current';store.notify()})");
        await settle();
        assert.deepEqual(await rows(recentProject),[...recentEight,'Old current'],'过窗当前会话始终显示且不占普通名额');
        await evaluate("import('/src/store.ts').then(({store})=>{store.currentId=null;store.notify()})");
        await settle();
      }
      await click(recentMore); await reloadD();
      assert.equal(await expanded(recentMore),'false','显示全部只存组件内存，刷新恢复截断');
      assert.deepEqual(await rows(recentProject),recentEight);
      await click(olderToggle);
      assert.equal(await expanded(olderToggle),'true');
      assert.equal(await evaluate("localStorage.getItem('aireins-older-projects-open')"),'1');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.older-project-list .sidebar-project')].map(node=>node.dataset.projectPath)"),
        ['/archive/newer','/archive/batch','/hidden'],'较早目录按最新活动排序，不沿用服务端目录顺序');
      assert.ok(await evaluate("[...document.querySelectorAll('.older-project-list .project-header')].every(node=>!node.draggable)"),'较早目录不参与拖动');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(olderProject+' .project-folder')}).dataset.state`),'open','过窗后台任务仍令较早区内部目录自动展开');
      assert.deepEqual(await rows(olderProject),olderEight,'较早目录同样限制8条普通会话，后台不占名额');
      assert.equal(await expanded(olderMore),'false');
      await click(olderMore);
      assert.deepEqual(await rows(olderProject),olderAll);
      await click(olderMore);
      assert.deepEqual(await rows(olderProject),olderEight);
      await shotD(`${variant}-older-open`,olderToggle);
      await click(group('/archive/newer')+' .project-action[aria-haspopup=menu]');
      assert.equal(await evaluate("document.querySelectorAll('.row-menu-item').length"),1,'较早目录菜单只保留历史入口，不含上下移动');
      await click('.row-menu-item');
      await waitFor("window.__projectFixture.historyQueries.some(query=>query.cwd==='/archive/newer')");
      await evaluate("import('/src/store.ts').then(({store})=>store.closeSidebarPanel())"); await settle();
      assert.ok(await evaluate(`(() => {const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()});document.querySelector(${JSON.stringify(olderProject+' .project-header')}).dispatchEvent(event);return event.defaultPrevented})()`),'较早目录拒绝程序化原生拖动');
      assert.equal(await evaluate('window.__projectFixture.writes.length'),0,'较早目录操作不写服务端顺序');
      await reloadD();
      assert.equal(await expanded(olderToggle),'true','手动展开较早区跨刷新保留');
      assert.equal(await expanded(olderMore),'false','较早目录的显示全部同样不持久化');
      await click(olderToggle); await reloadD();
      assert.equal(await expanded(olderToggle),'false','手动收起较早区跨刷新保留');
      assert.equal(await evaluate("localStorage.getItem('aireins-older-projects-open')"),'0');
      await evaluate("window.__olderSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='aireins-older-projects-open')throw new Error('Private storage');return window.__olderSetItem.call(this,key,value)}");
      try{
        await click(olderToggle); assert.equal(await expanded(olderToggle),'true','隐私写异常仍在内存展开');
        await click(olderToggle); assert.equal(await expanded(olderToggle),'false','隐私写异常仍在内存收起');
      }finally{await evaluate('Storage.prototype.setItem=window.__olderSetItem');}
      assert.equal(await evaluate("localStorage.getItem('aireins-older-projects-open')"),'0','写失败不改变旧存储');
      await inputSearch('/archive/batch');
      assert.equal(await expanded(olderToggle),'true','搜索匹配较早目录时自动展开外层');
      assert.deepEqual(await rows(olderProject),olderAll,'搜索忽略目录折叠且不截断较早会话');
      assert.equal(await evaluate("document.querySelectorAll('.project-show-more').length"),0,'搜索不显示截断控件');
      assert.equal(await evaluate("localStorage.getItem('aireins-older-projects-open')"),'0','自动搜索展开不覆盖手动记忆');
      await shotD(`${variant}-older-search`,olderToggle);
      await inputSearch('/repo/many');
      assert.deepEqual(await rows(recentProject),recentAll,'活跃目录搜索同样不截断');
      await closeSearch();
      assert.equal(await expanded(olderToggle),'false','退出搜索恢复手动收起');
      await click(olderToggle);
      if(width===390){
        const targets = await evaluate("[...document.querySelectorAll('.project-toggle,.project-action,.project-show-more')].filter(node=>node.getClientRects().length).map(node=>({className:node.className,height:node.getBoundingClientRect().height}))");
        assert.ok(targets.length>10&&targets.every(target=>target.height>=44),'手机目录、较早区与显示更多控件命中区均至少44px '+JSON.stringify(targets));
      }
      assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.sidebar').scrollWidth<=document.querySelector('.sidebar').clientWidth"),'中英文、深浅色与手机均无横向溢出');
      await shotD(`${variant}-older-details`,olderProject+' .project-toggle');
      await send('Target.closeTarget',{targetId:target.targetId},null);
    });
  }
  await check('阶段 D 隐私模式：较早区存储读取与写入抛错均退回内存',async()=>{
    const target=await openD(1440,'zh-CN','light','d-private-storage',`
      const olderGetItem=Storage.prototype.getItem,olderSetItem=Storage.prototype.setItem;
      Storage.prototype.getItem=function(key){if(key==='aireins-older-projects-open')throw new Error('Private storage read');return olderGetItem.call(this,key)};
      Storage.prototype.setItem=function(key,value){if(key==='aireins-older-projects-open')throw new Error('Private storage write');return olderSetItem.call(this,key,value)};
    `);
    assert.equal(await expanded(olderToggle),'false');
    await click(olderToggle); assert.equal(await expanded(olderToggle),'true');
    await click(olderToggle); assert.equal(await expanded(olderToggle),'false');
    await send('Target.closeTarget',{targetId:target.targetId},null);
  });
  console.log(`阶段 D 截图：${shotsD}`);
  await runNewSessionBrowserChecks({ send, evaluate, settle, waitFor, rect, click, key, check, base, shots:shotsD,
    activate: value => { sessionId = value; } });
  assert.deepEqual(errors, [], "没有未捕获的页面错误");
  console.log(`✅ sidebar resize: ${passed} browser checks; screenshots: ${output}`);
} catch (error) {
  console.error('Runtime errors:', errors.map(error => error.exception?.description ?? error.text));
  console.error('Browser diagnostics:', await evaluate("({handle:document.querySelector('.sidebar-resize')?.getBoundingClientRect().toJSON(),side:document.querySelector('.sidebar')?.getBoundingClientRect().toJSON(),style:document.querySelector('.sidebar')?.getAttribute('style'),events:window.__pointerTrace?.slice(-12),errors:document.querySelector('.toast')?.textContent})").catch(() => null));
  console.error(`Screenshots: ${output}`);
  throw error;
} finally {
  clearTimeout(watchdog);
  writeFileSync(join(output, "chromium.log"), stderr);
  browser.kill();
  await new Promise(resolve => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once("exit", resolve));
  await server.close();
}
