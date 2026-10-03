#!/usr/bin/env node
// 「+」附件流程回归：needsImageReencode 判定 + sendComposerInput 的 extraMentions
// 合并/去重/20 条截断/命令分支互斥/失败语义。浏览器依赖（WebSocket / fetch）全部打桩，
// 不需要真实 server；用 tsx 跑：npm run test:attach
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { needsImageReencode, attachmentMention } = await import("../src/attachments.ts");
const { Store, MAX_MENTIONS } = await import("../src/store.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

function makeSession(id) {
  const now = new Date().toISOString();
  return {
    id, agent: "kimi", agentId: `${id}-agent`, cwd: "/tmp", status: "idle",
    createdAt: now, lastActivityAt: now, seq: 0, transcriptPath: `/tmp/${id}.jsonl`,
    config: {}, riskyMode: false,
  };
}

function envelope(data) {
  return { json: async () => ({ code: 0, msg: "", data, request_id: "t" }) };
}

/** 假 WS：记录上行帧，readyState 恒 OPEN。 */
function fakeSocket(sent) {
  return { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
}

/** 与 store-flow 同一打法：knownFiles 模拟会话 cwd 下真实存在的文件（子串匹配）。 */
function stubFetch(session, { knownFiles = [] } = {}) {
  globalThis.fetch = (path) => {
    path = String(path);
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot?tail=1")) return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    if (path.includes("/files?")) {
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
      return Promise.resolve(envelope({ files: knownFiles.filter((f) => f.includes(q)) }));
    }
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

const imageMention = (path, name = "p.png") =>
  ({ type: "image", path, mimeType: "image/png", name });
const fileMention = (path, name = "f.txt") => ({ type: "file", path, name });

// --- needsImageReencode ---
await t("needsImageReencode：png 1MB 不压 / png 4MB 压 / heic 任意大小压 / 非图片不压", async () => {
  assert.equal(needsImageReencode("image/png", 1 * 1024 * 1024), false, "png 1MB 不应重编码");
  assert.equal(needsImageReencode("image/png", 4 * 1024 * 1024), true, "png 4MB 应重编码");
  assert.equal(needsImageReencode("image/heic", 100), true, "heic 任意大小都应重编码");
  assert.equal(needsImageReencode("text/plain", 10 * 1024 * 1024), false, "非图片一律不重编码");
  assert.equal(needsImageReencode("image/jpeg", 3.5 * 1024 * 1024), false, "恰好阈值不触发（> 才压）");
});

// --- attachmentMention：ready 才进发送帧 ---
await t("attachmentMention：uploading/error 返回 null，ready 按 mimeType 分 image/file", async () => {
  assert.equal(attachmentMention({ id: "1", source: "upload", name: "a.png", status: "uploading" }), null);
  assert.equal(attachmentMention({ id: "2", source: "upload", name: "a.png", status: "error", error: "x" }), null);
  assert.deepEqual(
    attachmentMention({ id: "3", source: "upload", name: "a.png", status: "ready", path: "/u/a.png", mimeType: "image/png" }),
    { type: "image", path: "/u/a.png", mimeType: "image/png", name: "a.png" },
  );
  assert.deepEqual(
    attachmentMention({ id: "4", source: "local", name: "r.pdf", status: "ready", path: "/abs/r.pdf" }),
    { type: "file", path: "/abs/r.pdf", name: "r.pdf" },
    "无 mimeType 的 local 附件按 file mention 发送",
  );
});

// --- extraMentions 合并：@ 引用在前、附件在后，按 path 去重 ---
await t("发送帧：@ 引用与 extraMentions 合并、按 path 去重", async () => {
  const session = makeSession("s-att-merge");
  stubFetch(session, { knownFiles: ["a.ts"] });
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };

  const ok = await s.sendComposerInput(session.id, "看看 @a.ts", [
    imageMention("/home/u/.workbench/uploads/s/1.png"),
    fileMention("a.ts"), // 与 @a.ts 同路径：应被去重
    fileMention("/abs/report.pdf", "report.pdf"),
  ]);
  assert.equal(ok, true, "OPEN 下应发送成功");
  const frame = sent.find((f) => f.type === "user_message");
  assert.ok(frame, "上行帧未写出");
  assert.equal(frame.text, "看看 @a.ts", "文本应原样发送");
  assert.deepEqual(frame.mentions, [
    { type: "file", path: "a.ts" },
    { type: "image", path: "/home/u/.workbench/uploads/s/1.png", mimeType: "image/png", name: "p.png" },
    { type: "file", path: "/abs/report.pdf", name: "report.pdf" },
  ], "mentions 应为 @ 引用在前、附件在后、同路径去重");
});

// --- 20 条截断 ---
await t(`发送帧：附件超出 ${MAX_MENTIONS} 条上限时截断`, async () => {
  const session = makeSession("s-att-cap");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };

  const extras = Array.from({ length: 25 }, (_, i) => fileMention(`/abs/f${i}.txt`, `f${i}.txt`));
  const ok = await s.sendComposerInput(session.id, "批量附件", extras);
  assert.equal(ok, true);
  const frame = sent.find((f) => f.type === "user_message");
  assert.equal(frame.mentions.length, MAX_MENTIONS, `mentions 应截到 ${MAX_MENTIONS} 条`);
  assert.equal(frame.mentions[0].path, "/abs/f0.txt", "截断应保留前 N 条（顺序不动）");
  assert.equal(frame.mentions.at(-1).path, "/abs/f19.txt");
});

// --- extraMentions 与命令分支互斥 ---
await t("带附件时命中命令形态也按文本+mentions 发（不走结构化 command）", async () => {
  const session = makeSession("s-att-cmd");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: true, mentions: true } } };
  s.commands.set(session.id, [{ name: "help", description: "", source: "kimi" }]);

  const ok = await s.sendComposerInput(session.id, "/help", [fileMention("/abs/note.md", "note.md")]);
  assert.equal(ok, true);
  const frame = sent.find((f) => f.type === "user_message");
  assert.ok(frame, "上行帧未写出");
  assert.equal(frame.text, "/help", "文本应原样发送");
  assert.equal(frame.command, undefined, "带附件时不应拼结构化 command");
  assert.deepEqual(frame.mentions, [{ type: "file", path: "/abs/note.md", name: "note.md" }]);
});

