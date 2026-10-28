import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSettled } from "./render-settled.mjs";
import { Store, store } from "../src/store.ts";
import { FilePanel, FileTabs, FilePanels, WorkspaceDropTarget } from "../src/components/FilePanel.tsx";

globalThis.React = React;
const { App } = await import("../src/App.tsx");
const SessionComponents = await import("../src/components/SessionView.tsx");
const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
let answer = false;
const unload = [];
globalThis.window = { location: { hash: "#/" }, innerWidth: 1280, confirm: () => answer,
  matchMedia: () => ({ matches: false }), addEventListener: (name, fn) => { if (name === "beforeunload") unload.push(fn); } };

const preview = (name, draft = name) => ({ target: { path: `/project/${name}`, root: "/project" }, loadId: 1,
  loading: false, saving: false, error: null, draft,
  file: { path: `/project/${name}`, name, kind: "markdown", text: name, editable: true, version: "v1", size: 1 } });
const makeStore = () => {
  const value = new Store();
  value.currentId = "session";
  value.sessions = [{ id: "session", cwd: "/project", status: "running", agent: "codex", seq: 5 }];
  value.fileTabs = [{ id: 10, directory: null, preview: preview("slides.md") }, { id: 11, directory: null, preview: preview("notes.md", "draft") }];
  value.fileTabId = 11;
  return value;
};
try {
  // 顶栏必须位于会被隐藏的内容页之外；同一个顶栏承载会话、文件和终端标签。
  const headerState = { currentId: store.currentId, sessions: store.sessions, meta: store.meta, fileTabs: store.fileTabs,
    fileTabId: store.fileTabId, mainFileTabId: store.mainFileTabId, mainTerminalId: store.mainTerminalId,
    terminals: store.terminals, terminalAreas: store.terminalAreas, workspaceTabOrder: store.workspaceTabOrder };
  const reactInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previousDispatcher = reactInternals.H;
  const treeNodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(treeNodes) : [node, ...treeNodes(node.props?.children)];
  try {
    reactInternals.H = {
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
      useRef: initial => ({ current: initial }), useMemo: fn => fn(), useCallback: fn => fn,
      useEffect() {}, useSyncExternalStore: (_subscribe,get) => get(),
    };
    const app = App();
    const workspace = treeNodes(app).find(node => node.props?.className?.split(" ").includes("workspace"));
    const sharedHead = workspace.props.children.find(node => node?.props?.className?.split(" ").includes("workspace-head"));
    assert.ok(sharedHead, "全局顶栏必须独立于切标签时隐藏的会话/文件/终端内容页");
    assert.ok(treeNodes(sharedHead).some(node => node.props?.className?.includes("workspace-welcome-head mobile-topbar")), "欢迎/新建顶栏必须复用手机圆钮及质感样式");
    assert.equal(treeNodes(workspace.props.children.find(node => node?.type === "main")).includes(sharedHead), false);
    reactInternals.H = previousDispatcher;
    const session = { id: "head-session", cwd: "/project", agent: "codex", status: "idle", config: {} };
    store.currentId = session.id; store.sessions = [session];
    store.meta = { capabilities: { terminal: true }, drivers: { codex: { options: [] } } };
    store.fileTabs = [{ id: 71, area: "main", directory: null, preview: preview("head-file.md") }];
    store.terminals = [{ id: "head-terminal", kind: "bash", shell: "/bin/bash", cwd: "/project", exited: false }];
    store.terminalAreas = { "head-terminal": "main" };store.workspaceTabOrder = [];
    for (const mode of ["session", "file", "terminal"]) {
      store.mainFileTabId = mode === "file" ? 71 : 0;
      store.mainTerminalId = mode === "terminal" ? "head-terminal" : null;
      const markup = renderToStaticMarkup(React.createElement(SessionComponents.SessionWorkspaceHeader, {
        session, title: "Session title", dispatchRuns: [], backgroundCount: 0, wsState: "open", tabs: React.createElement(FileTabs, { area: "main" }),
      }));
      for (const label of ["文件", "派单", "终端", "更多"]) assert.ok(markup.includes(`aria-label="${label}"`), mode+" 应保留 "+label);
      assert.equal((markup.match(/class="term-tab-list"/g)??[]).length, 1, "只有一个主区标签栏");
      assert.ok(markup.includes("head-file.md") && markup.includes("bash"));
    }
    store.mainFileTabId=71;store.mainTerminalId=null;
    const content=renderToStaticMarkup(React.createElement(FilePanel,{tabId:71,onClose(){}}));
    assert.ok(!content.includes('role="tablist"'), "主区文件只渲染页面操作，不重复顶栏标签");
    assert.ok(!content.includes('class="panel-back"') && !content.includes('file-action-label'), "主区文件也只显示图标返回，手机不重复文字按钮");
    assert.ok(content.includes('aria-label="刷新文件"'), "主区文件也提供刷新入口");
  } finally { reactInternals.H = previousDispatcher; Object.assign(store,headerState); }
  console.log("✅ 持久工作区顶栏、会话/文件/终端共用四个按钮与单一标签行");
  const value = makeStore(), notes = value.filePreview;
  value.moveFileTab(11, "main");
  assert.equal(value.mainFileTabId, 11);
  assert.equal(value.fileTabId, 10);
  assert.equal(value.fileTabs.find(tab => tab.id === 11).preview, notes, "移动不复制或重建预览");
  assert.equal(value.mainSessionUnread, false);
  value.sessions = [{ ...value.sessions[0], seq: 6 }];
  assert.equal(value.mainSessionUnread, true, "文件显示时会话新消息可见");
  value.updateFileDraft("left edit", 11);
  value.updateFileDraft("right edit", 10);
  assert.equal(value.fileTabs.find(tab => tab.id === 11).preview.draft, "left edit");
  assert.equal(value.filePreview.draft, "right edit", "左右编辑分别命中各自文件");
  value.showMainSession();
  assert.equal(value.mainFileTabId, 0);
  assert.equal(value.fileTabs.find(tab => tab.id === 11).preview.draft, "left edit", "切回会话保留草稿");
  value.switchFileTab(11);
  assert.equal(value.mainSessionUnread, false, "重新进入文件前会话已读");
  value.openFileTab({ path: "/project/notes.md", root: "/project", folder: false });
  assert.equal(value.fileTabs.length, 2, "打开已在主区的文件不复制标签或清空草稿");
  assert.equal(value.fileTabs.find(tab => tab.id === 11).preview.draft, "left edit");
  await value.openFilePreview({ path: "/project/slides.md", root: "/project" });
  assert.equal(value.fileTabs.length, 2, "再次点击当前右侧文件的消息链接也不复制或重读");
  assert.equal(value.filePreview.draft, "right edit");
  value.closeFileTab(11);
  assert.equal(value.mainFileTabId, 11, "取消关闭保留主区文件");
  answer = true;
  value.closeFileTab(11);
  assert.equal(value.mainFileTabId, 0);
  assert.deepEqual(value.fileTabs.map(tab => tab.id), [10], "关闭最后一个主区文件回会话");

  const saving = makeStore(); saving.moveFileTab(11, "main");
  let finishSave;
  globalThis.fetch = (_url, init) => {
    assert.equal(JSON.parse(init.body).path, "/project/notes.md");
    return new Promise(resolve => { finishSave = () => resolve({ json: async () => ({ code: 0, data: { ...notes.file, text: notes.draft, version: "v2" } }) }); });
  };
  const saved = saving.saveFilePreview(11);
  assert.equal(saving.fileSaving, true, "主区保存也阻止切主机");
  saving.closeFileTab(11);
  assert.equal(saving.fileTabs.length, 2, "保存中不能关闭文件");
  saving.moveFileTab(11, "right");
  assert.equal(saving.mainFileTabId, 0);
  finishSave(); await saved;
  assert.equal(saving.filePreview.file.version, "v2", "保存回包跟随标签而不是区域");
  assert.equal(saving.filePreview.draft, "draft");
  assert.equal(saving.fileSaving, false);

  const independent = makeStore(); independent.fileTabId = 11;
  let finishIndependentSave;
  globalThis.fetch = () => new Promise(resolve => {
    finishIndependentSave = () => resolve({ json: async () => ({ code: 0, data: { ...notes.file, text: notes.draft, version: "v2" } }) });
  });
  const independentSave = independent.saveFilePreview(11);
  independent.switchFileTab(10);
  assert.equal(independent.fileTabId, 10, "保存 A 时可选择 B，不把保存锁扩大到其他标签");
  independent.updateFileDraft("independent B", 10);
  independent.switchFileTab(11);
  independent.openFileTab();
  assert.equal(independent.fileTabs.length, 3, "保存 A 时仍可新建目录标签");
  const newTab = independent.fileTabId;
  independent.closeFileTab(11);
  assert.ok(independent.fileTabs.some(tab => tab.id === 11), "A 自身仍不可关闭");
  finishIndependentSave(); await independentSave;
  assert.equal(independent.fileTabId, newTab, "A 保存完成不抢走新标签");
  assert.equal(independent.fileTabs.find(tab => tab.id === 10).preview.draft, "independent B");
  assert.equal(independent.fileTabs.find(tab => tab.id === 11).preview.file.version, "v2");

  const loading = new Store(), completions = new Map();
  globalThis.fetch = (url, init) => {
    const path = new URL(url, "http://localhost").searchParams.get("path");
    return new Promise(resolve => completions.set(path, { signal: init.signal, finish: () => resolve({ json: async () => ({ code: 0, data: preview(path.split("/").pop()).file }) }) }));
  };
  const first = loading.openFilePreview({ path: "/project/one.md", root: "/project" });
  const firstId = loading.fileTabId;
  loading.openFileTab();
  const second = loading.openFilePreview({ path: "/project/two.md", root: "/project" });
  const secondId = loading.fileTabId;
  loading.moveFileTab(firstId, "main");
  completions.get("/project/two.md").finish(); await second;
  completions.get("/project/one.md").finish(); await first;
  assert.equal(loading.fileTabs.find(tab => tab.id === firstId).preview.file.name, "one.md");
  assert.equal(loading.fileTabs.find(tab => tab.id === secondId).preview.file.name, "two.md", "左右并发读取回包分别归属");
  const third = loading.openFilePreview({ path: "/project/three.md", root: "/project" });
  const thirdId = loading.fileTabId;
  assert.notEqual(thirdId, secondId, "从消息打开不同文件新建右侧标签");
  completions.get("/project/three.md").finish(); await third;
  loading.closeFileTab(thirdId);
  loading.updateFileDraft("unsaved", firstId);
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  unload.at(-1)(event);
  assert.ok(prevented, "beforeunload 覆盖主区及非当前标签草稿");
  answer = false; loading.closeFileTab(firstId);
  assert.equal(loading.fileTabs.length, 2);
  const single = new Store();
  single.filePreview = preview("single.md");
  single.setFilesOpen(true); single.moveFileTab(single.fileTabId, "main");
  assert.equal(single.fileTabId, 0); assert.equal(single.filesOpen, false, "右侧移空后收起");
  single.moveFileTab(single.mainFileTabId, "right");
  assert.equal(single.mainFileTabId, 0); assert.equal(single.filesOpen, true);

  const snapshot = { fileTabs: store.fileTabs, fileTabId: store.fileTabId, mainFileTabId: store.mainFileTabId, filesOpen: store.filesOpen, terminals: store.terminals, termOpen: store.termOpen };
  try {
    store.fileTabs = loading.fileTabs; store.fileTabId = secondId; store.mainFileTabId = firstId; store.filesOpen = true;
    const html = renderToStaticMarkup(React.createElement(FilePanels));
    assert.ok(html.includes('data-file-area="main"') && html.includes('data-file-area="right"'));
    assert.ok(html.includes("one.md") && html.includes("two.md"));
    assert.ok(html.includes('class="term-panel file-side-panel file-main-panel"'));
    assert.ok(!html.includes('sandbox="allow-same-origin'), "预览安全边界不变");
    store.showMainSession();
    const hiddenHtml = await renderSettled(React.createElement(FilePanel, { tabId: firstId, onClose() {} }));
    assert.ok(hiddenHtml.includes('hidden=""') && hiddenHtml.includes("unsaved"), "回会话时文件内容仍挂载");
    const tabs = renderToStaticMarkup(React.createElement(FileTabs, { area: "main" }));
    assert.ok(tabs.includes("会话") && tabs.includes("Alt+0"));
    store.fileTabs = [{ id: 99, directory: null, preview: null }]; store.mainFileTabId = 0;
    const emptyMain = renderToStaticMarkup(React.createElement(FileTabs, { area: "main" }));
    assert.ok(emptyMain.includes("main-file-tabs-empty"), "无主区文件时默认隐藏标签栏");
    store.terminals = [{ id: "shell-r", kind: "bash", shell: "/bin/bash", cwd: "/project", exited: false }]; store.termOpen = true;
    const fileStrip = renderToStaticMarkup(React.createElement(FileTabs, { area: "right" }));
    const terminalStrip = renderToStaticMarkup(React.createElement(FileTabs, { area: "right", page: "terminal" }));
    assert.ok(fileStrip.includes('data-tab-id="99"') && !fileStrip.includes("terminal:shell-r"), "右侧文件页只显示文件标签");
    assert.ok(terminalStrip.includes("terminal:shell-r") && !terminalStrip.includes('data-tab-id="99"'), "右侧终端页只显示终端标签");
  } finally { Object.assign(store, snapshot); }

  // 文件与终端混合排序、整栏落点、独立激活与跨栏不创建进程。
  const workspace = makeStore();
  workspace.updateTerminals([
    { id: "shell-a", kind: "bash", cwd: "/project", exited: false },
    { id: "shell-b", kind: "bash", cwd: "/project", exited: false },
  ]);
  workspace.setTerminalBusy("right", true);
  workspace.moveWorkspaceTab("terminal:shell-a", "main");
  workspace.selectTerminal("shell-a");
  workspace.requestTerminalClose("shell-a");
  assert.equal(workspace.terminalArea("shell-a"), "right", "在途创建或结束时不能移动终端");
  assert.equal(workspace.rightTerminalId, null);
  assert.equal(workspace.terminalCloseRequest, null);
  workspace.setTerminalBusy("right", false);
  const originalTerminal = workspace.terminals[0], originalDraft = workspace.fileTabs[1].preview;
  workspace.selectTerminal("shell-a");
  assert.equal(workspace.termOpen, true);
  workspace.setTerminalMaximized(true);
  workspace.moveWorkspaceTab("terminal:shell-a", "main");
  assert.equal(workspace.mainTerminalId, "shell-a");
  assert.equal(workspace.terminalMaximized, false, "切到主区终端时还原右侧最大化");
  assert.equal(workspace.rightTerminalId, "shell-b");
  assert.equal(workspace.termOpen, true, "左右可同时显示不同终端");
  assert.equal(workspace.terminals[0], originalTerminal, "移动保留同一终端对象和 id");
  workspace.setTerminalMaximized(true);
  workspace.moveWorkspaceTab("file:11", "main", "terminal:shell-a");
  assert.deepEqual(workspace.workspaceTabKeys("main"), ["file:11", "terminal:shell-a"]);
  assert.equal(workspace.mainTerminalId, null);
  assert.equal(workspace.mainFileTabId, 11);
  assert.equal(workspace.terminalMaximized, false, "切到主区文件时还原右侧最大化");
  assert.equal(workspace.fileTabs.find(tab => tab.id === 11).preview, originalDraft);
  workspace.moveWorkspaceTab("file:11", "main", "terminal:shell-a", true);
  assert.deepEqual(workspace.workspaceTabKeys("main"), ["terminal:shell-a", "file:11"], "同栏前后排序");
  workspace.selectTerminal("shell-a");
  workspace.setFilesOpen(true);
  assert.equal(workspace.mainTerminalId, "shell-a", "右侧打开文件不切走中间终端");
  workspace.moveWorkspaceTab("terminal:shell-a", "right", "file:10");
  assert.equal(workspace.mainTerminalId, null);
  assert.equal(workspace.rightTerminalId, "shell-a");
  assert.equal(workspace.workspaceTabKeys("right")[0], "terminal:shell-a");
  const unchanged = workspace.workspaceTabKeys("right");
  workspace.moveWorkspaceTab("terminal:missing", "main");
  assert.deepEqual(workspace.workspaceTabKeys("right"), unchanged);
  workspace.fileTabs.push({ id: 90, directory: null, preview: null });
  workspace.moveWorkspaceTab("file:90", "main");
  assert.equal(workspace.fileTabs.find(tab => tab.id === 90).area, undefined, "目录不移入主区");
  workspace.moveWorkspaceTab("file:90", "right", "file:10");
  assert.ok(workspace.workspaceTabKeys("right").indexOf("file:90") < workspace.workspaceTabKeys("right").indexOf("file:10"));
  workspace.moveWorkspaceTab("terminal:shell-a", "main");
  workspace.setTerminalMaximized(true);
  workspace.showMainSession();
  assert.equal(workspace.mainTerminalId, null);
  assert.equal(workspace.terminalMaximized, false, "回会话时还原右侧最大化");
  assert.equal(workspace.terminalArea("shell-a"), "main", "回会话不移动或结束终端");
  workspace.selectTerminal("shell-a");
  workspace.requestTerminalClose("shell-a");
  assert.equal(workspace.terminalCloseRequest, "shell-a");
  assert.equal(workspace.terminals.length, 2, "点击关闭仅请求确认，不删除或结束进程");
  workspace.requestTerminalClose(null);

  const originalDocument = globalThis.document;
  const dropSnapshot = { fileTabs: store.fileTabs, fileTabId: store.fileTabId, mainFileTabId: store.mainFileTabId, filesOpen: store.filesOpen,
    terminals: store.terminals, terminalAreas: store.terminalAreas, mainTerminalId: store.mainTerminalId,
    rightTerminalId: store.rightTerminalId, workspaceTabOrder: store.workspaceTabOrder, termOpen: store.termOpen };
  try {
    Object.assign(store, { fileTabs: [{ id: 80, directory: null, preview: preview("body-drop.md", "keep draft") }], fileTabId: 80,
      mainFileTabId: 0, terminals: [], workspaceTabOrder: [], filesOpen: true, mainTerminalId: null });
    let cleaned = 0, prevented = 0;
    globalThis.document = { body: { classList: { remove() { cleaned++; } } }, querySelectorAll: () => [] };
    const target = WorkspaceDropTarget({ area: "main" });
    const element = { dataset: {} };
    const event = { currentTarget: element, dataTransfer: { types: ["application/x-aireins-workspace-tab"], getData: () => "file:80" },
      preventDefault() { prevented++; }, stopPropagation() {} };
    target.props.onDragOver(event);
    assert.equal(element.dataset.dropActive, "true");
    assert.equal(event.dataTransfer.dropEffect, "move");
    target.props.onDrop(event);
    assert.equal(store.mainFileTabId, 80, "内容区落点移动文件，不依赖标签栏");
    assert.equal(store.fileTabs[0].preview.draft, "keep draft");
    assert.ok(cleaned && prevented);
    const external = { ...event, dataTransfer: { types: ["Files"], getData: () => "" }, preventDefault() { throw new Error("外部附件不被标签拖放接管"); } };
    target.props.onDragOver(external); target.props.onDrop(external);
    store.updateTerminals([{ id: "body-shell", kind: "bash", cwd: "/project", exited: false }]);
    const terminalEvent = { ...event, dataTransfer: { types: ["application/x-aireins-workspace-tab"], getData: () => "terminal:body-shell" } };
    target.props.onDrop(terminalEvent);
    assert.equal(store.mainTerminalId, "body-shell", "同一内容区落点支持终端");
  } finally { globalThis.document = originalDocument; Object.assign(store, dropSnapshot); }
  console.log("✅ 全栏拖放、文件与终端混合排序、终端跨栏与关闭确认请求");

  // 同一 FilePanel 实例在切标签/切会话时保留目录位置，隔离侧键历史。
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const oldDispatcher = internals.H;
  const oldState = { fileTabs: store.fileTabs, fileTabId: store.fileTabId, currentId: store.currentId, sessions: store.sessions, filesOpen: store.filesOpen };
  const slots = []; let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const dispatcher = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], () => {}]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
    useSyncExternalStore(_subscribe, get) { return get(); },
    useEffect() { cursor++; },
  };
  const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const directory = () => {
    cursor = 0; internals.H = dispatcher;
    return nodes(FilePanel({ tabId: 51, onClose() {} })).find(node => node.props?.navigationHistory)?.props;
  };
  try {
    store.sessions = [{ id: "a", cwd: "/A" }, { id: "b", cwd: "/B" }]; store.currentId = "a";
    store.fileTabs = [{ id: 51, directory: null, preview: null }, { id: 52, directory: null, preview: null }];
    store.fileTabId = 51; store.filesOpen = true;
    const original = directory(); assert.equal(original.initialPath, "/A");
    original.navigationHistory.current.push("/A", "/A/sub");
    store.setFileDirectory("/A/sub", 51);
    store.switchFileTab(52); assert.equal(directory(), undefined);
    store.switchFileTab(51);
    const restored = directory(); assert.equal(restored.initialPath, "/A/sub", "重挂载目录浏览器使用此标签的最新目录");
    assert.equal(restored.navigationHistory, original.navigationHistory);
    const fetchBeforeClick = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { path: "/A/sub/readme.md", name: "readme.md", kind: "markdown", text: "opened", editable: true, version: "v1", size: 6 } }) });
      restored.onSelectFile("/A/sub/readme.md");
      assert.equal(store.fileTabs.length, 3, "目录内打开文件应新建标签，保留目录标签");
      assert.equal(store.fileTabs.find(tab => tab.id === 51).preview, null, "原目录不能被文件替换");
      assert.equal(store.fileTabs.find(tab => tab.id === 51).directory.path, "/A/sub");
      assert.notEqual(store.fileTabId, 51);
      await new Promise(resolve => setTimeout(resolve, 0));
      const openedId = store.fileTabId;
      restored.onSelectFile("/A/sub/readme.md");
      assert.equal(store.fileTabs.length, 3, "再次打开同一文件激活已有标签");
      assert.equal(store.fileTabId, openedId);
      store.switchFileTab(51);
      assert.equal(directory().initialPath, "/A/sub", "返回目录标签后位置保留");
    } finally { globalThis.fetch = fetchBeforeClick; }
    store.currentId = "b";
    const other = directory(); assert.equal(other.initialPath, "/B");
    assert.deepEqual(other.navigationHistory.current, [], "切会话不能返回另一会话的目录历史");
  } finally { internals.H = oldDispatcher; Object.assign(store, oldState); }
  console.log("✅ 双区域文件：独立编辑、移动/保存/并发读取、关闭保护、会话提醒与保持挂载");
} finally {
  globalThis.window = previousWindow; globalThis.fetch = previousFetch;
}
