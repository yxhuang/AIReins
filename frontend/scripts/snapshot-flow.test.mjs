#!/usr/bin/env node
// 建会话前快照的前端回归测试：分支决策、确认框三出口传参、preflight 失败不阻断、
// preflight/createSession 的线上协议形状。浏览器依赖（fetch）打桩，不需要真实 server；
// 用 tsx 跑：npm run test:snapshot
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { snapshotFlowDecision, snapshotConfirmReasons, createWithSnapshotPreflight } =
  await import("../src/snapshot.ts");
const { fetchSnapshotPreflight, createSession } = await import("../src/api.ts");

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(here, "..", rel), "utf8");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const preflightOf = (over = {}) => ({
  isGit: false,
  needed: true,
  exceeds: false,
  existing: false,
  freeSpaceOk: true,
  snapshotPath: "/home/u/.workbench-snapshots/x",
  ...over,
});

function envelope(data) {
  return { json: async () => ({ code: 0, msg: "", data, request_id: "t" }) };
}

/** 记录一次 create 调用的收集器。 */
function createRecorder(impl = async () => {}) {
  const calls = [];
  return { calls, create: async (snapshot) => { calls.push(snapshot); await impl(); } };
}

// --- 1. 分支决策：git 目录与「未超阈值且空间够」直连建会话，其余弹确认框 ---
await t("snapshotFlowDecision 分支：git 直连 / 小而够直连 / 超阈值弹框 / 空间不足弹框", async () => {
  assert.equal(snapshotFlowDecision(preflightOf({ isGit: true, needed: false, snapshotPath: null })), "proceed");
  assert.equal(snapshotFlowDecision(preflightOf()), "proceed");
  assert.equal(snapshotFlowDecision(preflightOf({ exceeds: true })), "confirm");
  assert.equal(snapshotFlowDecision(preflightOf({ freeSpaceOk: false })), "confirm");
  assert.equal(snapshotFlowDecision(preflightOf({ exceeds: true, freeSpaceOk: false })), "confirm");
});

// --- 2. 确认框原因文案：两个触发条件各自/同时成立 ---
await t("snapshotConfirmReasons：超阈值与空间不足的原因逐条给出", async () => {
  assert.deepEqual(snapshotConfirmReasons(preflightOf({ exceeds: true })).length, 1);
  assert.match(snapshotConfirmReasons(preflightOf({ exceeds: true }))[0], /500MB|20000/);
  assert.match(snapshotConfirmReasons(preflightOf({ freeSpaceOk: false }))[0], /空间/);
  assert.equal(snapshotConfirmReasons(preflightOf({ exceeds: true, freeSpaceOk: false })).length, 2);
  assert.deepEqual(snapshotConfirmReasons(preflightOf()), []);
});

// --- 3. git 目录不弹框直连建会话，且不传 snapshot 字段 ---
await t("git 目录：不弹框，create 不带 snapshot", async () => {
  const { calls, create } = createRecorder();
  let confirmed = 0;
  const created = await createWithSnapshotPreflight("/repo", {
    preflight: async () => preflightOf({ isGit: true, needed: false, snapshotPath: null }),
    create,
    confirm: async () => { confirmed++; return "auto"; },
  });
  assert.equal(created, true);
  assert.deepEqual(calls, [undefined], "git 目录建会话不得携带 snapshot 字段");
  assert.equal(confirmed, 0, "git 目录不得弹确认框");
});

// --- 4. 非 git 但未超阈值且空间够：静默建会话（后端默认 auto），不弹框 ---
await t("小而够的非 git 目录：不弹框，create 不带 snapshot", async () => {
  const { calls, create } = createRecorder();
  let confirmed = 0;
  const created = await createWithSnapshotPreflight("/data", {
    preflight: async () => preflightOf(),
    create,
    confirm: async () => { confirmed++; return "auto"; },
  });
  assert.equal(created, true);
  assert.deepEqual(calls, [undefined]);
  assert.equal(confirmed, 0);
});

// --- 5. 超阈值弹框：「仍然快照」→ create("auto") ---
await t("超阈值弹框，仍然快照 → snapshot:auto", async () => {
  const { calls, create } = createRecorder();
  const seen = [];
  const created = await createWithSnapshotPreflight("/big", {
    preflight: async () => preflightOf({ exceeds: true }),
    create,
    confirm: async (p) => { seen.push(p); return "auto"; },
  });
  assert.equal(created, true);
  assert.deepEqual(calls, ["auto"], "仍然快照必须传 snapshot:auto");
  assert.equal(seen.length, 1, "确认框必须拿到 preflight 结果");
  assert.equal(seen[0].exceeds, true);
});

// --- 6. 超阈值弹框：「跳过快照」→ create("skip") ---
await t("超阈值弹框，跳过快照 → snapshot:skip", async () => {
  const { calls, create } = createRecorder();
  const created = await createWithSnapshotPreflight("/big", {
    preflight: async () => preflightOf({ exceeds: true }),
    create,
    confirm: async () => "skip",
  });
  assert.equal(created, true);
  assert.deepEqual(calls, ["skip"], "跳过快照必须传 snapshot:skip");
});

