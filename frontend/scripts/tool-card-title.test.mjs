import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 渲染共享卡片的真实标题，检查修复覆盖 exec 和普通工具；不启动浏览器或 wb。
globalThis.React = React;
const { ToolCard } = await import("../src/components/StreamItems.tsx");
const longCommand = "rg -n " + "a_very_long_pattern ".repeat(100);
const cases = [
  ["codex", "exec", `tools.exec_command({cmd: ${JSON.stringify(longCommand)}})`, "运行"],
  ["codex", "commandExecution", { command: longCommand }, "运行"],
  ["claude", "Bash", { command: longCommand }, "运行"],
  ["kimi", "Read", { path: "/work/" + "long-path/".repeat(100) + "file.ts" }, "读取"],
];
for (const [agent, toolName, input, verb] of cases) {
  const item = { kind: "tool", key: "t", seq: 1, turn: 1, toolCallId: "t", toolName, baseToolName: toolName,
    input: typeof input === "string" ? input : JSON.stringify(input), rawInput: input, status: "ok", result: "" };
  const html = renderToStaticMarkup(React.createElement(ToolCard, { item, agent, cwd: "/work" }));
  assert.match(html, new RegExp(`<span class="tool-name" style="flex-shrink:0" title="${verb}">${verb}</span>`));
  assert.match(html, /class="tool-summary mono" style="flex:1 1 0"/);
}
const { focusVisible } = await import("../src/render-items.ts");
const sent = { kind: "tool", key: "s", seq: 2, turn: 1, toolCallId: "s", toolName: "SendUserFile", baseToolName: "SendUserFile", input: "", status: "ok", result: "",
  rawInput: { files: ["/tmp/claude-1000/p/s/scratchpad/地图.html", "docs/a.md", "/work/report#1 100%.csv"], caption: "看这个", display: "render" } };
const sentHtml = renderToStaticMarkup(React.createElement(ToolCard, { item: sent, agent: "claude", cwd: "/work" }));
assert.match(sentHtml, /class="tool-card sent-files"/);
assert.match(sentHtml, /看这个/);
assert.match(sentHtml, /<span class="sent-file-name">地图\.html<\/span><span class="sent-file-dir mono">\/tmp\/claude-1000\/p\/s\/scratchpad\/<\/span>/);
assert.match(sentHtml, /<span class="sent-file-dir mono">\/work\/docs\/<\/span>/, "相对路径按 cwd 解析");
assert.match(sentHtml, /<span class="sent-file-name">report#1 100%\.csv<\/span>/, "原始文件名不按链接语法解析");
assert.ok(focusVisible(sent), "专注视图保留发送文件卡片");
assert.match(renderToStaticMarkup(React.createElement(ToolCard, { item: { ...sent, status: "error" }, agent: "claude", cwd: "/work" })), /tool-head/, "失败时回落普通工具卡");
console.log("✅ 工具标题与 SendUserFile 文件卡片渲染检查通过");
