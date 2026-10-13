// 真实 Chromium 拖动/布局回归；只使用合成 API，不连接真实会话。
// CHROMIUM 可指定 Linux Chromium；默认复用本机 Playwright 的 headless shell。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
let stderr = "", buffer = "", id = 0, sessionId;
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
const watchdog = setTimeout(() => browser.kill(), 60000);
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
        title:'拉宽侧栏后应当继续显示完整会话标题和后面更多的详细信息以便查看内容'}] }, '/api/session-groups': { groups: [] },
      '/api/pages': { pages: [{id:'ai-usage',name:'AI 用量',icon:'📊',type:'iframe',url:'http://127.0.0.1:8788'}] },
      '/api/pages/ai-usage/health': {reachable:false,embeddable:false,reason:'测试页面'},
      '/api/history': {sessions:[],truncated:false,skipped:0,empty:0,discovered:0,durationMs:0},
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
  await check("最小宽度可打开新建，表单不横向溢出", async () => {
    await click(".btn-new-session");
    assert.ok(await evaluate("document.querySelector('.new-form').scrollWidth <= document.querySelector('.new-form').clientWidth"));
    await screenshot("minimum-new");
    await click(".btn-new-session");
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
    await dragTo(174); await checkWidth(52);
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
    await checkWidth(52);
    assert.ok(await evaluate("document.body.classList.contains('sidebar-resizing')"));
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:x-30,y,button:"left",buttons:1});
    await checkWidth(224);
    await send("Input.dispatchMouseEvent", {type:"mouseReleased",x:x-30,y,button:"left",buttons:0,clickCount:1});
    await settle();
    assert.ok(await evaluate("!document.body.classList.contains('sidebar-resizing')"));
  });
  await check("按钮收起后也能从边缘拖回，轻微晃动保持收起", async () => {
    await click(".sidebar-toggle"); await checkWidth(52);
    await dragTo(60); await checkWidth(52);
    await dragTo(304); await checkWidth(304);
    await dragTo(224);
  });
  await check("页面打开时拖过下限关闭页面，效果等同收起按钮", async () => {
    await click('.sidebar-foot-usage'); await dragTo(174); await checkWidth(52);
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
    await key("Home"); await checkWidth(224); await key("ArrowLeft"); await checkWidth(52);
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
  });
  assert.deepEqual(errors, [], "没有未捕获的页面错误");
  console.log(`✅ sidebar resize: ${passed} browser checks; screenshots: ${output}`);
} catch (error) {
  console.error('Runtime errors:', errors.map(error => error.exception?.description ?? error.text));
  console.error('Browser diagnostics:', await evaluate("({handle:document.querySelector('.sidebar-resize')?.getBoundingClientRect().toJSON(),side:document.querySelector('.sidebar')?.getBoundingClientRect().toJSON(),style:document.querySelector('.sidebar')?.getAttribute('style'),events:window.__pointerTrace,errors:document.querySelector('.toast')?.textContent})").catch(() => null));
  console.error(`Screenshots: ${output}`);
  throw error;
} finally {
  clearTimeout(watchdog);
  writeFileSync(join(output, "chromium.log"), stderr);
  browser.kill();
  await new Promise(resolve => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once("exit", resolve));
  await server.close();
}
