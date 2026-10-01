import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// 先在纯 Node 环境导入，防止 store 或纯逻辑出现顶层 DOM 依赖。
import { Store, store } from "../src/store.ts";
import { insertFileMention, planFileMention, FilePanel } from "../src/components/FilePanel.tsx";
import { DirectoryBrowser } from "../src/components/DirectoryBrowser.tsx";
import { DispatchPanel } from "../src/components/DispatchPanel.tsx";
import { FILE_WIDTH_OPTIONS } from "../src/components/SidePanelResize.tsx";
import { clampPanelWidth } from "../src/terminal.ts";
import { extractMentionTokens, mentionQueryAt } from "../src/mentions.ts";

const session = { cwd: "/a/b", status: "idle" };
assert.deepEqual(planFileMention(session, true, "/a/b/src/x.ts"), { path: "src/x.ts", reason: null });
assert.equal(planFileMention({ ...session, cwd: "/a/b/" }, true, "/a/b/x.ts").path, "x.ts");
assert.equal(planFileMention({ ...session, cwd: "/" }, true, "/src/x.ts").path, "src/x.ts");
assert.equal(planFileMention({ ...session, cwd: "/mnt/c/Users/u" }, true, "/mnt/c/Users/u/src/x.ts").path, "src/x.ts");
assert.equal(planFileMention(session, true, "/a/b/src/../x.ts").path, "x.ts");
assert.equal(planFileMention({ ...session, cwd: "/a/my repo" }, true, "/a/my repo/x.ts").path, "x.ts");
for (const path of ["/a/bb/x.ts", "/a/x.ts", "/a/b/../x.ts", "/a/b", "x.ts", "/a/b/x\0.ts"]) {
  const plan = planFileMention(session, true, path);
  assert.equal(plan.path, null, path);
  assert.match(plan.reason, /cwd/);
}
for (const whitespace of [" ", "\t", "\n", "\r", "\u00a0", "\u3000"]) {
  const plan = planFileMention(session, true, `/a/b/my${whitespace}file.ts`);
  assert.equal(plan.path, null);
  assert.match(plan.reason, /空白/);
}
assert.match(planFileMention(undefined, true, "/a/b/x.ts").reason, /没有当前会话/);
assert.match(planFileMention({ ...session, status: "dead" }, true, "/a/b/x.ts").reason, /已结束/);
assert.match(planFileMention(session, false, "/a/b/x.ts").reason, /不支持/);
for (const status of ["idle", "running", "starting", "error"]) {
  assert.equal(planFileMention({ ...session, status }, true, "/a/b/x.ts").path, "x.ts");
}

assert.deepEqual(insertFileMention("前后", 1, "src/x.ts"), { text: "前 @src/x.ts 后", cursor: 12 });
assert.deepEqual(insertFileMention("剩余", 0, "x.ts"), { text: "@x.ts 剩余", cursor: 6 });
assert.deepEqual(insertFileMention("", 0, "x.ts"), { text: "@x.ts ", cursor: 6 });
assert.equal(insertFileMention("a", 100, "x.ts").text, "a @x.ts ");
assert.equal(insertFileMention("a", -1, "x.ts").text, "@x.ts a");
for (const preceding of [..."，。、；：！？）》」』,.;:!?)]}\"'`…(@_-", " ", "\t", "\n", "x", "/"]) {
  const before = `查看${preceding}`;
  const next = insertFileMention(`${before}尾文`, before.length, "src/x.ts");
  const query = mentionQueryAt(`${before}@`, before.length + 1);
  const boundary = query?.start === before.length;
  assert.equal(next.text, `${before}${boundary ? "" : " "}@src/x.ts 尾文`, preceding);
  assert.deepEqual(extractMentionTokens(next.text), ["src/x.ts"], preceding);
  assert.equal(next.text.charAt(next.cursor), "尾");
}
let next = insertFileMention("查看", 2, "a.ts");
next = insertFileMention(next.text, next.cursor, "b.ts");
assert.equal(next.text, "查看 @a.ts @b.ts ");

