import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// 先在纯 Node 环境导入，防止 store 或纯逻辑出现顶层 DOM 依赖。
import { Store, store } from "../src/store.ts";
import { insertFileMention, planFileMention, FilePanel } from "../src/components/FilePanel.tsx";
import { DirectoryBrowser, DirectoryContents } from "../src/components/DirectoryBrowser.tsx";
import { directoryBreadcrumbs, directoryEntryDate, directoryEntrySize, normalizeDirectoryPath, recentDirectoryPaths, sortedDirectoryEntries } from "../src/directory-path.ts";
import { DispatchPanel } from "../src/components/DispatchPanel.tsx";
import { FILE_WIDTH_OPTIONS } from "../src/components/SidePanelResize.tsx";
import { clampPanelWidth } from "../src/terminal.ts";
import { extractMentionTokens, mentionQueryAt } from "../src/mentions.ts";
import { FilePreview } from "../src/components/FilePreview.tsx";
import { isolatedHtml } from "../src/file-preview.ts";

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
  [String.raw`C:\Users\user\Documents\项目\2025级`, "/mnt/c/Users/user/Documents/项目/2025级"],
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
store.meta = { capabilities: { windowsDirectoryPicker: true, windowsPaths: true } };
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
  assert.ok(html.includes(`enterKeyHint="go"`) || html.includes(`enterkeyhint="go"`), "地址栏回车即前往，不再单设按钮");
}
console.log("✅ file panel：相对路径、边界插入、复制降级判定、三面板互斥、一次性请求与宽度隔离通过");

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const previousPreview = store.filePreview;
const pdfPreview = { target: { path: "/a/b/中文.pdf", root: "/a/b" }, loadId: 1, draft: "", loading: false, saving: false, error: null,
  file: { path: "/a/b/中文.pdf", name: "中文.pdf", kind: "pdf", size: 120, editable: false, mimeType: "application/pdf" } };
