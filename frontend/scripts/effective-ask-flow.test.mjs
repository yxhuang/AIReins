#!/usr/bin/env node
// M16 打桩回归：claude effective* 实际生效值显示 + AskUserQuestion 提问选择卡片。
// 覆盖：
//  1. effectiveFor：model/effort 有效值与来源读取；无值/permissionMode 为 null（codex/kimi 不受影响）；
//  2. store applyConfigUpdated 吸收 effectiveModel/effectiveEffort/两个 source（config 回写之外）；
//  3. normalizeQuestions：header/question/options/description 齐全、单选多选、无效条目过滤；
//  4. gateFromEvent 识别 interactionType 并提取 questions；非提问 permission_request 不受影响；
//  5. toggleOption / allAnswered / buildQuestionAnswers：key 逐字 = question（不用 header）、
//     多选合并为逗号分隔的一个字符串、按选项顺序；
//  5b. 「其他…」自由文本（P1-5）：与选项互斥、未填文本不算已回答、答案取输入文本（trim）；
//  6. permission_resolved 广播带回的 questionAnswers 落到闸门视图（「已选择：…」降级态数据源）；
//  7. store.resolvePermission 带 questionAnswers 上行（与 updatedInput 互斥——调用方保证，帧不含它）；
//  8. 源码接线：SessionView 提问走 QuestionBlock 且共用 pendingGates 贴条、有效值显示形态、
//     QuestionBlock 的跳过出口/提交按钮/逗号合并。
// 浏览器依赖（WebSocket / fetch）全部打桩，不需要真实 server。运行：npm run test:effective-ask
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { Store } = await import("../src/store.ts");
const { gateFromEvent, buildRenderItems } = await import("../src/render-items.ts");
const { normalizeQuestions, toggleOption, toggleOther, setOtherText, clearOther, hasOther, allAnswered, buildQuestionAnswers } = await import("../src/ask.ts");
const { effectiveFor, EFFECTIVE_SOURCE_LABELS, ALIAS_NOTE } = await import("../src/config-view.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

function makeSession(id, over = {}) {
  const now = new Date().toISOString();
  return {
    id, agent: "claude", agentId: `${id}-agent`, cwd: "/tmp", status: "idle",
    createdAt: now, lastActivityAt: now, seq: 0, transcriptPath: `/tmp/${id}.jsonl`,
    nativeSessionId: `native-${id}`, processId: 1234,
    config: { model: null, effort: null, permissionMode: "manual" }, riskyMode: false,
    ...over,
  };
}

function makeEvent(sessionId, seq, type, payload = {}) {
  return { type, sessionId, agentId: `${sessionId}-agent`, seq, timestamp: new Date().toISOString(), payload };
}

const envelope = (data) => ({ json: async () => ({ code: 0, msg: "", data, request_id: "t" }) });

function fakeSocket(sent) {
  return { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
}

function stubFetch(session, snapshotEvents = []) {
  globalThis.fetch = (path) => {
    path = String(path);
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot?tail=1")) {
      return Promise.resolve(envelope({ session, seq: snapshotEvents.length, events: snapshotEvents }));
    }
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

// ============ 需求 1：effective* 实际生效值 ============

// --- 验收 1 打桩侧：effectiveFor 读取有效值与来源 ---
await t("effectiveFor：model/effort 有效值与来源；无值与 permissionMode 返回 null", async () => {
  const session = {
    effectiveModel: "opus", effectiveModelSource: "settings",
    effectiveEffort: "high", effectiveEffortSource: "settings",
  };
  assert.deepEqual(effectiveFor(session, "model"), { value: "opus", source: "settings" });
  assert.deepEqual(effectiveFor(session, "effort"), { value: "high", source: "settings" });
  assert.equal(effectiveFor(session, "permissionMode"), null, "permissionMode 没有 effective 字段");
  // codex/kimi 常态：字段缺省 → null（不显示，不显示成异常）
  assert.equal(effectiveFor({}, "model"), null);
  assert.equal(effectiveFor({}, "effort"), null);
  // 有效值为 null 时 source 也是 null → 不显示
  assert.equal(
    effectiveFor({ effectiveModel: null, effectiveModelSource: null }, "model"),
    null,
  );
  // init 升级的精确 id
  assert.deepEqual(
    effectiveFor({ effectiveModel: "claude-opus-5", effectiveModelSource: "init" }, "model"),
    { value: "claude-opus-5", source: "init" },
  );
  assert.equal(EFFECTIVE_SOURCE_LABELS.settings, "设置");
  assert.equal(EFFECTIVE_SOURCE_LABELS.init, "运行时");
  assert.equal(EFFECTIVE_SOURCE_LABELS.session, "会话");
  assert.ok(ALIAS_NOTE.includes("别名"), "别名说明文案缺失");
});

// --- 验收 1 打桩侧：config_updated 吸收 effective* ---
await t("applyConfigUpdated：config 回写之外一并吸收 effectiveModel/effectiveEffort 与两个 source", async () => {
  const session = makeSession("s-eff-1", {
    effectiveModel: "opus", effectiveModelSource: "settings",
    effectiveEffort: "high", effectiveEffortSource: "settings",
  });
  stubFetch(session);
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  await s.ensureLoaded(session.id);

  // 首轮 init 精度提升的广播（server/README §config_updated 形状）
  s.handleFrame(makeEvent(session.id, 1, "config_updated", {
    config: { model: null, effort: null, permissionMode: "manual" },
    model: "claude-opus-5",
    effort: null,
    permissionMode: "manual",
    riskyMode: false,
    effectiveModel: "claude-opus-5",
    effectiveEffort: "high",
    effectiveModelSource: "init",
    effectiveEffortSource: "settings",
    effectiveFrom: "current_turn",
    reportedBy: "system/init",
  }));
  const updated = s.session(session.id);
  assert.equal(updated.effectiveModel, "claude-opus-5", "effectiveModel 未吸收");
  assert.equal(updated.effectiveModelSource, "init", "effectiveModelSource 未升级为 init");
  assert.equal(updated.effectiveEffort, "high");
  assert.equal(updated.effectiveEffortSource, "settings");
  assert.equal(updated.config.model, null, "config.model 语义不能改：null = 未被会话级覆盖");
});

// --- 验收 2：codex/kimi 不受影响 ---
await t("codex 会话的 config_updated 不带 effective*：session 字段保持缺省，不显示成异常", async () => {
  const session = makeSession("s-eff-2", { agent: "codex", config: { model: "gpt-5.4", effort: "low", permissionMode: "on-request" } });
  stubFetch(session);
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  await s.ensureLoaded(session.id);
  s.handleFrame(makeEvent(session.id, 1, "config_updated", {
    config: { model: "gpt-5.4", effort: "low", permissionMode: "on-request" },
    model: "gpt-5.4", effort: "low", permissionMode: "on-request",
    riskyMode: false, effectiveFrom: "next_turn",
  }));
  const updated = s.session(session.id);
  assert.equal(updated.effectiveModel, undefined, "codex 不应被写入 effectiveModel");
  assert.equal(updated.effectiveModelSource, undefined);
  assert.equal(effectiveFor(updated, "model"), null, "codex effectiveFor 应为 null（不追加显示）");
  assert.equal(updated.config.model, "gpt-5.4");
});

// --- 验收 1/5 打桩侧：SessionView 有效值显示接线 ---
await t("源码接线：跟随配置时下拉并入实际值 + 极小字来源标注；会话头摘要并入有效值", async () => {
  const source = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("effectiveFor(session, option.id)"), "ConfigControls 未用 effectiveFor");
  assert.ok(
    source.includes("`${followLabel}（${effective.value}）`"),
    "跟随配置项未并入实际值（应显示「跟随 Claude 配置（claude-opus-5）」形态）",
  );
  assert.ok(source.includes("config-effective-src"), "来源极小字标注缺失");
  assert.ok(source.includes("EFFECTIVE_SOURCE_LABELS[effective.source]"), "来源标签未接线");
  assert.ok(source.includes("ALIAS_NOTE"), "别名说明未接线");
  // 有效值为 null 时仍只显示 followLabel，不编造
  assert.ok(
    source.includes("effective ? `${followLabel}（${effective.value}）` : followLabel"),
    "有效值为 null 时必须回落 followLabel",
  );
  // 会话头摘要同样并入（且不再用旧的 session.model 特判）
  assert.ok(!source.includes('option.id === "model" && session.model'), "旧的 model 特判应被 effectiveFor 取代");
});

// ============ 需求 2：AskUserQuestion 提问选择卡片 ============

const ASK_PAYLOAD = {
  requestId: "req-ask-1",
  gate: "control_request",
  toolName: "AskUserQuestion",
  interactionType: "ask_user_question",
  questionProtocol: "claude_updated_input_answers_v1",
  input: { questions: [] },
  questions: [
    {
      question: "早餐吃粥还是吃面？",
      header: "早餐选择",
      options: [
        { label: "吃粥", description: "温和清淡，容易消化" },
        { label: "吃面", description: "饱腹有劲，顶饿" },
      ],
      multiSelect: false,
    },
    {
      question: "配菜要哪些？",
      options: [
        { label: "咸菜" },
        { label: "煎蛋", description: "现煎" },
        { label: "豆浆" },
      ],
      multiSelect: true,
    },
  ],
};

// --- 验收 3 打桩侧：normalizeQuestions 字段齐全 + 无效过滤 ---
await t("normalizeQuestions：header/question/options/description/multiSelect 齐全；无效条目过滤", async () => {
  const qs = normalizeQuestions(ASK_PAYLOAD.questions);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].question, "早餐吃粥还是吃面？");
  assert.equal(qs[0].header, "早餐选择");
  assert.deepEqual(qs[0].options[0], { label: "吃粥", description: "温和清淡，容易消化" });
  assert.equal(qs[0].multiSelect, false);
  assert.equal(qs[1].multiSelect, true);
  assert.equal(qs[1].header, undefined, "无 header 不伪造");
  assert.equal(qs[1].options[0].description, undefined, "无 description 不伪造");
  // 无效条目：空 question / 空 options / 非数组整体
  assert.equal(normalizeQuestions([{ question: "", options: [{ label: "x" }] }]).length, 0);
  assert.equal(normalizeQuestions([{ question: "q", options: [] }]).length, 0);
  assert.equal(normalizeQuestions([{ question: "q", options: [{ label: "" }] }]).length, 0);
  assert.equal(normalizeQuestions("nope").length, 0);
  assert.equal(normalizeQuestions(undefined).length, 0);
});

