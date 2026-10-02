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
console.log("✅ 工具标题渲染检查通过（exec + Codex/Claude/Kimi 普通工具）");