globalThis.React = React;
globalThis.window = { location: { hash: "#/" }, innerWidth: 1280 };
const s = new Store();
s.ensureLoaded = async () => {};
s.navigate("one");
const exclusive = (files, term, dispatch) => {
  assert.deepEqual([s.filesOpen, s.termOpen, s.dispatchesOpen], [files, term, dispatch]);
  assert.equal(s.currentId, "one");
};
s.setFilesOpen(true); exclusive(true, false, false);
s.setTerminalOpen(true); exclusive(false, true, false);
s.setFilesOpen(true); exclusive(true, false, false);
s.toggleDispatches(); exclusive(false, false, true);
s.setFilesOpen(true); exclusive(true, false, false);
assert.equal(window.location.hash, "#/session/one");
s.navigateDispatches(["run"]); exclusive(false, false, true);
s.setTerminalOpen(true); exclusive(false, true, false);
s.closeDispatches = () => { throw new Error("已关闭派单不能再次恢复路由"); };
s.setFilesOpen(true); s.setFilesOpen(false); exclusive(false, false, false);
window.location.hash = "#/dispatches/old-link";
s.onHashChange(); exclusive(false, false, true);

s.requestFileMention("one", "/a/b/x.ts");
const first = s.fileMentionRequest;
s.requestFileMention("one", "/a/b/y.ts");
assert.ok(s.fileMentionRequest.version > first.version);
assert.equal(s.consumeFileMention(first.version), false);
const latest = s.fileMentionRequest.version;
assert.equal(s.consumeFileMention(latest), true);
assert.equal(s.consumeFileMention(latest), false);
s.requestFileMention("one", "/a/b/x.ts");
s.navigate("two");
assert.equal(s.fileMentionRequest, null, "切会话不能留下旧插入请求");

const storage = new Map([["workbench-term-width", "600"]]);
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null };
store.currentId = null;
let fileHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
assert.ok(fileHtml.includes('width:280px'));
assert.ok(fileHtml.includes('aria-valuemin="240"'));
assert.ok(fileHtml.includes('aria-label="文件面板"'));
assert.ok(fileHtml.includes('aria-label="目录与文件列表"'));
assert.ok(fileHtml.includes('title="收起面板"'));
assert.ok(!fileHtml.includes('aria-modal'));
assert.ok(!fileHtml.includes('选定此目录'));
for (const label of ["上一级", "主目录", "Windows"]) assert.ok(fileHtml.includes(label));
storage.set(FILE_WIDTH_OPTIONS.storageKey, "360");
fileHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
assert.ok(fileHtml.includes('width:360px'));
const dispatchHtml = renderToStaticMarkup(React.createElement(DispatchPanel, { onClose() {} }));
assert.ok(dispatchHtml.includes('width:600px'), "派单仍读取原终端 key");
assert.ok(dispatchHtml.includes('panel-icon-button'));
assert.equal(clampPanelWidth(10, 1280, 240, 280), 240);
assert.equal(clampPanelWidth(NaN, 1280, 240, 280), 280);
assert.equal(clampPanelWidth(800, 1000, 240, 280), 520);
assert.equal(clampPanelWidth(280, 320, 240, 280), 240);

for (const mode of ["dir", "file"]) {
  const html = renderToStaticMarkup(React.createElement(DirectoryBrowser, { initialPath: "/a/b", mode, onSelect() {}, onClose() {} }));
  assert.ok(html.includes('aria-modal="true"'));
  assert.equal(html.includes("选定此目录"), mode === "dir");
  assert.equal(html.includes('aria-label="目录与文件列表"'), mode === "file");
}
console.log("✅ file panel：相对路径、边界插入、复制降级判定、三面板互斥、一次性请求与宽度隔离通过");