// --- 7. 空间不足同样弹框；「取消」→ 不建会话，回到原状态 ---
await t("空间不足弹框，取消 → 不建会话", async () => {
  const { calls, create } = createRecorder();
  const created = await createWithSnapshotPreflight("/big", {
    preflight: async () => preflightOf({ freeSpaceOk: false }),
    create,
    confirm: async () => "cancel",
  });
  assert.equal(created, false, "取消必须如实返回「未建会话」");
  assert.deepEqual(calls, [], "取消后绝不允许发起建会话");
});

// --- 8. preflight 失败不阻断：照常建会话（不传 snapshot），记录日志 ---
await t("preflight 失败（网络错误/500/400）：不阻断，直接建会话并记录", async () => {
  for (const failure of [new Error("fetch failed"), new Error("服务器内部错误"), new Error("工作目录无效")]) {
    const { calls, create } = createRecorder();
    const logs = [];
    let confirmed = 0;
    const created = await createWithSnapshotPreflight("/data", {
      preflight: async () => { throw failure; },
      create,
      confirm: async () => { confirmed++; return "auto"; },
      log: (msg) => logs.push(msg),
    });
    assert.equal(created, true, "preflight 失败也必须把会话建起来");
    assert.deepEqual(calls, [undefined], "preflight 失败时不传 snapshot（后端按默认处理）");
    assert.equal(confirmed, 0, "preflight 没结果就没有确认框");
    assert.equal(logs.length, 1, "preflight 失败必须留下记录");
    assert.match(logs[0], /快照预检失败/);
  }
});

// --- 9. preflight 请求形状与信封解析：POST /api/snapshot/preflight 带 {cwd} ---
await t("fetchSnapshotPreflight：POST 带 cwd，信封正常解析；错误信封抛中文 msg", async () => {
  const seen = [];
  globalThis.fetch = (path, init) => {
    seen.push({ path: String(path), init });
    return Promise.resolve(envelope(preflightOf({ exceeds: true })));
  };
  const result = await fetchSnapshotPreflight("/data dir");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/api/snapshot/preflight");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].init.body), { cwd: "/data dir" });
  assert.equal(result.exceeds, true);
  assert.equal(result.snapshotPath, "/home/u/.workbench-snapshots/x");

  globalThis.fetch = () =>
    Promise.resolve({ json: async () => ({ code: 40010, msg: "工作目录无效", data: null, request_id: "t" }) });
  await assert.rejects(() => fetchSnapshotPreflight("/nope"), /工作目录无效/);
});

// --- 10. createSession 透传 snapshot：选了才带，没选不带 ---
await t("createSession：snapshot 显式传入才出现在请求体", async () => {
  const bodies = [];
  const session = {
    id: "s1", agent: "kimi", agentId: "a1", cwd: "/data", status: "starting",
    createdAt: "", lastActivityAt: "", seq: 0, transcriptPath: "/t", config: {}, riskyMode: false,
  };
  globalThis.fetch = (_path, init) => {
    bodies.push(JSON.parse(init.body));
    return Promise.resolve(envelope({ session }));
  };
  await createSession({ agent: "kimi", cwd: "/data", snapshot: "skip" });
  assert.equal(bodies[0].snapshot, "skip");
  await createSession({ agent: "kimi", cwd: "/data", snapshot: "auto" });
  assert.equal(bodies[1].snapshot, "auto");
  await createSession({ agent: "kimi", cwd: "/data" });
  assert.ok(!("snapshot" in bodies[2]), "未选择时不得出现 snapshot 键");
});

// --- 11. 组件接线源码断言（无头环境不起浏览器，UI 渲染见 README 复核记录） ---
await t("接线：新建表单不做快照（P1-8），弹窗组件仍在、会话头不显示快照", async () => {
  const newForm = readSrc("src/components/NewSessionForm.tsx");
  assert.match(newForm, /snapshot:\s*"skip"/, "新建表单必须显式跳过快照");
  assert.doesNotMatch(newForm, /createWithSnapshotPreflight|fetchSnapshotPreflight|<SnapshotConfirm/, "新建表单不得再走预检或弹确认框");

  const dialog = readSrc("src/components/SnapshotConfirm.tsx");
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /e\.key === "Escape"[\s\S]*?onResolve\("cancel"\)/, "Esc 必须取消");
  assert.match(dialog, /"Tab"[\s\S]*?focusables/, "必须有焦点陷阱");
  assert.match(dialog, /disabled=\{!canSnapshot\}/, "空间不足时「仍然快照」必须禁用");
  assert.match(dialog, /onResolve\("auto"\)[\s\S]*?onResolve\("skip"\)[\s\S]*?onResolve\("cancel"\)/, "三个出口齐全");
  assert.match(dialog, /preflight\.existing &&/, "已有旧快照必须告知覆盖刷新");

  // 2026-09-30 会话头精简：第二行只留配置摘要，不再显示快照路径
  const sessionView = readSrc("src/components/SessionView.tsx");
  assert.doesNotMatch(sessionView, /snapshotPath/, "会话头不再显示快照路径");
});

const total = 11;
if (process.exitCode) {
  console.error(`部分用例失败（通过 ${pass} 例）`);
} else {
  console.log(`✅ 快照前端逻辑回归全过（${pass} 例）`);
  assert.equal(pass, total, "用例数与预期不符");
}