// --- 失败语义：socket 非 OPEN 返回 false、不上行、置 lastError ---
await t("socket 非 OPEN：带附件发送返回 false 且零上行帧", async () => {
  const session = makeSession("s-att-off");
  stubFetch(session);
  const s = new Store();
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
  s.socket = { readyState: 3, send() { throw new Error("不应触达"); } };
  s.lastError = null;

  const ok = await s.sendComposerInput(session.id, "带附件", [imageMention("/u/1.png")]);
  assert.equal(ok, false, "非 OPEN 应返回 false（UI 据此保留附件条）");
  assert.ok(s.lastError, "失败后未置 lastError 提示");
});

// --- 无 mentions 能力位时 extraMentions 仍透出（UI 不会到此，但不静默吞掉用户附件） ---
await t("mentions 能力位 false：不解析 @，extraMentions 截断后随文本上行", async () => {
  const session = makeSession("s-att-nocap");
  stubFetch(session, { knownFiles: ["a.ts"] });
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };

  const ok = await s.sendComposerInput(session.id, "看看 @a.ts", [fileMention("/abs/x.txt", "x.txt")]);
  assert.equal(ok, true);
  const frame = sent.find((f) => f.type === "user_message");
  assert.deepEqual(frame.mentions, [{ type: "file", path: "/abs/x.txt", name: "x.txt" }],
    "能力位 false 时不做 @ 解析，附件 mention 原样带上");
});

// --- K12：发送成功只清本次提交的附件（组件源码断言，同 effective-ask-flow 的打法） ---
// 背景缺陷：附件还在上传时发送，Composer 在成功后 setAttachments([]) 把上传中的也一起清掉。
await t("Composer 发送成功不得整栏清空附件条：只移除本次提交的附件 id", async () => {
  const source = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("setAttachments([])"), "发送成功后不得 setAttachments([]) 整栏清空");
  assert.ok(source.includes("submittedIds"), "应按本次提交的附件 id（submittedIds）过滤移除");
});

if (!process.exitCode) console.log(`✅ attach 流程回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
// store 内部有 2s 防抖计时器，直接退出不等它
process.exit(process.exitCode ?? 0);
