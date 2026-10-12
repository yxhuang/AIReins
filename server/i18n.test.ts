import assert from "node:assert/strict";
import { describeServerMessage, fallbackTitleMetadata, localizeContentError, withMessageMetadata } from "./i18n/messages.js";
import zh from "../frontend/src/i18n/server.zh-CN.js";
import en from "../frontend/src/i18n/server.en.js";

assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
for (const [key, message] of Object.entries(zh)) {
  const params = [...message.matchAll(/\{(p\d+)\}/g)].map(match => match[1]);
  assert.deepEqual([...en[key].matchAll(/\{(p\d+)\}/g)].map(match => match[1]).sort(), params.sort(), key);
  const sample = message.replaceAll("{product}", "Workbench").replace(/\{p\d+\}/g, "parameter");
  assert.ok(describeServerMessage(sample), key);
  assert.ok(en[key].trim());
  assert.equal(/[\u3400-\u9fff]/.test(en[key]), false, key);
}
assert.deepEqual(describeServerMessage("会话不存在：/tmp/中文目录"), { key: "server.message167", params: { p0: "/tmp/中文目录" } });
assert.equal(describeServerMessage("Unknown CLI failure"), undefined);
assert.deepEqual(describeServerMessage("Kimi 的 2 条排队消息已取消：worker 已停止"), {
  key: "server.message146", params: { p0: "2", p1: "worker 已停止" }, localizedParams: { p1: { key: "server.message155" } },
});
assert.equal(describeServerMessage("Codex 提问缺少答案：会话不存在")?.localizedParams, undefined);
const source = { code: 40401, msg: "会话不存在：abc", data: { events: [
  { type: "session_error", payload: { message: "会话不存在：abc" } },
  { type: "user_message", payload: { text: "会话不存在", message: "会话不存在" } },
  { type: "tool_call_completed", payload: { output: { message: "会话不存在" } } },
], session: { snapshotState: { configSwitching: "正在切换模型…" } } }, request_id: "r1" };
const wire = withMessageMetadata(source) as any;
assert.equal(wire.code, source.code);
assert.equal(wire.msg, source.msg);
assert.equal(wire.request_id, source.request_id);
assert.equal(wire.i18n.msg.key, "server.message167");
assert.equal(wire.data.events[0].payload.i18n.message.key, "server.message167");
assert.equal(wire.data.events[1], source.data.events[1]);
assert.equal(wire.data.events[2], source.data.events[2]);
assert.equal(wire.data.session.snapshotState.i18n.configSwitching.key, "server.message387");
assert.equal((source as any).i18n, undefined);
const schema = withMessageMetadata({ options: [{ id: "model", name: "模型", values: [{ value: null, label: "跟随 Codex 配置" }] }] }) as any;
assert.equal(schema.options[0].i18n.name.key, "server.message063");
assert.equal(schema.options[0].values[0].i18n.label.key, "server.message092");
assert.equal((withMessageMetadata({ name: "模型", description: "会话不存在" }) as any).i18n, undefined);
assert.equal((withMessageMetadata({ embedReason: "目标站点设置了 X-Frame-Options: DENY" }) as any).i18n.embedReason.key, "server.message283");
assert.equal((withMessageMetadata({ source: "userSettings", label: "用户设置" }) as any).i18n.label.key, "server.message408");
assert.equal(describeServerMessage("文件超过 32 MiB，无法通过工作台下载或查看")?.key, "server.message483");
assert.equal(describeServerMessage("经 workbench 反向代理，与工作台同源")?.key, "server.message284");
const permission = withMessageMetadata({ type: "permission_request", payload: { questions: [{ question: "会话不存在" }], protocolLimitations: ["isOther=false 时不接受自由文本", "Native text"] } }) as any;
assert.deepEqual(permission.payload.i18n.protocolLimitations, [{ key: "server.message120" }, null]);
assert.deepEqual(fallbackTitleMetadata({}, undefined), { i18n: { title: { key: "server.message316" } } });
assert.deepEqual(fallbackTitleMetadata({ customTitle: "新会话" }, undefined), {});
assert.deepEqual(fallbackTitleMetadata({}, "新会话"), {});
const contentError = withMessageMetadata({ code: 40490, msg: "文件或目录不存在", data: {}, request_id: "r1" }) as Record<string, unknown>;
assert.equal(localizeContentError(contentError, "en").msg, "File or directory does not exist");
assert.equal(localizeContentError(contentError, undefined), contentError);
assert.equal(localizeContentError(contentError, "zh-CN"), contentError);
assert.equal(localizeContentError(contentError, "invalid"), contentError);
assert.equal(localizeContentError(contentError, "en").code, 40490);
assert.equal(localizeContentError(contentError, "en").i18n, contentError.i18n);
const nestedError = withMessageMetadata({ code: 50090, msg: "打包文件夹失败：文件或目录不存在" }) as Record<string, unknown>;
assert.equal(localizeContentError(nestedError, "en").msg, "Folder packaging failed: File or directory does not exist");
console.log(`server i18n OK (${Object.keys(zh).length} templates)`);