// --- 验收 3 打桩侧：gateFromEvent 识别 interactionType；非提问不受影响 ---
await t("gateFromEvent：interactionType=ask_user_question 提取 questions；普通闸门不带", async () => {
  const event = makeEvent("s1", 7, "permission_request", ASK_PAYLOAD);
  const view = gateFromEvent(event, "claude");
  assert.equal(view.questions?.length, 2, "questions 未提取");
  assert.equal(view.requestId, "req-ask-1");

  const plain = gateFromEvent(
    makeEvent("s1", 8, "permission_request", { requestId: "r2", toolName: "Bash", input: { command: "ls" } }),
    "claude",
  );
  assert.equal(plain.questions, undefined, "普通审批不应带 questions");
  // interactionType 标记但 questions 归一为空 → 回退普通审批卡片
  const broken = gateFromEvent(
    makeEvent("s1", 9, "permission_request", { requestId: "r3", interactionType: "ask_user_question", questions: [] }),
    "claude",
  );
  assert.equal(broken.questions, undefined, "空 questions 应回退普通卡片");
});

// --- 验收 3 打桩侧：单选/多选选择逻辑 + 答案合成 ---
await t("toggleOption/allAnswered/buildQuestionAnswers：单选替换、多选 toggle、key 逐字 = question、多选逗号合并", async () => {
  const qs = normalizeQuestions(ASK_PAYLOAD.questions);
  let sel = {};
  assert.equal(allAnswered(qs, sel), false, "未答完不可提交");

  sel = toggleOption(sel, qs[0], "吃粥");
  assert.deepEqual(sel[qs[0].question], ["吃粥"]);
  sel = toggleOption(sel, qs[0], "吃面"); // 单选替换
  assert.deepEqual(sel[qs[0].question], ["吃面"], "单选应替换而非累加");
  assert.equal(allAnswered(qs, sel), false, "第二题未答");

  sel = toggleOption(sel, qs[1], "豆浆");
  sel = toggleOption(sel, qs[1], "咸菜"); // 多选累加
  assert.deepEqual(sel[qs[1].question], ["豆浆", "咸菜"]);
  sel = toggleOption(sel, qs[1], "豆浆"); // 多选 toggle 取消
  assert.deepEqual(sel[qs[1].question], ["咸菜"]);
  assert.equal(allAnswered(qs, sel), true);

  const answers = buildQuestionAnswers(qs, sel);
  // key 逐字 = question 原文，不是 header
  assert.ok(!("早餐选择" in answers), "key 不能用 header");
  assert.equal(answers["早餐吃粥还是吃面？"], "吃面");
  // 多选合并为逗号分隔的一个字符串，按选项出现顺序（咸菜在选项列表里先于已选的咸菜…按 options 序）
  sel = toggleOption(sel, qs[1], "煎蛋");
  const multi = buildQuestionAnswers(qs, sel);
  assert.equal(multi["配菜要哪些？"], "咸菜,煎蛋", "多选应按选项顺序逗号合并");
});

