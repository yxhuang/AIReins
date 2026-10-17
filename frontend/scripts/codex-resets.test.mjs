// Linux Chromium + Vite；所有 API / WS 都是合成数据，不访问真实后端或 AIHOT。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const output = process.env.CODEX_RESETS_SHOTS ?? "/tmp/claude-1000/-home-user-dev-AIReins/00000000-0000-4000-8000-000000000013/scratchpad/codex-resets-shots";
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "aireins-codex-resets-"));
const cache = join(homedir(), ".cache/ms-playwright");
const chromium = process.env.CHROMIUM ?? join(cache,
  readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().at(-1),
  "chrome-headless-shell-linux64/chrome-headless-shell");
const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = spawn(chromium, ["--no-sandbox", "--headless", "--remote-debugging-pipe", `--user-data-dir=${profile}`],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let stderr = "", buffer = "", id = 0;
const pending = new Map(), errors = [];
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
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
const send = (target, method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 10000);
  pending.set(requestId, { resolve, reject, timer });
  browser.stdio[3].write(JSON.stringify({ id: requestId, method, params, ...(target ? { sessionId: target } : {}) }) + "\0");
});
const evaluate = async (target, expression) => {
  const response = await send(target, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
const settle = (target) => evaluate(target, "new Promise(resolve => setTimeout(resolve, 150))");
const waitFor = (target, condition) => evaluate(target, `new Promise((resolve, reject) => {
  const deadline = Date.now() + 8000;
  const check = () => { if (${condition}) resolve(true); else if (Date.now() > deadline) reject(new Error('UI readiness timed out: '+${JSON.stringify(condition)})); else requestAnimationFrame(check); }; check();
})`);
const click = async (target, selector) => { await evaluate(target, `document.querySelector(${JSON.stringify(selector)}).click()`); await settle(target); };
const key = async (target, value, modifiers = 0) => {
  await send(target, "Input.dispatchKeyEvent", { type: "keyDown", key: value, modifiers });
  await send(target, "Input.dispatchKeyEvent", { type: "keyUp", key: value, modifiers });
  await settle(target);
};
const shot = async (target, name) => {
  await settle(target);
  const result = await send(target, "Page.captureScreenshot");
  writeFileSync(join(output, `${name}.png`), Buffer.from(result.data, "base64"));
};
const now = Date.now(), iso = (offset) => new Date(now + offset).toISOString();
const original = "We are rolling out a Codex usage reset over the next two hours.";
const context = [{ id: "quoted", text: "将在接下来 2 小时内落地", originalText: "Rolling out in the next 2 hours", url: "https://x.com/tibo/status/quoted", relation: "quoted" }];
const event = { id: "reset-upcoming", type: "direct_reset", status: "announced", title: "Codex 额度重置即将生效", presentation: { scopeLabel: "Codex", audienceZh: "所有 Codex 用户" },
  schedule: { precision: "window", from: iso(30 * 60_000), through: iso(102 * 60_000), label: "北京时间预计今天 18:00 前" }, estimate: null,
  createdAt: iso(-3600_000), updatedAt: iso(-60_000), url: "https://x.com/tibo/status/new", posts: [{ id: "new", text: "我们即将为 Codex 用户重置额度，感谢大家的耐心等待。", originalText: original, url: "https://x.com/tibo/status/new", publishedAt: iso(-60_000), context }] };
const previous = { ...event, id: "reset-previous", type: "reset_credit", status: "confirmed", title: "Codex 重置卡已发放", schedule: null, estimate: null, confirmedAt: iso(-86400_000), updatedAt: iso(-86400_000), posts: [] };
const alert = { ...event.posts[0], kind: "event_update", action: "announce", eventIds: [event.id], events: [event] };
const olderAlert = { id: "older", kind: "event_update", action: "confirm", text: "重置卡已经发放。", url: "https://x.com/tibo/status/older", context: [], publishedAt: iso(-86400_000), eventIds: [previous.id], events: [previous] };
const initial = { enabled: true, lastSuccessAt: iso(0), stale: false, monitor: { status: "healthy" }, pending: [event], recent: [event, previous], alerts: [alert, olderAlert] };
const channel = `codex-resets-test-${process.pid}`;
const fixtureScript = (locale) => `
  localStorage.setItem('workbench-language', ${JSON.stringify(locale)});
  localStorage.setItem('workbench-sidebar-width','360');
  localStorage.setItem('workbench-sidebar-default-width','360');
  window.__resetStatus = ${JSON.stringify(initial)};
  window.__writes = [];
  const fixtures = {
    '/api/meta': {defaultCwd:'/repo',capabilities:{terminal:false},drivers:Object.fromEntries(['claude','codex','kimi'].map(id=>[id,{configOptions:[],available:true}]))},
    '/api/sessions': {sessions:[]}, '/api/project-order': {paths:[]},
    '/api/pages': {pages:[{id:'ai-usage',name:'AI-Usage',icon:'📊',type:'iframe',url:'about:blank'}]},
    '/api/pages/ai-usage/health': {reachable:true,embeddable:true,reason:'Synthetic iframe fixture',durationMs:1},
    '/api/history': {sessions:[],truncated:false,skipped:0,empty:0,discovered:0,durationMs:0},
    '/api/links': {links:[]}, '/api/prefs': {idleReleaseMinutes:0,codexResetWatch:true},
    '/api/claude/settings': {remoteControlAtStartup:false},
  };
  const sockets = new Set(), bus = new BroadcastChannel(${JSON.stringify(channel)});
  window.__emitStatus = (status) => {
    window.__resetStatus = status;
    for (const socket of sockets) socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'codex_resets_updated',data:status})}));
  };
  bus.onmessage = event => window.__emitStatus(event.data);
  window.__publishStatus = status => { window.__emitStatus(status); bus.postMessage(status); };
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const path = new URL(typeof input==='string'?input:input.url,location.href).pathname;
    if (!path.startsWith('/api/')) return realFetch(input,init);
    let data = fixtures[path] ?? {};
    if (init?.method && init.method!=='GET') {
      window.__writes.push({path,method:init.method,body:init.body});
      if (path!=='/api/codex-resets/ack' || init.method!=='POST') throw new Error('Unexpected API write '+path);
      const id = JSON.parse(init.body).id;
      window.__publishStatus({...window.__resetStatus,alerts:window.__resetStatus.alerts.filter(item=>item.id!==id)});
    }
    if (path==='/api/codex-resets') data=window.__resetStatus;
    return Promise.resolve(new Response(JSON.stringify({code:0,data,msg:'',request_id:'fixture'}),{headers:{'content-type':'application/json'}}));
  };
  window.WebSocket = class extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=1;
    constructor(){super();sockets.add(this);setTimeout(()=>this.dispatchEvent(new Event('open')),0)}
    close(){this.readyState=3;sockets.delete(this)} send(){}
  };
`;
const createPage = async (locale = "zh-CN") => {
  const target = await send(null, "Target.createTarget", { url: "about:blank" });
  const session = (await send(null, "Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await send(session, "Page.enable"); await send(session, "Runtime.enable");
  await send(session, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await send(session, "Page.addScriptToEvaluateOnNewDocument", { source: fixtureScript(locale) });
  await send(session, "Page.navigate", { url: base });
  await waitFor(session, "document.querySelector('.codex-reset-dialog') && document.querySelector('.codex-reset-dot')");
  return session;
};
const publish = async (target, status) => { await evaluate(target, `window.__publishStatus(${JSON.stringify(status)})`); await settle(target); };
const theme = async (target, value) => { await evaluate(target, `document.documentElement.setAttribute('data-theme',${JSON.stringify(value)})`); await settle(target); };
const viewport = async (target, width) => {
  await send(target, "Emulation.setDeviceMetricsOverride", { width, height: width <= 720 ? 844 : 820, deviceScaleFactor: 1, mobile: width <= 720 });
  await send(target, "Emulation.setTouchEmulationEnabled", { enabled: width <= 720 }); await settle(target);
};
const geometry = (target) => evaluate(target, `(() => {
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
  return {foot:rect(document.querySelector('.sidebar-foot')),buttons:[...document.querySelectorAll('.sidebar-foot > *')].map(rect)};
})()`);
const checkBounds = async (target, selector) => {
  const data = await evaluate(target, `(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,scroll:e.scrollWidth,client:e.clientWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth}})()`);
  assert.ok(data.x >= -1 && data.y >= -1 && data.right <= data.w + 1 && data.bottom <= data.h + 1, `${selector} fits viewport: ${JSON.stringify(data)}`);
  assert.ok(data.scroll <= data.client + 1 && data.pageOverflow <= 0, `${selector} has no horizontal overflow`);
};
const checkActionAlignment = async (target) => {
  const buttons = await evaluate(target, `([...document.querySelectorAll('.codex-reset-actions .btn')].map(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    return { tag: element.tagName, delta: (text.top + text.bottom - box.top - box.bottom) / 2 };
  }))`);
  assert.equal(buttons.length, 3);
  for (const button of buttons) assert.ok(Math.abs(button.delta) <= 2, `${button.tag} text is vertically centered: ${button.delta}`);
  assert.ok(Math.abs(buttons[0].delta - buttons[1].delta) <= 1, '原帖链接与额度页按钮文字居中一致');
};
let passed = 0;
const check = async (name, task) => { await task(); passed++; console.log(`PASS ${name}`); };
const watchdog = setTimeout(() => browser.kill(), 180000);
try {
  await send(null, "Browser.getVersion");
  const first = await createPage(), second = await createPage();
  await check("全局弹窗内容、来源、原文和多条未读", async () => {
    const contents = await evaluate(first, "document.querySelector('.codex-reset-dialog').textContent");
    assert.match(contents, /适用：Codex/);
    assert.match(contents, /预告/); assert.match(contents, /额度重置/); assert.match(contents, /还有 1 条/);
    assert.match(contents, /我们即将为 Codex 用户重置额度/); assert.match(contents, /将在接下来 2 小时内落地/);
    assert.equal(await evaluate(first, "document.querySelector('.codex-reset-dialog').getAttribute('aria-modal')"), "true");
    assert.equal(await evaluate(first, "document.querySelector('.codex-reset-dialog').getAttribute('role')"), "dialog");
    assert.ok(await evaluate(first, "document.querySelector('.codex-reset-dialog a[href=\"https://aihot.news/codex-reset\"]') !== null"));
    await click(first, ".codex-reset-original summary");
    assert.ok(await evaluate(first, "document.querySelector('.codex-reset-original').open"));
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-original').textContent"), /rolling out/i);
    await click(first, ".codex-reset-original summary");
  });
  await check("明暗桌面与 390/320 手机弹窗不溢出", async () => {
    for (const width of [1280, 390, 320]) for (const value of ["light", "dark"]) {
      await viewport(first, width); await theme(first, value); await checkBounds(first, ".codex-reset-dialog");
      await checkActionAlignment(first);
      await shot(first, `modal-${value}-${width === 1280 ? "desktop" : width === 390 ? "mobile" : "mobile-320"}`);
    }
  });
  await check("Tab 循环、Escape 不确认与下轮仍可提示", async () => {
    assert.ok(await evaluate(first, "document.querySelector('.codex-reset-dialog').contains(document.activeElement)"), "打开后焦点在弹窗内");
    for (let index = 0; index < 12; index++) { await key(first, "Tab"); assert.ok(await evaluate(first, "document.querySelector('.codex-reset-dialog').contains(document.activeElement)")); }
    await key(first, "Tab", 8); assert.ok(await evaluate(first, "document.querySelector('.codex-reset-dialog').contains(document.activeElement)"));
    await key(first, "Escape");
    assert.equal(await evaluate(first, "document.querySelectorAll('.codex-reset-dialog').length"), 0);
    assert.equal(await evaluate(first, "window.__writes.length"), 0, "Escape 不写 ack");
    await publish(first, { ...initial, alerts: [{ ...alert, id: "later" }] });
    await waitFor(first, "document.querySelector('.codex-reset-dialog')");
  });
  await check("知道了广播到另一个页面，逐条确认", async () => {
    await click(first, ".codex-reset-ack");
    await waitFor(second, "!document.querySelector('.codex-reset-dialog')");
    assert.equal(await evaluate(first, "window.__resetStatus.alerts.length"), 0);
    assert.equal(await evaluate(second, "window.__resetStatus.alerts.length"), 0);
    await publish(first, { ...initial, alerts: [{ ...alert, id: "multi-new" }, { ...olderAlert, id: "multi-older" }] });
    await waitFor(first, "document.querySelector('.codex-reset-dialog')");
    await click(first, ".codex-reset-ack");
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-dialog').textContent"), /重置卡/);
    await click(first, ".codex-reset-ack");
    await waitFor(second, "!document.querySelector('.codex-reset-dialog')");
    assert.equal(await evaluate(first, "window.__writes.every(write=>write.path==='/api/codex-resets/ack'&&write.method==='POST')"), true);
  });
  await check("底栏圆点不改变底栏高度（桌面 43px、手机 45px）或既有窄屏换行", async () => {
    for (const target of [first, second]) for (const width of [1280, 390, 320]) {
      await viewport(target, width); await publish(target, { ...initial, alerts: [] });
      const withDot = await geometry(target);
      assert.equal(await evaluate(target, "getComputedStyle(document.querySelector('.codex-reset-dot')).position"), "absolute");
      await publish(target, { ...initial, alerts: [], pending: [] });
      assert.equal(await evaluate(target, "document.querySelectorAll('.codex-reset-dot').length"), 0);
      assert.deepEqual(await geometry(target), withDot, `圆点不影响 ${width}px 几何`);
      if (width !== 320) assert.equal(withDot.foot.h, width > 720 ? 43 : 45, `${width}px 底栏高度`);
    }
  });
  await check("额度页跳转只收起本地弹窗，不确认", async () => {
    await viewport(first, 1280); await publish(first, { ...initial, alerts: [{ ...alert, id: "open-usage" }] });
    await waitFor(first, "document.querySelector('.codex-reset-open-usage')");
    const before = await evaluate(first, "window.__writes.length");
    await click(first, ".codex-reset-open-usage");
    await waitFor(first, "document.querySelector('.codex-reset-card') && !document.querySelector('.codex-reset-dialog')");
    await waitFor(first, "document.querySelector('.page-frame')?.getAttribute('src') === 'about:blank'");
    assert.equal(await evaluate(first, "document.querySelectorAll('.page-fallback').length"), 0, "卡片覆盖正常 iframe 路径");
    assert.ok(await evaluate(first, "document.querySelector('.codex-reset-card').compareDocumentPosition(document.querySelector('.page-frame')) & Node.DOCUMENT_POSITION_FOLLOWING"), "卡片位于 iframe 上方");
    assert.equal(await evaluate(first, "window.__writes.length"), before);
    assert.ok(await evaluate(second, "!!document.querySelector('.codex-reset-dialog')"), "另一页面保留未读弹窗");
  });
  await check("额度卡 pending、历史、推算、最近和过期状态", async () => {
    await publish(first, { ...initial, alerts: [] });
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-card').textContent"), /今天 18:00/);
    for (const width of [1280, 390]) for (const value of ["light", "dark"]) {
      await viewport(first, width); await theme(first, value); await checkBounds(first, ".codex-reset-card");
      await shot(first, `usage-card-${value}-${width === 1280 ? "desktop" : "mobile"}`);
    }
    await click(first, ".codex-reset-history summary");
    assert.ok(await evaluate(first, "document.querySelector('.codex-reset-history').open"));
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-history').textContent"), /重置卡/);
    await shot(first, "usage-card-history-mobile");
    const estimated = { ...event, schedule: null, estimate: { from:iso(30*60_000),through:iso(102*60_000),basis:"model",label:"预计 2 小时内" } };
    await publish(first, { ...initial, alerts: [], pending:[estimated],recent:[estimated,previous] });
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-card').textContent"), /推算/);
    for (const schedule of [{}, { from: "invalid-date", through: "invalid-date" }]) {
      const unknownTime = { ...event, schedule, estimate: null };
      await publish(first, { ...initial, alerts: [], pending:[unknownTime],recent:[unknownTime,previous] });
      assert.match(await evaluate(first, "document.querySelector('.codex-reset-card').textContent"), /时间待定/, "缺失或非法时间不使卡片崩溃");
    }
    await publish(first, { ...initial, alerts: [], pending:[],recent:[previous] });
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-card').textContent"), /最近一次/);
    await publish(first, { ...initial, alerts: [], pending:[],recent:[previous],stale:true,monitor:{status:"degraded"} });
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-card').textContent"), /过期|延迟|异常|暂不可用/);
    await shot(first, "usage-card-stale-mobile");
    await publish(first, { ...initial, enabled: false, alerts: [] });
    assert.equal(await evaluate(first, "document.querySelectorAll('.codex-reset-card,.codex-reset-dot,.codex-reset-dialog').length"), 0);
  });
  await check("英文 390/320 手机弹窗及圆点几何", async () => {
    const english = await createPage("en");
    for (const width of [390, 320]) {
      await viewport(english, width); await checkBounds(english, ".codex-reset-dialog");
      assert.match(await evaluate(english, "document.querySelector('.codex-reset-ack').textContent"), /got it|understood/i);
      assert.match(await evaluate(english, "document.querySelector('.codex-reset-scope').textContent"), /Applies to: Codex/);
      await checkActionAlignment(english);
      await shot(english, `modal-english-${width}`);
      await publish(english, { ...initial, alerts: [] });
      const withDot = await geometry(english);
      await publish(english, { ...initial, alerts: [], pending: [] });
      assert.deepEqual(await geometry(english), withDot, `英文 ${width}px 原有换行不变`);
      if (width === 390) assert.equal(withDot.foot.h, 45);
      if (width === 390) await publish(english, { ...initial, alerts:[{...alert,id:"english-320"}] });
    }
  });
  assert.deepEqual(errors, [], "没有未捕获的页面错误");
  console.log(`✅ codex resets: ${passed} browser checks; screenshots: ${output}`);
} catch (error) {
  console.error("Runtime errors:", errors.map(error => error.exception?.description ?? error.text));
  console.error(`Screenshots: ${output}`);
  throw error;
} finally {
  clearTimeout(watchdog); writeFileSync(join(output, "chromium.log"), stderr);
  browser.kill();
  await new Promise(resolve => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once("exit", resolve));
  await server.close();
}
