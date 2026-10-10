import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// 先在纯 Node 环境导入，防止 store 或纯逻辑出现顶层 DOM 依赖。
import { Store, store } from "../src/store.ts";
import { insertFileMention, planFileMention, FilePanel } from "../src/components/FilePanel.tsx";
import { DirectoryBrowser } from "../src/components/DirectoryBrowser.tsx";
import { directoryBreadcrumbs, directoryEntryDate, directoryEntrySize, normalizeDirectoryPath, recentDirectoryPaths, sortedDirectoryEntries } from "../src/directory-path.ts";
import { DispatchPanel } from "../src/components/DispatchPanel.tsx";
import { FILE_WIDTH_OPTIONS } from "../src/components/SidePanelResize.tsx";
import { clampPanelWidth } from "../src/terminal.ts";
import { extractMentionTokens, mentionQueryAt } from "../src/mentions.ts";

const session = { cwd: "/a/b", status: "idle" };
const sortable = { path: "/a", parent: "/", truncated: false,
  dirs: [{ name: "dir10", path: "/a/dir10", size: null, modifiedAt: 10 }, { name: "dir2", path: "/a/dir2", size: null, modifiedAt: 2 }],
  files: [{ name: "file2", path: "/a/file2", size: 20, modifiedAt: 1 }, { name: "unknown", path: "/a/unknown" },
    { name: "file10", path: "/a/file10", size: 1, modifiedAt: 20 }, { name: "file0", path: "/a/file0", size: 0, modifiedAt: 5 }] };
const originalOrder = JSON.stringify(sortable);
const sortedNames = (key, direction) => sortedDirectoryEntries(sortable, true, { key, direction }).map(entry => entry.name);
assert.deepEqual(sortedNames("name", "asc"), ["dir2", "dir10", "file0", "file2", "file10", "unknown"]);
assert.deepEqual(sortedNames("size", "desc"), ["dir2", "dir10", "file2", "file10", "file0", "unknown"]);
assert.deepEqual(sortedNames("size", "asc"), ["dir2", "dir10", "file0", "file10", "file2", "unknown"]);
assert.deepEqual(sortedNames("modifiedAt", "desc"), ["dir10", "dir2", "file10", "file0", "file2", "unknown"]);
assert.equal(sortedDirectoryEntries(sortable, false, { key: "name", direction: "asc" }).length, 2);
assert.equal(JSON.stringify(sortable), originalOrder, "排序不修改原始接口结果");
assert.equal(directoryEntrySize(0), "0 B");
assert.equal(directoryEntrySize(null), "—");
assert.equal(directoryEntrySize(2048), "2 KB");
assert.equal(directoryEntryDate(undefined), "—");
assert.match(directoryEntryDate(0), /1970/);
assert.deepEqual(directoryBreadcrumbs("/mnt/c/Users/user/中文"), [
  { label: "C:", path: "/mnt/c" }, { label: "Users", path: "/mnt/c/Users" },
  { label: "user", path: "/mnt/c/Users/user" }, { label: "中文", path: "/mnt/c/Users/user/中文" },
]);
assert.deepEqual(directoryBreadcrumbs("/"), [{ label: "/", path: "/" }]);
assert.deepEqual(directoryBreadcrumbs("/home/a").map(crumb => crumb.path), ["/", "/home", "/home/a"]);
assert.deepEqual(recentDirectoryPaths([
  { cwd: "/old", lastActivityAt: "2026-10-01" }, { cwd: "/new", lastActivityAt: "2026-10-04" },
  { cwd: "/new", lastActivityAt: "2026-10-03" }, { cwd: "bad-relative", lastActivityAt: "bad" },
], ["", "/last", String.raw`C:\Projects`]), ["/last", "/mnt/c/Projects", "/new", "/old"]);
for (const [input, expected] of [
  [String.raw`C:\Users\user\Documents\Work\资料\示例项目`, "/mnt/c/Users/user/Documents/Work/资料/示例项目"],
  [String.raw`  "D:\My Projects\中文目录"  `, "/mnt/d/My Projects/中文目录"],
  ["c:/Users/user/", "/mnt/c/Users/user/"],
  ["E:\\", "/mnt/e/"],
  ["  /home/user/my project  ", "/home/user/my project"],
  [String.raw`/home/user/back\slash`, String.raw`/home/user/back\slash`],
  ["C:relative", "C:relative"],
  ["", ""],
]) assert.equal(normalizeDirectoryPath(input), expected, input);
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
assert.ok(fileHtml.includes('width:340px'));
assert.ok(fileHtml.includes('aria-valuemin="320"'));
assert.ok(fileHtml.includes('aria-label="文件面板"'));
assert.ok(fileHtml.includes('aria-label="目录与文件列表"'));
assert.ok(fileHtml.includes('title="收起面板"'));
assert.ok(!fileHtml.includes('aria-modal'));
assert.ok(!fileHtml.includes('选定此目录'));
assert.ok(fileHtml.includes('aria-label="目录导航"'), "文件面板导航放在标题栏槽位");
assert.ok(!fileHtml.includes('class="dir-nav"'), "槽位挂载前不闪出内联导航");
assert.ok(!fileHtml.includes('aria-label="Windows 浏览窗口"'), "能力未确认时不显示原生入口");
const previousMeta = store.meta;
store.meta = { capabilities: { windowsDirectoryPicker: true } };
fileHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
assert.ok(fileHtml.includes('aria-label="Windows 浏览窗口"'), "本机文件面板接入原生浏览入口");
const directoryHtml = renderToStaticMarkup(React.createElement(DirectoryBrowser, { initialPath: "/a/b", onSelect() {}, onClose() {} }));
assert.ok(!directoryHtml.includes('aria-label="Windows 浏览窗口"'), "原有目录弹窗不重复增加原生入口");
for (const label of ["上一级", "WSL", "Windows"]) assert.ok(directoryHtml.includes(label), "目录弹窗保留内联导航");
store.meta = { capabilities: { windowsDirectoryPicker: false } };
fileHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
assert.ok(!fileHtml.includes('aria-label="Windows 浏览窗口"'), "远程入口仍只提供网页浏览");
store.meta = previousMeta;
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
  assert.ok(html.includes('aria-label="目录路径"'));
  assert.ok(html.includes("前往"));
}
console.log("✅ file panel：相对路径、边界插入、复制降级判定、三面板互斥、一次性请求与宽度隔离通过");

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const previousPreview = store.filePreview;
const pdfPreview = { target: { path: "/a/b/中文.pdf", root: "/a/b" }, loadId: 1, draft: "", loading: false, saving: false, error: null,
  file: { path: "/a/b/中文.pdf", name: "中文.pdf", kind: "pdf", size: 120, editable: false, mimeType: "application/pdf" } };