// --- 验收 5b 打桩侧：「其他…」自由文本（P1-5）---
await t("toggleOther/setOtherText/clearOther：与选项互斥、空文本不算已回答、答案取输入文本", async () => {
  const qs = normalizeQuestions(ASK_PAYLOAD.questions);
  let sel = {};
  let other = {};

  // 选中「其他」：清空该题已选选项（互斥，单选语义）
  sel = toggleOption(sel, qs[0], "吃粥");
  ({ selection: sel, other } = toggleOther(sel, other, qs[0]));
  assert.deepEqual(sel[qs[0].question], [], "选中「其他」应清空已选选项");
  assert.ok(hasOther(other, qs[0]), "「其他」应处于选中态");
  assert.equal(allAnswered(qs, sel, other), false, "「其他」未填文本不算已回答（不能提交）");

  other = setOtherText(other, qs[0], "   ");
  assert.equal(allAnswered(qs, sel, other), false, "纯空白文本不算已回答");

  other = setOtherText(other, qs[0], "都不吃，喝咖啡");
  sel = toggleOption(sel, qs[1], "咸菜");
  assert.equal(allAnswered(qs, sel, other), true);

  const answers = buildQuestionAnswers(qs, sel, other);
  assert.ok(!("早餐选择" in answers), "key 不能用 header");
  assert.equal(answers["早餐吃粥还是吃面？"], "都不吃，喝咖啡", "选中「其他」的题答案取输入文本");
  assert.equal(answers["配菜要哪些？"], "咸菜", "其余题不受影响");

  // 反向互斥：「其他」激活时点选项 → 该题「其他」被取消
  sel = toggleOption(sel, qs[0], "吃面");
  other = clearOther(other, qs[0]);
  assert.ok(!hasOther(other, qs[0]), "点选项后「其他」应被取消");
  const back = buildQuestionAnswers(qs, sel, other);
  assert.equal(back["早餐吃粥还是吃面？"], "吃面", "取消「其他」后答案回落到选项");

  // 再点一次「其他…」= 取消：键删除，该题回到未答
  ({ selection: sel, other } = toggleOther(sel, other, qs[0]));
  assert.deepEqual(sel[qs[0].question], []);
  ({ selection: sel, other } = toggleOther(sel, other, qs[0]));
  assert.ok(!hasOther(other, qs[0]), "取消后「其他」键应删除");
  assert.equal(allAnswered(qs, sel, other), false, "取消「其他」且未选选项时该题未答");

  // 未选中「其他」时 setOtherText 不生效（返回原对象）
  assert.equal(setOtherText(other, qs[0], "x"), other, "未选中「其他」时 setOtherText 原样返回");
  assert.equal(clearOther(other, qs[0]), other, "未选中「其他」时 clearOther 原样返回");

  // 多选题的「其他」同样互斥，且答案不逗号合并、直接取文本
  sel = toggleOption(sel, qs[1], "豆浆"); // 配菜：咸菜 + 豆浆
  ({ selection: sel, other } = toggleOther(sel, other, qs[1]));
  assert.deepEqual(sel[qs[1].question], [], "多选题选中「其他」也清空全部已选");
  other = setOtherText(other, qs[1], "自带");
  const multiOther = buildQuestionAnswers(qs, sel, other);
  assert.equal(multiOther["配菜要哪些？"], "自带", "多选题的「其他」直接取文本，不逗号合并");

  // 输入文本去首尾空白后回传
  const trimmed = buildQuestionAnswers(qs, {}, { [qs[0].question]: "  随便  " });
  assert.equal(trimmed["早餐吃粥还是吃面？"], "随便", "答案文本应 trim");
});

