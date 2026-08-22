#!/usr/bin/env node
// store.ts 新建会话 / 快照对齐流程的回归测试。
// 背景缺陷：新建会话后发送没反应、界面永远空白（首次快照被静默丢弃 + create 未等加载 + finally 误删 in-flight）。
// 浏览器依赖（WebSocket / fetch）全部打桩，不需要真实 server；用 tsx 跑：npm run test:store
import { strict as assert } from "node:assert";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { Store } = await import("../src/store.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const settle = () => new Promise((r) => setTimeout(r, 20));

function makeSession(id) {
  const now = new Date().toISOString();
  return {
    id, agent: "kimi", agentId: `${id}-agent`, cwd: "/tmp", status: "idle",
    createdAt: now, lastActivityAt: now, seq: 0, transcriptPath: `/tmp/${id}.jsonl`,
    config: {}, riskyMode: false,
  };
}

function makeEvent(sessionId, seq, type = "agent_text") {
  return { type, sessionId, agentId: `${sessionId}-agent`, seq, timestamp: new Date().toISOString(), payload: {} };
}

function envelope(data) {
  return { json: async () => ({ code: 0, msg: "", data, request_id: "t" }) };
}

/** 假 WS：记录上行帧，readyState 恒 OPEN。 */
function fakeSocket(sent) {
  return { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
}

/**
 * 打桩 fetch。snapshotGate 给了就走手动闸门（数组收集 resolve，测试自己决定何时放行），
 * 否则立即返回空快照（seq 0、无事件）。
 */
function stubFetch(session, snapshotGate) {
  globalThis.fetch = (path, init) => {
    path = String(path);
    if (path === "/api/sessions" && init?.method === "POST") return Promise.resolve(envelope({ session }));
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot")) {
      if (snapshotGate) return new Promise((resolve) => snapshotGate.push(resolve));
      return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    }
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

// --- 用例 1：用户实测踩的坑——新建会话后不停留，立刻发送 ---
await t("新建会话后立即发送：data 建起、事件按 seq 累积、上行帧写出", async () => {
  const session = makeSession("s-new-1");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent); // 私有字段，测试直接写

  const created = await s.create({ agent: "kimi", cwd: "/tmp" });
  // 用户立刻发送：上行帧 + 服务端 echo / 后续事件紧随而来
  s.sendUserMessage(created.id, "hello");
  s.handleFrame(makeEvent(created.id, 1, "user_message"));
  s.handleFrame(makeEvent(created.id, 2));
  await settle();

  assert.ok(
    sent.some((f) => f.type === "user_message" && f.sessionId === created.id && f.text === "hello"),
    "上行 user_message 帧未写出",
  );
  const data = s.data.get(created.id);
  assert.ok(data, "create 返回后 data 没有该会话条目（事件落进「未加载」分支被吞）");
  assert.equal(data.seq, 2, `seq 应推进到 2，实际 ${data.seq}`);
  assert.deepEqual(data.events.map((e) => e.seq), [1, 2], "事件未按 seq 累积");
});

// --- 用例 2：新建会话后等一拍再发送 ---
await t("新建会话后等待再发送：同样通过", async () => {
  const session = makeSession("s-new-2");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);

  const created = await s.create({ agent: "kimi", cwd: "/tmp" });
  await settle();
  s.sendUserMessage(created.id, "world");
  s.handleFrame(makeEvent(created.id, 1, "user_message"));
  await settle();

  const data = s.data.get(created.id);
  assert.ok(data, "等待后 data 仍没有该会话条目（首次快照被静默丢弃）");
  assert.equal(data.seq, 1, `seq 应为 1，实际 ${data.seq}`);
  assert.deepEqual(data.events.map((e) => e.seq), [1]);
  assert.ok(sent.some((f) => f.type === "user_message" && f.text === "world"), "上行帧未写出");
});

// --- 用例 3：旧快照晚到不回滚已推进的 seq（finally 所有权校验回归） ---
await t("旧快照晚到不回滚已推进的 seq（in-flight 所有权）", async () => {
  const session = makeSession("s-race");
  const gate = []; // 手动放行的快照响应
  stubFetch(session, gate);
  const s = new Store();

  // A：首次加载；B：resync 发起的新快照（A 的响应应被版本戳作废，且 A 的 finally 不得误删 B 的条目）
  const pA = s.ensureLoaded(session.id);
  assert.equal(gate.length, 1, "A 快照请求未发出");
  const pB = s.resync(session.id);
  assert.equal(gate.length, 2, "B 快照请求未发出");

  // A 先回来（旧快照 seq=2）
  gate[0](envelope({ session, seq: 2, events: [makeEvent(session.id, 1), makeEvent(session.id, 2)] }));
  await pA;
  assert.ok(s.snapshotInflight.has(session.id), "旧请求的 finally 误删了新请求的 in-flight 条目");

  // B 回来（新快照 seq=3）：正常落地
  gate[1](envelope({ session, seq: 3, events: [1, 2, 3].map((n) => makeEvent(session.id, n)) }));
  await pB;
  assert.equal(s.data.get(session.id)?.seq, 3, "新快照未落地");

  // 再来一轮：D（seq=5）先落地，C（seq=4）晚到——不得把状态回滚
  const pC = s.resync(session.id);
  const pD = s.resync(session.id);
  assert.equal(gate.length, 4, "C/D 快照请求未发出");
  gate[3](envelope({ session, seq: 5, events: [1, 2, 3, 4, 5].map((n) => makeEvent(session.id, n)) }));
  await pD;
  gate[2](envelope({ session, seq: 4, events: [1, 2, 3, 4].map((n) => makeEvent(session.id, n)) }));
  await pC;
  const data = s.data.get(session.id);
  assert.equal(data?.seq, 5, `旧快照晚到把 seq 回滚成 ${data?.seq}`);
  assert.equal(data?.events.length, 5, "旧快照晚到改写了事件列表");
});

// --- 用例 4：socket 非 OPEN 时发送不静默——所有发送路径返回 false、不上行、置 lastError ---
// 背景缺陷：send() 在非 OPEN 时丢帧只置 lastError，Composer 却已清空输入框，文本凭空消失。
// store 层契约：发送方法返回 false，UI 据此把文本还回输入框（本用例只测 store 层）。
await t("socket 非 OPEN：sendUserMessage / sendCommand / sendComposerInput 全路径返回失败", async () => {
  const session = makeSession("s-off");
  stubFetch(session);
  const s = new Store();
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: true, mentions: true } } };
  s.commands.set(session.id, [{ name: "help", description: "", source: "kimi" }]);

  // 两种非 OPEN 形态：socket 未建立（null）与已关闭（readyState=CLOSED）
  for (const socket of [null, { readyState: 3, send() { sent.push("不应触达"); } }]) {
    const sent = [];
    s.socket = socket;
    s.lastError = null;

    assert.equal(s.sendUserMessage(session.id, "hi"), false, "sendUserMessage 未返回 false");
    assert.ok(s.lastError, "失败后未置 lastError 提示");
    assert.equal(s.sendCommand(session.id, "help", ""), false, "sendCommand 未返回 false");

    // sendComposerInput 三分支：纯文本 / 命中命令表的结构化 command / mentions 异步路径
    assert.equal(await s.sendComposerInput(session.id, "普通文本"), false, "纯文本分支未返回 false");
    assert.equal(await s.sendComposerInput(session.id, "/help"), false, "结构化命令分支未返回 false");
    // @a.ts 不存在（files 接口未打桩，resolveFile 失败不缓存结论），mentions 为空仍要发出文本
    assert.equal(await s.sendComposerInput(session.id, "看看 @a.ts 这个"), false, "mentions 分支未返回 false");
    assert.equal(sent.length, 0, "非 OPEN 时不应有任何上行帧");
  }

  // 对照：OPEN 时同一调用返回 true 且帧写出
  const sent = [];
  s.socket = fakeSocket(sent);
  assert.equal(s.sendUserMessage(session.id, "hi"), true, "OPEN 时 sendUserMessage 应返回 true");
  assert.equal(await s.sendComposerInput(session.id, "/help"), true, "OPEN 时命令分支应返回 true");
  assert.equal(sent.length, 2, "OPEN 时上行帧未写出");
});

if (!process.exitCode) console.log(`✅ store 流程回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
// store 内部有 2s 防抖计时器，直接退出不等它
process.exit(process.exitCode ?? 0);