try {
  store.filePreview = pdfPreview;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN", pdfViewerEnabled: true } });
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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN", pdfViewerEnabled: false } });
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

{
  const tabs = new Store();
  const hadWindow = "window" in globalThis, oldWindow = globalThis.window;
  let answer = false;
  globalThis.window = { ...oldWindow, confirm: () => answer, matchMedia: () => ({ matches: false }) };
  try {
    tabs.currentId = "a";
    const dirty = { target: { path: "/p/a.md", root: "/p" }, loadId: 1, loading: false, saving: false, error: null, draft: "改",
      file: { path: "/p/a.md", name: "a.md", kind: "markdown", size: 1, editable: true, mimeType: "text/markdown", text: "原", version: "v" } };
    tabs.filePreview = dirty;
    tabs.openFileTab({ path: "/p/sub", root: "/p", folder: true });
    assert.equal(tabs.fileTabs.length, 2);
    assert.deepEqual(tabs.fileDirectory, { sessionId: "a", path: "/p/sub" }, "文件夹在新标签浏览");
    assert.equal(tabs.filePreview, null);
    tabs.switchFileTab(1);
    assert.equal(tabs.filePreview, dirty, "切回保留未保存草稿");
    tabs.switchFileTab(2);
    tabs.closeFileTab(1);
    assert.equal(tabs.fileTabs.length, 2, "后台标签有未保存修改时取消即不关");
    answer = true; tabs.closeFileTab(1);
    assert.deepEqual(tabs.fileTabs.map(tab => tab.id), [2]);
    tabs.filePreview = dirty;
    answer = false; tabs.closeFileTab(2);
    assert.equal(tabs.fileTabs.length, 1, "最后一个标签也保留未保存修改的关闭确认");
    assert.equal(tabs.filePreview, dirty, "取消关闭时保留预览与草稿");
    tabs.filePreview = { ...dirty, saving: true };
    tabs.closeFileTab(2);
    tabs.openFileTab();
    assert.equal(tabs.fileTabs.length, 1, "保存中不能关闭或新建标签");
    tabs.filePreview = dirty;
    answer = true;
    tabs.fileBrowserBack = () => true;
    const directory = tabs.fileDirectory;
    tabs.closeFileTab(2);
    assert.equal(tabs.fileTabs.length, 1, "单标签预览点关闭会返回目录");
    assert.equal(tabs.fileTabId, 2, "返回目录保留当前标签");
    assert.equal(tabs.filePreview, null);
    assert.deepEqual(tabs.fileDirectory, directory, "返回此前浏览的目录");
    tabs.closeFileTab(2);
    assert.equal(tabs.fileTabs.length, 0, "最后一个标签可以关闭");
    assert.equal(tabs.fileTabId, 0);
    assert.equal(tabs.filePreview, null);
    assert.equal(tabs.fileDirectory, null);
    assert.equal(tabs.fileBrowserBack, null, "空面板不保留旧目录的返回处理");
    tabs.openFileTab();
    assert.equal(tabs.fileTabs.length, 1, "空面板可以重新新建标签");
    assert.equal(tabs.fileTabId, tabs.fileTabs[0].id);
    assert.equal(tabs.filePreview, null);
    assert.equal(tabs.fileDirectory, null, "新标签从会话 cwd 开始");
    tabs.filePreview = dirty;
    const firstId = tabs.fileTabId;
    tabs.openFileTab();
    tabs.filePreview = { ...dirty, draft: dirty.file.text };
    const secondId = tabs.fileTabId;
    tabs.closeFileTab(secondId);
    assert.equal(tabs.fileTabs.length, 1, "多标签时关闭预览仍移除整个标签");
    assert.equal(tabs.fileTabId, firstId);
    assert.equal(tabs.filePreview, dirty, "关闭后切回其他标签的预览");
  } finally { if (hadWindow) globalThis.window = oldWindow; else delete globalThis.window; }

  const previous = { fileTabs: store.fileTabs, fileTabId: store.fileTabId, filePreview: store.filePreview, fileDirectory: store.fileDirectory, sessions: store.sessions, currentId: store.currentId };
  try {
    store.sessions = [{ id: "a", cwd: "/proj/a", status: "idle", agent: "claude" }];
    store.currentId = "a";
    store.fileTabs = [{ id: 1, directory: null, preview: null }, { id: 2, directory: { sessionId: "a", path: "/proj/a/docs" }, preview: null }];
    store.fileTabId = 1; store.filePreview = null; store.fileDirectory = null;
    const html = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
    assert.ok(html.includes('aria-label="文件标签页"') && html.includes('aria-label="新建标签页"'));
    assert.ok(html.includes(">a</span>") && html.includes(">docs</span>") && html.includes('aria-label="关闭 docs"'), "标签显示目录名，可关闭");
    assert.equal((html.match(/class="term-tab-close"/g) ?? []).length, 2, "多个目录标签都显示关闭按钮");
    assert.ok(html.indexOf('aria-label="目录路径"') < html.indexOf('aria-label="文件标签页"') || html.indexOf("地址栏目录层级") < html.indexOf('aria-label="文件标签页"'), "标签行在地址栏下方");
    store.closeFileTab(2);
    const singleHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
    assert.ok(!singleHtml.includes('class="term-tab-close"'), "单个目录标签隐藏关闭按钮");
    store.fileDirectory = { sessionId: "a", path: "/proj/a" };
    store.filePreview = { ...pdfPreview, target: { path: "/proj/a/readme.pdf", root: "/proj/a" } };
    const previewHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
    assert.ok(previewHtml.includes('aria-label="关闭 readme.pdf"'), "单个文档预览仍显示关闭按钮");
    store.closeFileTab(1);
    const returnedHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
    assert.ok(returnedHtml.includes('aria-label="目录与文件列表"'), "单标签预览关闭后显示目录");
    assert.ok(!returnedHtml.includes('class="term-tab-close"'), "单标签预览返回目录后隐藏关闭按钮");
    assert.ok(!returnedHtml.includes('class="file-preview'), "返回目录后不再显示预览");
    store.closeFileTab(1);
    const emptyHtml = renderToStaticMarkup(React.createElement(FilePanel, { onClose() {} }));
    assert.ok(emptyHtml.includes('aria-label="新建标签页"'), "全部关闭后保留新建入口");
    for (const content of ['role="tab"', 'aria-label="目录与文件列表"', 'aria-label="目录导航"', 'aria-label="目录路径"', 'class="file-preview', 'class="file-notice']) {
      assert.ok(!emptyHtml.includes(content), `空面板不显示旧内容：${content}`);
    }
  } finally { Object.assign(store, previous); }
}
console.log("✅ 文件面板标签页：新标签打开文件夹、切换保留草稿、关闭确认与保存中锁定");

{
  const tabs = new Store();
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  let finish, signal;
  const target = { path: "/p/a.txt", root: "/p" };
  const file = { ...target, name: "a.txt", kind: "text", size: 2, editable: true, mimeType: "text/plain", text: "ok", version: "v" };
  globalThis.window = { ...oldWindow, addEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.fetch = (_url, init) => {
    signal = init.signal;
    return new Promise(resolve => { finish = () => resolve({ json: async () => ({ code: 0, data: file }) }); });
  };
  try {
    tabs.closeFileTab(tabs.fileTabId);
    const loading = tabs.openFilePreview(target);
    assert.equal(tabs.fileTabs.length, 1, "从空面板直接打开文件会创建标签");
    const loadingTabId = tabs.fileTabId;
    tabs.closeFileTab(loadingTabId);
    assert.ok(signal.aborted, "关闭文件预览会中断读取");
    assert.equal(tabs.fileTabs.length, 1, "读取中的单标签预览也返回目录");
    assert.equal(tabs.fileTabId, loadingTabId);
    assert.deepEqual(tabs.fileDirectory, { sessionId: null, path: target.root });
    assert.equal(tabs.filesOpen, true, "关闭标签保留文件面板");
    finish(); await loading;
    assert.equal(tabs.filePreview, null, "迟到的读取结果不会恢复预览");
    tabs.closeFileTab(loadingTabId);
    assert.equal(tabs.fileTabs.length, 0);
    const reopened = tabs.openFilePreview(target);
    finish(); await reopened;
    assert.equal(tabs.fileTabs.length, 1);
    assert.notEqual(tabs.fileTabId, loadingTabId, "重新打开文件使用新标签");
    assert.equal(tabs.filePreview.file.text, "ok");
  } finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch; }
}
console.log("✅ 空文件面板直接打开文件、关闭时中断读取与迟到结果隔离");

// 执行真实组件的导航/刷新处理器，以目录接口请求作为行为断言。
{
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const oldDispatcher = internals.H, oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  const previous = { currentId: store.currentId, newSessionCwd: store.newSessionCwd, filesOpen: store.filesOpen,
    fileDirectory: store.fileDirectory, fileTabs: store.fileTabs, fileTabId: store.fileTabId, filePreview: store.filePreview, meta: store.meta };
  function mount(Component, initialProps) {
    const slots = [], effects = []; let cursor, tree, props = initialProps;
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    const dispatcher = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; render(); }]; },
      useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
      useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
      useSyncExternalStore(_subscribe, get) { return get(); },
      useId() { return `fixture-${cursor++}`; },
      useEffect(fn, deps) { const i = cursor++; if (!same(slots[i], deps)) { slots[i] = deps; effects.push(fn); } },
      useLayoutEffect() { cursor++; },
    };
    function render(next = props) { props = next; internals.H = dispatcher; cursor = 0; tree = Component(props); }
    render();
    return { get tree() { return tree; }, render, flush() { while (effects.length) effects.shift()(); } };
  }
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children ?? node.children)];
  }
  const find = (tree, predicate) => nodes(tree).find(predicate);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const calls = [];
  try {
    globalThis.window = { ...oldWindow, matchMedia: () => ({ matches: false }) };
    globalThis.fetch = async url => {
      const path = new URL(url, 'http://localhost').searchParams.get('path') ?? '/home';
      calls.push(path);
      return { json: async () => ({ code: 0, data: { path, parent: path.slice(0, path.lastIndexOf('/')) || '/', dirs: [], files: [] } }) };
    };
    Object.assign(store, { currentId: null, newSessionCwd: '/project/initial', filesOpen: false, filePreview: null,
      fileDirectory: { sessionId: null, path: '/elsewhere' }, fileTabs: [{ id: 1, directory: null, preview: null }], fileTabId: 1, meta: null });
    store.setFilesOpen(true);
    assert.equal(store.fileDirectory.path, '/project/initial', '打开文件栏对齐新建目录，覆盖旧浏览位置');
    const panel = mount(FilePanel, { onClose() {} });
    const directoryProps = () => ({ ...find(panel.tree, node => node.type === DirectoryContents).props, navTarget: { nodeType: 1 } });
    const directory = mount(DirectoryContents, directoryProps()); directory.flush(); await settle();
    assert.deepEqual(calls, ['/project/initial']);
    const button = label => find(directory.tree, node => node.type === 'button' && node.props['aria-label'] === label);
    button('上一级').props.onClick(); await settle();
    assert.equal(calls.at(-1), '/project');
    assert.equal(store.newSessionCwd, '/project/initial', '文件栏浏览不改写新建地址');
    store.setNewSessionCwd('/project/latest');
    panel.render(); directory.render(directoryProps()); directory.flush(); await settle();
    assert.deepEqual(calls, ['/project/initial', '/project'], '改新建地址及宿主通知不打断手动浏览');
    button('刷新').props.onClick(); await settle();
    assert.equal(calls.at(-1), '/project/latest', '刷新读取最新新建地址');
    assert.equal(store.fileDirectory.path, '/project/latest');
    store.setFileDirectory('/elsewhere'); store.setFilesOpen(false); store.setFilesOpen(true);
    assert.equal(store.fileDirectory.path, '/project/latest', '收起再开重新对齐新建目录');
    directory.render({ ...directoryProps(), refreshPath: undefined });
    button('上一级').props.onClick(); await settle();
    button('刷新').props.onClick(); await settle();
    assert.equal(calls.at(-1), '/project', '普通会话没有新建目录刷新目标时刷新当前浏览位置');
    store.currentId = 'a'; panel.render();
    assert.equal(directoryProps().refreshPath, undefined, '已有会话不使用残留的新建目录');
    store.currentId = null;
    store.filesOpen = false;
    store.filePreview = { draft: 'unsaved' };
    store.setFileDirectory('/preview'); store.setFilesOpen(true);
    assert.equal(store.fileDirectory.path, '/preview', '重新打开文档预览时保留原目录与草稿');
  } finally { Object.assign(store, previous); internals.H = oldDispatcher; globalThis.fetch = oldFetch; globalThis.window = oldWindow; }
}
console.log("✅ 新建目录与文件栏：打开/刷新同步，独立浏览、最新地址及预览保留");

