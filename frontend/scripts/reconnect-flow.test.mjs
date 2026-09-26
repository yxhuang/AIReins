#!/usr/bin/env node
// 断线重连回归：手机切后台 / 锁屏回来时的「僵尸」WS 必须被换掉，退避等待可以被立即重连跳过。
// 浏览器依赖全部打桩，不需要真实 server。运行：npm run test:reconnect
import { strict as assert } from "node:assert";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    FakeWebSocket.all.push(this);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSING;
    // 和浏览器一样异步触发 close：旧连接的 close 事件晚于新连接建立才到
    setTimeout(() => {
      this.readyState = FakeWebSocket.CLOSED;
      for (const fn of this.listeners.get("close") ?? []) fn({});
    }, 0);
  }
  send() {}
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = FakeWebSocket;
globalThis.window = { location: { protocol: "http:", host: "127.0.0.1:8790", hash: "#/" }, addEventListener() {} };
globalThis.document = { visibilityState: "visible", addEventListener() {} };

const { Store } = await import("../src/store.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};
const latest = () => FakeWebSocket.all.at(-1);

await t("连接健康时 reconnectNow() 不换连接", async () => {
  const s = new Store();
  s.connect();
  latest().readyState = FakeWebSocket.OPEN;
  const before = FakeWebSocket.all.length;
  s.reconnectNow();
  assert.equal(FakeWebSocket.all.length, before, "不应新建连接");
});

await t("reconnectNow(true) 换掉看似 OPEN 的僵尸连接；旧连接晚到的 close 不影响新连接", async () => {
  const s = new Store();
  s.connect();
  const zombie = latest();
  zombie.readyState = FakeWebSocket.OPEN;
  s.reconnectNow(true);
  assert.notEqual(latest(), zombie, "应立即新建连接");
  await tick(); // 旧连接的 close 事件此时才到
  assert.equal(zombie.readyState, FakeWebSocket.CLOSED, "旧连接应被关掉");
  assert.equal(s.socket, latest(), "store 仍应指向新连接");
  assert.equal(s.reconnectTimer, undefined, "旧连接的 close 不应排定重连计时器");
  assert.equal(s.wsState, "connecting", "旧连接的 close 不能把新连接的状态改成 closed");
});

await t("断线后的退避等待可以被 reconnectNow() 跳过", async () => {
  const s = new Store();
  s.connect();
  latest().close(); // 模拟服务端断开：进入退避
  await tick();
  assert.notEqual(s.reconnectTimer, undefined, "断开后应排定重连");
  const before = FakeWebSocket.all.length;
  s.reconnectNow();
  assert.equal(FakeWebSocket.all.length, before + 1, "应立即新建连接");
  assert.equal(s.reconnectTimer, undefined, "退避计时器应被清掉");
  assert.equal(s.reconnectDelay, 1000, "退避时长应复位");
});

await t("切回前台：离开超过 30 秒强制重连，5 秒内不动", async () => {
  const s = new Store();
  s.connect();
  latest().readyState = FakeWebSocket.OPEN;
  const before = FakeWebSocket.all.length;

  document.visibilityState = "hidden";
  s.onVisibilityChange();
  s.hiddenAt = Date.now() - 5_000;
  document.visibilityState = "visible";
  s.onVisibilityChange();
  assert.equal(FakeWebSocket.all.length, before, "短暂切走不应重连");

  document.visibilityState = "hidden";
  s.onVisibilityChange();
  s.hiddenAt = Date.now() - 31_000;
  document.visibilityState = "visible";
  s.onVisibilityChange();
  assert.equal(FakeWebSocket.all.length, before + 1, "长时间切走回来应强制重连");
});

await t("网络恢复：卡在 CONNECTING 的连接也换掉", async () => {
  const s = new Store();
  s.connect(); // 停在 CONNECTING：模拟断网期间发起、一直没结果的连接
  const stuck = latest();
  s.onOnline();
  assert.notEqual(latest(), stuck, "应新建连接");
  assert.equal(s.socket, latest(), "store 应指向新连接");
});

if (!process.exitCode) console.log(`✅ 重连逻辑回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
// store 里可能还挂着计时器，直接退出，不等它们
process.exit(process.exitCode ?? 0);