try {
  store.filePreview = pdfPreview;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { pdfViewerEnabled: true } });
  const pdfHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
  assert.ok(pdfHtml.includes('title="PDF 文件预览"') && pdfHtml.includes("<iframe"), "支持 PDF 时通过 iframe 导航到原生查看器");
  assert.ok(pdfHtml.includes('role="toolbar"') && pdfHtml.indexOf("外部打开") < pdfHtml.indexOf("<iframe"), "文件操作集中在顶栏");
  const labels = [">返回<", ">引用<", ">复制路径<", ">外部打开<"];
  assert.ok(labels.every((label, i) => pdfHtml.indexOf(label) >= 0 && (i === 0 || pdfHtml.indexOf(labels[i - 1]) < pdfHtml.indexOf(label))), "顶栏操作顺序符合要求");
  for (const removed of ["重新读取", "下载", "file-preview-path", "字节", "只读", "使用浏览器 PDF"]) assert.ok(!pdfHtml.includes(removed), removed);
  store.filePreview = { ...pdfPreview, file: { ...pdfPreview.file, kind: "markdown", text: "# 内容", editable: true, version: "v1" }, draft: "# 内容" };
  const markdownHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
  assert.ok(markdownHtml.includes('aria-label="文件显示方式"') && markdownHtml.includes("segmented-slider"), "文本预览使用终端同款滑动切换");
  assert.ok(markdownHtml.includes('aria-label="下载"') && !markdownHtml.includes('aria-label="外部打开"'), "普通文本只保留一个下载入口");
  store.filePreview = pdfPreview;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { pdfViewerEnabled: false } });
  const fallbackHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
  assert.ok(!fallbackHtml.includes("<iframe") && !fallbackHtml.includes("<object"), "不支持内嵌时不留下空白查看区");
  assert.ok(fallbackHtml.includes("未启用内嵌 PDF") && fallbackHtml.includes("外部打开"));
} finally {
  store.filePreview = previousPreview;
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else delete globalThis.navigator;
}
console.log("✅ 文件顶栏操作顺序、简洁 PDF 界面、原生查看器入口及能力回退");

const previousState = { sessions: store.sessions, currentId: store.currentId, fileDirectory: store.fileDirectory };
try {
  store.sessions = [{ id: "a", cwd: "/proj/a", status: "idle", agent: "claude" }, { id: "b", cwd: "/proj/b", status: "idle", agent: "claude" }];
  store.fileDirectory = { sessionId: "a", path: "/proj/a/sub" };
  const shown = id => { store.currentId = id; return renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} })); };
  assert.ok(shown("a").includes("/proj/a/sub"), "同一会话保留浏览位置");
  const other = shown("b");
  assert.ok(other.includes("/proj/b") && !other.includes("/proj/a"), "切到其他会话回到该会话 cwd");
} finally { Object.assign(store, previousState); }
console.log("✅ 文件面板浏览目录按会话归属");
