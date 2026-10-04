// 组织信息独立于会话 seq 和活动时间；不用真实网络或端口。
import { strict as assert } from "node:assert";
import { Store } from "../src/store.ts";
import { sessionTitle, truncateDisplayWidth } from "../../shared/session-title.ts";
const session = (overrides = {}) => ({ id: "organized", agent: "claude", cwd: "/repo", status: "idle", config: {}, seq: 0,
  createdAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-01T00:00:00Z", title: "自动标题", ...overrides });
const group = { id: "group-one", name: "论文", createdAt: "2026-10-03T00:00:00Z" };
const response = (data) => ({ json: async () => ({ code: 0, msg: "", data, request_id: "organization-test" }) });
let passed = 0;
async function check(name, fn) {
  const savedFetch = globalThis.fetch;
  try { await fn(); passed++; }
  catch (error) { console.error(`❌ ${name}\n   ${error.stack}`); process.exitCode = 1; }
  finally { globalThis.fetch = savedFetch; }
}
await check("自定义标题优先；清空恢复自动标题与事件回退", () => {
  assert.equal(sessionTitle({ title: "自动", customTitle: "用户标题" }), "用户标题");
  assert.equal(sessionTitle({ title: "自动", customTitle: "" }), "自动");
  assert.equal(sessionTitle({ customTitle: "   " }, [{ type: "user_message", payload: { text: "原始消息" } }]), "原始消息");
});
await check("自动标题保留完整文字，已有首条消息时补全旧截断标题", () => {
  const full = "拉宽侧栏后要显示更多完整会话标题内容和后面的详细信息";
  const events = [{ type: "user_message", payload: { text: `  ${full}\n后续内容  ` } }];
  const normalized = `${full} 后续内容`;
  assert.equal(sessionTitle({}, events), normalized);
  const old = truncateDisplayWidth(normalized, 30);
  assert.equal(sessionTitle({ title: old }, events), normalized);
  assert.equal(sessionTitle({ title: old }), old, "没有原始消息时不猜测缺失标题");
  assert.equal(sessionTitle({ title: "服务端权威标题" }, events), "服务端权威标题");
  assert.equal(sessionTitle({ title: old, customTitle: "自定义标题" }, events), "自定义标题");
  assert.equal(sessionTitle({}, [{ type: "user_message", payload: { text: "a".repeat(120) } }]), "a".repeat(120));
});
await check("首条结构化命令派生标题，显式与自定义标题仍优先", () => {
  const events = [{ type: "user_message", payload: { command: { name: "review", arguments: " 长参数\n第二行 " } } }];
  assert.equal(sessionTitle({}, events), "/review 长参数 第二行");
  assert.equal(sessionTitle({}, [{ type: "user_message", payload: { command: { name: "compact" } } }]), "/compact");
  assert.equal(sessionTitle({ title: "保留标题" }, events), "保留标题");
  assert.equal(sessionTitle({ customTitle: "手工标题" }, events), "手工标题");
  assert.equal(sessionTitle({}, [{ type: "user_message", payload: { text: "普通文字", command: { name: "review" } } }]), "普通文字");
});
await check("组织广播更新其他页面；不覆盖较新的运行状态与 seq", () => {
  const value = new Store(); value.sessions = [session({ seq: 8, status: "running" })];
  value.handleFrame({ type: "session_organization_updated", sessions: [session({ seq: 4, customTitle: "新标题", pinned: true, groupId: group.id })], groups: [group] });
  assert.deepEqual(value.sessionGroups, [group]);
  assert.equal(value.session("organized").customTitle, "新标题");
  assert.equal(value.session("organized").pinned, true);
  assert.equal(value.session("organized").status, "running");
  assert.equal(value.session("organized").seq, 8);
  value.handleFrame({ type: "session_organization_updated", sessions: [session()], groups: [] });
  assert.equal(value.session("organized").groupId, undefined);
  assert.equal(value.session("organized").customTitle, undefined);
  assert.deepEqual(value.sessionGroups, []);
});
await check("在途旧 REST 列表不能撤销刚收到的置顶与重命名", async () => {
  const value = new Store(); value.sessions = [session()];
  let resolve;
  globalThis.fetch = () => new Promise((done) => { resolve = done; });
  const pending = value.refreshSessions();
  value.handleFrame({ type: "session_organization_updated", sessions: [session({ customTitle: "刚改名", pinned: true })], groups: [group] });
  resolve(response({ sessions: [session()] })); await pending;
  assert.equal(value.session("organized").customTitle, "刚改名");
  assert.equal(value.session("organized").pinned, true);
});
await check("PATCH 保存组织字段；空串响应恢复自动标题", async () => {
  const value = new Store(); value.sessions = [session()]; const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push([path, init?.method, JSON.parse(init.body)]);
    return response({ session: session(init.body.includes('"customTitle":""') ? {} : { customTitle: "手动" }) });
  };
  await value.patchSession("organized", { customTitle: "手动" });
  assert.equal(sessionTitle(value.session("organized")), "手动");
  await value.patchSession("organized", { customTitle: "" });
  assert.equal(sessionTitle(value.session("organized")), "自动标题");
  assert.deepEqual(calls, [["/api/sessions/organized", "PATCH", { customTitle: "手动" }], ["/api/sessions/organized", "PATCH", { customTitle: "" }]]);
});
await check("分组创建、重命名和删除读回；删除成员回普通列表", async () => {
  const value = new Store(); value.sessions = [session({ groupId: group.id })];
  globalThis.fetch = async (_path, init) => response(init.method === "POST" ? { group }
    : init.method === "PATCH" ? { group: { ...group, name: "新名字" } } : { groups: [] });
  assert.deepEqual(await value.createSessionGroup("论文"), group);
  assert.deepEqual(value.sessionGroups, [group]);
  await value.renameSessionGroup(group.id, "新名字");
  assert.equal(value.sessionGroups[0].name, "新名字");
  await value.deleteSessionGroup(group.id);
  assert.deepEqual(value.sessionGroups, []);
  assert.equal(value.session("organized").groupId, undefined);
});
console.log(`✅ 会话组织同步与标题：${passed} 项`);