// --- 验收 3/6 打桩侧：resolved 广播的 questionAnswers 落到视图（已选择降级态数据源） ---
await t("buildRenderItems：permission_resolved 带回的 questionAnswers 落到闸门视图", async () => {
  const items = buildRenderItems([
    makeEvent("s1", 1, "permission_request", ASK_PAYLOAD),
    makeEvent("s1", 2, "permission_resolved", {
      requestId: "req-ask-1",
      decision: "allow",
      questionAnswers: { "早餐吃粥还是吃面？": "吃面", "配菜要哪些？": "咸菜,煎蛋" },
    }),
  ], "claude");
  assert.equal(items.length, 1);
  const gate = items[0];
  assert.equal(gate.kind, "gate");
  assert.equal(gate.decision, "allow");
  assert.deepEqual(gate.questionAnswers, { "早餐吃粥还是吃面？": "吃面", "配菜要哪些？": "咸菜,煎蛋" });
  assert.equal(gate.questions?.length, 2);
});

// --- 验收 7：store.resolvePermission 带 questionAnswers 上行 ---
await t("resolvePermission：questionAnswers 随帧上行；不带时不出现该键；deny 不带答案", async () => {
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);

  s.resolvePermission("s1", "req-ask-1", "allow", undefined, { "早餐吃粥还是吃面？": "吃面" });
  const frame = sent.at(-1);
  assert.equal(frame.type, "permission_resolved");
  assert.equal(frame.decision, "allow");
  assert.deepEqual(frame.questionAnswers, { "早餐吃粥还是吃面？": "吃面" });
  assert.ok(!("updatedInput" in frame), "questionAnswers 与 updatedInput 不能同发");

  s.resolvePermission("s1", "req-ask-1", "deny");
  const denied = sent.at(-1);
  assert.equal(denied.decision, "deny");
  assert.ok(!("questionAnswers" in denied), "deny 不应带 questionAnswers");

  s.resolvePermission("s1", "r3", "allow");
  assert.ok(!("questionAnswers" in sent.at(-1)), "普通闸门不带 questionAnswers 键");
});

