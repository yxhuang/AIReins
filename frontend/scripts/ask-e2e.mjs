#!/usr/bin/env node
// M16 真实闭环实测（需隔离实例已启动，默认 WORKBENCH_PORT=8797）：
//  1. claude 会话 config:{model:"haiku"}：建会话时 effectiveModel="haiku"/source="session"，
//     首轮 init 后升级为精确 id/source="init"（验收 1 的精度变化）；
//     另建一个不带 config 的会话，确认未覆盖时 effective* 来自 settings（别名），不发消息不花额度。
//  2. AskUserQuestion 真实闭环：让模型用提问工具问早餐（选项 ZORP7/QUUX3），
//     前端真实代码路径（gateFromEvent → normalizeQuestions → toggleOption → buildQuestionAnswers）
//     产出 questionAnswers 回传，模型回复须包含所选 label（ZORP7）。
// 完事 DELETE 自建的两个会话。运行：tsx frontend/scripts/ask-e2e.mjs [port]
import { gateFromEvent } from "../src/render-items.ts";
import { normalizeQuestions, toggleOption, buildQuestionAnswers, allAnswered } from "../src/ask.ts";

const port = process.argv[2] ?? "8797";
const base = `http://127.0.0.1:${port}`;
const sandbox = `${process.cwd()}/server/test-sandbox`;

const createdIds = [];
async function cleanup() {
  for (const id of createdIds) {
    await fetch(`${base}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
  }
}
process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

const fail = (msg) => { console.error(`❌ ${msg}`); process.exitCode = 1; };

// --- 会话 A：haiku 覆盖（验收 4 主角，顺带验收 1 的 init 精度升级） ---
const createdA = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agent: "claude",
    cwd: sandbox,
    config: { model: "haiku" },
  }),
}).then((r) => r.json());
if (createdA.code !== 0) throw new Error(createdA.msg);
const sessionA = createdA.data.session;
createdIds.push(sessionA.id);
console.log("A created:", sessionA.id);
console.log("A 建会话时: effectiveModel =", JSON.stringify(sessionA.effectiveModel),
  "| source =", JSON.stringify(sessionA.effectiveModelSource));
if (sessionA.effectiveModel !== "haiku" || sessionA.effectiveModelSource !== "session") {
  fail(`A 建会话时 effective* 不符合预期（haiku/session）`);
}

// --- 会话 B：不传 config（验收 1 未覆盖场景，不发消息不花额度） ---
const createdB = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: "claude", cwd: sandbox }),
}).then((r) => r.json());
if (createdB.code !== 0) throw new Error(createdB.msg);
const sessionB = createdB.data.session;
createdIds.push(sessionB.id);
console.log("B created:", sessionB.id, "（不传 config）");
console.log("B 建会话时: config.model =", JSON.stringify(sessionB.config?.model),
  "| effectiveModel =", JSON.stringify(sessionB.effectiveModel),
  "| source =", JSON.stringify(sessionB.effectiveModelSource),
  "| effectiveEffort =", JSON.stringify(sessionB.effectiveEffort),
  "/", JSON.stringify(sessionB.effectiveEffortSource));
if (sessionB.config?.model !== null) fail("B config.model 应为 null（未覆盖）");
if (sessionB.effectiveModel !== null && sessionB.effectiveModelSource !== "settings") {
  fail(`B 未覆盖时 effectiveModelSource 应为 settings，实际 ${sessionB.effectiveModelSource}`);
}

// --- 会话 A：AskUserQuestion 闭环 ---
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let questionGate = null; // gateFromEvent 产出的真实视图
let agentText = "";
let turnCompleted = false;
let asked = false;

socket.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data));
  if (typeof frame.seq !== "number" || frame.sessionId !== sessionA.id) return;
  if (frame.type === "permission_request" && frame.payload.interactionType === "ask_user_question") {
    // 前端真实代码路径：事件 → 闸门视图 → 归一问题 → 选择 → 合成 questionAnswers
    const view = gateFromEvent(frame, "claude");
    questionGate = view;
    const questions = view.questions ?? [];
    console.log("收到提问事件：interactionType =", frame.payload.interactionType,
      "| 归一后问题数 =", questions.length);
    let selection = {};
    for (const q of questions) {
      const picked = q.options.find((o) => o.label === "ZORP7") ?? q.options[0];
      selection = toggleOption(selection, q, picked.label);
      console.log("  问题:", JSON.stringify(q.question), "| header:", JSON.stringify(q.header),
        "| 选项:", q.options.map((o) => o.label).join("/"), "| 选中:", picked.label);
    }
    if (!allAnswered(questions, selection)) {
      fail("选择未覆盖全部问题");
      return;
    }
    const questionAnswers = buildQuestionAnswers(questions, selection);
    console.log("回传 questionAnswers:", JSON.stringify(questionAnswers));
    socket.send(JSON.stringify({
      type: "permission_resolved",
      sessionId: sessionA.id,
      requestId: frame.payload.requestId,
      decision: "allow",
      questionAnswers,
    }));
    asked = true;
  } else if (frame.type === "permission_request") {
    // 其余闸门自动放行（本场景不应出现）
    socket.send(JSON.stringify({
      type: "permission_resolved", sessionId: sessionA.id,
      requestId: frame.payload.requestId, decision: "allow",
    }));
  }
  if (frame.type === "agent_text_delta") agentText += String(frame.payload.text ?? "");
  if (frame.type === "turn_completed") turnCompleted = true;
});

await new Promise((resolve) => socket.addEventListener("open", resolve));
socket.send(JSON.stringify({
  type: "user_message",
  sessionId: sessionA.id,
  text: "请用 AskUserQuestion 工具问我一个问题：早餐吃什么？选项用 ZORP7 和 QUUX3（description 随意）。得到我的回答后，回复里原样带上我选的那个词。",
}));

const deadline = Date.now() + 120_000;
while (!turnCompleted && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
socket.close();

console.log("提问已回答:", asked, "| turn_completed:", turnCompleted);
console.log("模型回复（截取）:", agentText.slice(0, 300));
if (!asked) fail("未收到 AskUserQuestion 提问事件");
if (!turnCompleted) fail("回合未结束");
if (!agentText.includes("ZORP7")) fail("模型回复未包含所选 label ZORP7");
if (questionGate && !questionGate.questions?.length) fail("gateFromEvent 未提取 questions");

// --- 验收 1：首轮后 GET 会话 A，effectiveModel 升级为精确 id + source=init ---
const detailA = await fetch(`${base}/api/sessions/${sessionA.id}`).then((r) => r.json());
const after = detailA.data.session ?? detailA.data;
console.log("A 首轮后: effectiveModel =", JSON.stringify(after.effectiveModel),
  "| source =", JSON.stringify(after.effectiveModelSource),
  "| config.model =", JSON.stringify(after.config?.model));
if (after.config?.model !== "haiku") fail("config.model 覆盖值不应被 init 改写");
if (after.effectiveModelSource !== "init") fail(`首轮后 source 应升级为 init，实际 ${after.effectiveModelSource}`);
if (typeof after.effectiveModel !== "string" || after.effectiveModel === "haiku") {
  fail(`首轮后 effectiveModel 应为精确 id，实际 ${after.effectiveModel}`);
}

await cleanup();
console.log("已 DELETE 自建会话:", createdIds.join(", "));
console.log(process.exitCode ? "ASK_E2E_FAIL" : "ASK_E2E_OK");
process.exit(process.exitCode ?? 0);
