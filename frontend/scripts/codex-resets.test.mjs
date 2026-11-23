// Linux Chromium + Vite；所有 API / WS 都是合成数据，不访问真实后端或 AIHOT。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const output = process.env.CODEX_RESETS_SHOTS ?? join(tmpdir(), "aireins-codex-resets-shots");
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
const inactive = { enabled: true, lastSuccessAt: iso(0), stale: false, monitor: { status: "healthy" }, pending: [], recent: [], alerts: [] };
const agEvent = { ...previous, id: "ag-event", confirmedAt: iso(-60_000), title: "Antigravity 额度重置已完成", url: "https://x.com/_mohansolo/status/1" };
const agAlert = { ...alert, id: "ag-alert", action: "confirm", publishedAt: iso(-30_000), url: agEvent.url, events: [agEvent] };
const initial = { ...inactive, sources: [
  { provider: "antigravity", status: inactive },
  { provider: "claude", status: inactive },
  { provider: "grok-bot", status: inactive },
] };
const active = { ...initial, sources: initial.sources.map(source => source.provider === "antigravity"
  ? { ...source, status: { ...inactive, recent: [agEvent, previous], alerts: [agAlert] } } : source) };
const channel = `codex-resets-test-${process.pid}`;
const fixtureScript = (locale) => `
  localStorage.setItem('workbench-language', ${JSON.stringify(locale)});
  localStorage.setItem('workbench-sidebar-width','360');
  localStorage.setItem('workbench-sidebar-default-width','360');
  window.__resetStatus = ${JSON.stringify(initial)};
  window.__writes = [];
  const fixtures = {
    '/api/meta': {defaultCwd:'/repo',capabilities:{terminal:false},drivers:Object.fromEntries(['claude','codex','kimi'].map(id=>[id,{configOptions:[],available:true}]))},
    '/api/sessions': {sessions:[]}, '/api/project-order': {paths:[]}, '/api/fs/dirs': {path:'/repo',parent:'/',dirs:[],files:[]},
    '/api/pages': {pages:[]},
    '/api/usage': ${JSON.stringify({ updated_at: iso(0), providers: [{ id: "codex", name: "Codex", plan: "Plus", status: "ok", error: null, fetched_at: iso(0), reset_credits: null, windows: [{ id: "5h", label: "5h", duration_ms: 18_000_000, used_pct: 12, resets_at: iso(7_200_000), note: null }, { id: "week", label: "Weekly", duration_ms: 604_800_000, used_pct: 25, resets_at: iso(86_400_000), note: null }] }] })},
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
      if (path==='/api/usage/open' && init.method==='POST') {
        data = fixtures['/api/usage'] ?? {};
      } else {
        window.__writes.push({path,method:init.method,body:init.body});
        if (path!=='/api/codex-resets/ack' || init.method!=='POST') throw new Error('Unexpected API write '+path);
        const {id,provider} = JSON.parse(init.body);
        const status = window.__resetStatus;
        const clear = data => ({...data,alerts:data.alerts.filter(item=>item.id!==id)});
        window.__publishStatus(!provider || provider==='codex' ? clear(status) : {...status,
          sources:status.sources.map(source=>source.provider===provider?{...source,status:clear(source.status)}:source)});
      }
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
  await send(session, "Page.navigate", { url: base + "/#/usage" });
  await waitFor(session, "document.querySelector('.codex-reset-toggle')");
  return session;
};
const publish = async (target, status) => { await evaluate(target, `window.__publishStatus(${JSON.stringify(status)})`); await settle(target); };
const theme = async (target, value) => { await evaluate(target, `document.documentElement.setAttribute('data-theme',${JSON.stringify(value)})`); await settle(target); };
const viewport = async (target, width, height) => {
  await send(target, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 720 });
  await send(target, "Emulation.setTouchEmulationEnabled", { enabled: width <= 720 });
  await settle(target);
};
const checkBounds = async (target, selector) => {
  const data = await evaluate(target, `(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,scroll:e.scrollWidth,client:e.clientWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth}})()`);
  assert.ok(data.x >= -1 && data.y >= -1 && data.right <= data.w + 1 && data.bottom <= data.h + 1, `${selector} fits viewport: ${JSON.stringify(data)}`);
  assert.ok(data.scroll <= data.client + 1 && data.pageOverflow <= 0, `${selector} has no horizontal overflow`);
};
const measuring = (target) => evaluate(target, `(() => {
  const height = selector => document.querySelector(selector).getBoundingClientRect().height;
  return { viewport: innerHeight, panel: height('.usage-view'), usage: height('.usage-scroll'), card: height('.codex-reset-card') };
})()`);
const expanded = (target) => evaluate(target, "document.querySelector('.codex-reset-toggle').getAttribute('aria-expanded')");
const watchdog = setTimeout(() => browser.kill(), 60000);
try {
  await send(null, "Browser.getVersion");
  const first = await createPage(), second = await createPage();
  for (const [width, height] of [[1280, 660], [390, 700], [320, 560]]) {
    await viewport(first, width, height);
    await theme(first, width === 390 ? "dark" : "light");
    await publish(first, initial);
    assert.equal(await expanded(first), "false");
    assert.equal(await evaluate(first, "document.querySelectorAll('.codex-reset-rail button svg').length"), 4);
    await checkBounds(first, ".codex-reset-rail");
    const idle = await measuring(first);
    assert.equal(idle.card, 36, "常态只占一行");
    assert.ok(idle.usage + idle.card <= idle.panel + 1);
    await publish(first, active);
    assert.equal(await expanded(first), "true");
    assert.match(await evaluate(first, "document.querySelector('.codex-reset-toggle').textContent"), /已确认/);
    assert.equal(await evaluate(first, "document.querySelector('.codex-reset-rail [aria-checked=true]').getAttribute('aria-label')"), "Antigravity");
    assert.equal(await evaluate(first, "document.querySelectorAll('.codex-reset-rail button svg').length"), 4);
    assert.ok(await evaluate(first, "!!document.querySelector('a[href=\"https://aihot.news/antigravity-reset\"]')"));
    await checkBounds(first, ".codex-reset-card");
    const open = await measuring(first);
    assert.ok(open.card > idle.card && open.card <= Math.min(104, open.panel / 4) + 1, JSON.stringify(open));
    assert.ok(open.usage >= idle.usage - 68, "展开最多增加 68px");
    if (width !== 1280) await shot(first, `reset-panel-${width}`);
    console.log(`PASS ${width}×${height} 重置区 ${idle.card}px → ${open.card}px`);
  }
  await publish(first, initial);
  for (const [label, provider] of [["Codex", "codex"], ["Antigravity", "antigravity"], ["Claude", "claude"], ["Grok Bot", "grok-bot"]]) {
    await click(first, `.codex-reset-rail [aria-label="${label}"]`);
    assert.equal(await expanded(first), "true", `${label} 可以从收起状态直接展开`);
    assert.equal(await evaluate(first, "document.querySelector('.codex-reset-details a[href^=\"https://aihot.news/\"]').href"), `https://aihot.news/${provider}-reset`);
    await click(first, ".codex-reset-toggle");
    assert.equal(await expanded(first), "false");
  }
  await publish(first, active);
  await click(first, ".codex-reset-toggle");
  assert.equal(await expanded(first), "false", "手动收起保留未读");
  assert.equal(await expanded(second), "true", "另一端继续显示未读");
  await click(first, '.codex-reset-rail [aria-label="Antigravity"]');
  assert.equal(await expanded(first), "true", "收起后点当前高亮图标也可以展开");
  const slider = () => evaluate(first, "document.querySelector('.codex-reset-rail .segmented-slider').style.transform");
  const firstPosition = await slider();
  const claude = '.codex-reset-rail [aria-label="Claude"]';
  await click(first, claude);
  assert.notEqual(await slider(), firstPosition, "点击切换时滑块移动到新图标");
  assert.ok(await evaluate(first, "!!document.querySelector('a[href=\"https://aihot.news/claude-reset\"]')"));
  await evaluate(first, `document.querySelector(${JSON.stringify(claude)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  assert.equal(await evaluate(first, "document.querySelector('.codex-reset-rail [aria-checked=true]').getAttribute('aria-label')"), "Grok Bot");
  await click(first, ".codex-reset-toggle");
  const newAlert = { ...agAlert, id: "next-ag-alert" };
  await publish(first, { ...active, sources: active.sources.map(source => source.provider === "antigravity"
    ? { ...source, status: { ...source.status, alerts: [newAlert] } } : source) });
  assert.equal(await expanded(first), "true", "新公告可以再次自动展开");
  await click(first, ".codex-reset-ack");
  await waitFor(second, "document.querySelector('.codex-reset-toggle').getAttribute('aria-expanded')==='false'");
  assert.equal(await expanded(first), "false");
  assert.deepEqual(await evaluate(first, "JSON.parse(window.__writes.at(-1).body)"), { id: "next-ag-alert", provider: "antigravity" });
  await evaluate(first, "location.hash='#/'");
  await waitFor(first, "!document.querySelector('.usage-view')");
  await publish(first, active);
  assert.ok(await evaluate(first, "document.querySelector('.codex-reset-dot') && !document.querySelector('.codex-reset-card,.codex-reset-dialog')"));
  const english = await createPage("en");
  await viewport(english, 320, 560);
  await publish(english, { ...initial, pending: [event], recent: [event] });
  assert.match(await evaluate(english, "document.querySelector('.codex-reset-toggle').textContent"), /Reset events.*Announced/);
  await checkBounds(english, ".codex-reset-card");
  assert.deepEqual(errors, [], "没有未捕获的页面错误");
  console.log("✅ quota resets: compact layout, local collapse, shared ack, no global overlay");
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
