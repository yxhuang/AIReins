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

/**
 * 打桩 fetch（全功能版）：在 stubFetch 基础上补 /files 精确检索与 DELETE。
 * knownFiles 模拟会话 cwd 下真实存在的文件；返回子串匹配列表（与后端检索语义一致），
 * resolveFile 的「精确 includes 才算存在」判定在 store 内完成。queries 传入数组可记录查询顺序。
 */
function stubFetchFull(session, { knownFiles = [], queries = null } = {}) {
  globalThis.fetch = (path, init) => {
    path = String(path);
    if (path === "/api/sessions" && init?.method === "POST") return Promise.resolve(envelope({ session }));
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot")) return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    if (path.includes("/files?")) {
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
      queries?.push(q);
      return Promise.resolve(envelope({ files: knownFiles.filter((f) => f.includes(q)) }));
    }
    if (init?.method === "DELETE") return Promise.resolve(envelope({}));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

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

// --- 用例 5：@ 引用尾部标点剥离——整 token 优先，剥后命中才采纳 ---
await t("整 token 命中不剥离（文件名真带标点不冤枉）", async () => {
  const session = makeSession("s-punct-1");
  const queries = [];
  stubFetchFull(session, { knownFiles: ["report，final.txt"], queries });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "report，final.txt");
  assert.equal(resolved, "report，final.txt", "整 token 命中应原样采用");
  assert.deepEqual(queries, ["report，final.txt"], "整 token 命中后不应再发剥离查询");
});

await t("剥后命中才采纳：句末逗号剥掉后命中真实文件", async () => {
  const session = makeSession("s-punct-2");
  const queries = [];
  stubFetchFull(session, { knownFiles: ["a.ts"], queries });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "a.ts，");
  assert.equal(resolved, "a.ts", "剥掉尾部逗号后应命中 a.ts");
  assert.deepEqual(queries, ["a.ts，", "a.ts"], "应先查整 token 再查剥离候选");
});

await t("剥到底仍不中维持未找到（结论缓存为 null）", async () => {
  const session = makeSession("s-punct-3");
  stubFetchFull(session, { knownFiles: [] });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "ghost.txt，。");
  assert.equal(resolved, null, "剥到底仍不中应返回 null");
  assert.equal(s.mentionPathSync(session.id, "ghost.txt，。"), null, "未找到结论应缓存");
});

await t("发送帧 mentions 用生效路径，文本原样保留", async () => {
  const session = makeSession("s-punct-4");
  stubFetchFull(session, { knownFiles: ["a.ts"] });
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
  const ok = await s.sendComposerInput(session.id, "看看 @a.ts， 然后");
  assert.equal(ok, true, "OPEN 下应发送成功");
  const frame = sent.find((f) => f.type === "user_message");
  assert.ok(frame, "上行帧未写出");
  assert.equal(frame.text, "看看 @a.ts， 然后", "文本应原样发送（@ 锚点不动）");
  assert.deepEqual(frame.mentions, [{ type: "file", path: "a.ts" }], "mentions 应用剥离后的生效路径");
});

// --- 用例 6：per-session 草稿缓存 ---
await t("草稿按会话隔离：A 存草稿切 B 再切回 A 仍在", async () => {
  const sA = makeSession("s-draft-a");
  const sB = makeSession("s-draft-b");
  stubFetchFull(sA);
  const s = new Store();
  s.setDraft(sA.id, "给 A 的草稿");
  s.setDraft(sB.id, "给 B 的草稿");
  assert.equal(s.getDraft(sB.id), "给 B 的草稿", "B 草稿不对（串台）");
  assert.equal(s.getDraft(sA.id), "给 A 的草稿", "切回 A 草稿丢了");
});

await t("发送成功清草稿（草稿带首尾空白也认得）", async () => {
  const session = makeSession("s-draft-ok");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.setDraft(session.id, "  发出去了  ");
  assert.equal(await s.sendComposerInput(session.id, "发出去了"), true, "OPEN 下应发送成功");
  assert.equal(s.getDraft(session.id), "", "发送成功后草稿应清空");
});

await t("发送失败草稿保留", async () => {
  const session = makeSession("s-draft-fail");
  stubFetchFull(session);
  const s = new Store();
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.socket = { readyState: 3, send() { throw new Error("不应触达"); } };
  s.setDraft(session.id, "别丢我");
  assert.equal(await s.sendComposerInput(session.id, "别丢我"), false, "非 OPEN 应失败");
  assert.equal(s.getDraft(session.id), "别丢我", "发送失败草稿应保留");
});

await t("发送成功不清掉间隙新输入的草稿", async () => {
  // mentions 路径是异步的：模拟解析间隙用户又输入了新内容
  const session = makeSession("s-draft-race");
  stubFetchFull(session, { knownFiles: ["a.ts"] });
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
  s.setDraft(session.id, "@a.ts 看看");
  const p = s.sendComposerInput(session.id, "@a.ts 看看");
  s.setDraft(session.id, "间隙新内容"); // 用户在发送间隙又输入
  assert.equal(await p, true, "OPEN 下应发送成功");
  assert.equal(s.getDraft(session.id), "间隙新内容", "间隙新输入的草稿不应被误清");
});

await t("remove 后草稿清除不泄漏", async () => {
  const session = makeSession("s-draft-rm");
  stubFetchFull(session);
  const s = new Store();
  s.sessions = [session];
  s.socket = fakeSocket([]);
  s.setDraft(session.id, "将随会话删除");
  await s.remove(session.id);
  assert.equal(s.getDraft(session.id), "", "remove 后草稿应清掉");
  assert.equal(s.drafts.has(session.id), false, "drafts 条目应删除");
});

if (!process.exitCode) console.log(`✅ store 流程回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
// store 内部有 2s 防抖计时器，直接退出不等它
process.exit(process.exitCode ?? 0);