// 执行开关的真实处理器；浏览器 CSP/sandbox 的强制执行另做真实浏览器验证。
{
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const oldDispatcher = internals.H, oldParser = globalThis.DOMParser;
  const slots = []; let cursor = 0, parses = 0;
  const removed = [];
  const draft = '<!doctype html><html><body><p>slide</p><script>window.slide = 1;</script></body></html>';
  const preview = { ...pdfPreview, target: { path: '/slides/deck.html', root: '/slides' }, draft,
    file: { ...pdfPreview.file, kind: 'html', text: draft, editable: true } };
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  function render(props = { preview }) {
    cursor = 0;
    const tree = FilePreview(props);
    return { button: nodes(tree).find(node => node.type === 'button'), iframe: nodes(tree).find(node => node.type === 'iframe') };
  }
  try {
    internals.H = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
        return [slots[i], value => { slots[i] = value; }]; },
      useMemo(fn) { return fn(); },
    };
    globalThis.DOMParser = class {
      parseFromString() { parses++; return {
        querySelectorAll(selector) { removed.push(selector); return []; },
        documentElement: { outerHTML: '<html><body>static</body></html>' },
      }; }
    };
    let view = render();
    assert.equal(view.iframe.props.sandbox, 'allow-scripts', '只授予脚本，不加同源或其他权限');
    assert.equal(view.iframe.props.allowFullScreen, true);
    assert.equal(view.button.props['aria-pressed'], true);
    assert.equal(view.button.props.children, '停止脚本', '打开 HTML 默认运行脚本');
    assert.equal(view.iframe.props.srcDoc, isolatedHtml(draft, true));
    assert.ok(view.iframe.props.srcDoc.endsWith(draft), '交互模式保留脚本及执行顺序');
    const policy = view.iframe.props.srcDoc.slice(0, view.iframe.props.srcDoc.indexOf(draft));
    for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", 'font-src data:']) assert.ok(policy.includes(directive));
    assert.doesNotMatch(policy, /https?:|unsafe-eval|'self'/);
    const beforeSource = parses;
    assert.equal(render({ preview, source: true }).iframe, undefined, '源码视图卸载运行中的页面');
    assert.equal(parses, beforeSource, '源码不解析 HTML');
    view = render(); const activeKey = view.iframe.key;
    view.button.props.onClick(); view = render();
    assert.equal(view.iframe.props.sandbox, '');
    assert.equal(view.button.props['aria-pressed'], false);
    assert.equal(view.button.props.children, '运行脚本');
    assert.ok(removed.some(selector => selector.includes('script')), '停止后静态预览继续移除脚本');
    assert.match(view.iframe.props.srcDoc, /script-src 'none'/);
    assert.notEqual(view.iframe.key, activeKey, '停止时重建 iframe，销毁旧脚本与计时器');
    assert.equal(render({ preview: { ...preview, loadId: preview.loadId + 1 } }).iframe.props.sandbox, 'allow-scripts', '重新加载恢复自动运行');
    view = render();
    assert.equal(view.iframe.props.sandbox, '', '当前文件保持停止状态');
    view.button.props.onClick(); view = render();
    assert.equal(view.iframe.props.sandbox, 'allow-scripts', '停止后可重新运行');
  } finally { internals.H = oldDispatcher; if (oldParser === undefined) delete globalThis.DOMParser; else globalThis.DOMParser = oldParser; }
}
console.log("✅ HTML 脚本默认运行、停止与重启、最小 sandbox 权限、前置 CSP 与源码卸载");