// --- 验收 3/5/6 打桩侧：SessionView / QuestionBlock 源码接线 ---
await t("源码接线：提问走 QuestionBlock 且共用 pendingGates 贴条；选项卡片/跳过出口/逗号合并", async () => {
  const sessionView = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  assert.ok(
    /item\.questions\?\.length \? QuestionBlock : GateBlock/.test(sessionView),
    "SessionView 未按 questions 路由到 QuestionBlock",
  );
  // pendingGates 按 kind==="gate" 计，提问卡片天然覆盖（贴条「N 个闸门等待处理 ↑」）。
  // P0-4 重构后 pendingGates 移入 store（按 permission_request/resolved 事件构建，
  // 提问卡片同为 permission_request，覆盖不变）；SessionView 从 data.pendingGates 取贴条数。
  assert.ok(
    sessionView.includes("data?.pendingGates"),
    "SessionView 未从 store data 取 pendingGates",
  );
  const storeSrc = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.ok(
    storeSrc.includes('event.type === "permission_request"') && storeSrc.includes("pendingGates.set"),
    "store 未按 permission_request 事件构建 pendingGates（贴条覆盖被破坏）",
  );
  // ref 注册在两种卡片上都存在（贴条滚动定位依赖）
  assert.ok(
    /gateRefs\.current\.set\(item\.requestId/.test(sessionView),
    "gateRefs 注册缺失",
  );

  const block = readFileSync(new URL("../src/components/StreamItems.tsx", import.meta.url), "utf8");
  assert.ok(block.includes("QuestionBlock"), "QuestionBlock 缺失");
  assert.ok(block.includes("q.header"), "header 未渲染");
  assert.ok(block.includes("question-option-label"), "选项 label 未加粗渲染");
  assert.ok(block.includes("question-option-desc"), "选项 description 小字缺失");
  assert.ok(block.includes("buildQuestionAnswers(questions, selection, other)"), "提交未走 buildQuestionAnswers（含 other）");
  assert.ok(block.includes("aria-pressed"), "选项按钮缺少 aria-pressed");
  // 跳过出口存在但次要：小字按钮而非 btn-danger
  assert.ok(block.includes("question-skip"), "跳过出口缺失");
  const skipSection = block.slice(block.indexOf("question-skip"));
  assert.ok(!skipSection.slice(0, 400).includes("btn-danger"), "跳过出口不能用 btn-danger 样式");
  // 提问卡片内不出现允许/拒绝二元按钮
  const qStart = block.indexOf("export const QuestionBlock");
  const qEnd = block.indexOf("export function SystemLine");
  const qBody = block.slice(qStart, qEnd);
  assert.ok(!qBody.includes("btn-danger"), "提问卡片不应有拒绝样式按钮");
  assert.ok(qBody.includes("已选择："), "已处理的提问卡片应有「已选择」降级态");
  assert.ok(qBody.includes("已跳过"), "已处理的提问卡片应有「已跳过」降级态");
});

// --- 验收 5b 打桩侧：QuestionBlock「其他…」源码接线（P1-5）---
await t("源码接线：每题选项末尾追加「其他…」按钮，选中展开输入框，提交/闸门带上 other", async () => {
  const block = readFileSync(new URL("../src/components/StreamItems.tsx", import.meta.url), "utf8");
  const qStart = block.indexOf("export const QuestionBlock");
  const qEnd = block.indexOf("export function SystemLine");
  const qBody = block.slice(qStart, qEnd);
  assert.ok(qBody.includes("其他…"), "「其他…」按钮缺失");
  assert.ok(qBody.includes("question-other"), "「其他」按钮/输入区缺少 question-other 类");
  assert.ok(qBody.includes("toggleOther(selection, other, q)"), "「其他…」按钮未走 toggleOther");
  assert.ok(qBody.includes("setOtherText(current, q,"), "输入框未走 setOtherText");
  assert.ok(qBody.includes("clearOther(current, q)"), "点选项未清「其他」（互斥缺失）");
  assert.ok(qBody.includes("config-select"), "「其他」输入区未复用 .config-select 视觉语言");
  assert.ok(qBody.includes("allAnswered(questions, selection, other)"), "提交闸门未带 other（空文本可提交）");
  assert.ok(qBody.includes("buildQuestionAnswers(questions, selection, other)"), "答案合成未带 other");
});

await t("normalizeQuestions：otherSupported 每题优先、事件级兜底，只有明确 false 才标记（claude 缺省仍显示「其他」）", async () => {
  const q = (extra) => ({ question: "选哪个？", options: [{ label: "A" }], ...extra });
  assert.equal(normalizeQuestions([q({})])[0].otherSupported, undefined, "claude 缺省不标记");
  assert.equal(normalizeQuestions([q({})], false)[0].otherSupported, false, "kimi 事件级 false");
  assert.equal(normalizeQuestions([q({ otherSupported: true })], false)[0].otherSupported, undefined, "codex 每题 true 优先于事件级");
  assert.equal(normalizeQuestions([q({ otherSupported: false })])[0].otherSupported, false, "codex 每题 false");
  const block = readFileSync(new URL("../src/components/StreamItems.tsx", import.meta.url), "utf8");
  assert.ok(block.includes("q.otherSupported !== false &&"), "QuestionBlock 未按 otherSupported 隐藏「其他…」");
});

console.log(`✅ effective/ask 前端逻辑回归全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
