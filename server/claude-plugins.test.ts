import assert from "node:assert/strict";
import { ClaudePlugins } from "./claude-plugins.js";

const calls: { cwd: string; args: string[] }[] = [];
const plugins = new ClaudePlugins(async (cwd, args) => {
  calls.push({ cwd, args });
  if (args[0] === "list") return [
    { id: "known@market", scope: "project", enabled: true },
    { id: "auto@market", enabled: false },
  ];
  return { success: true };
});
await assert.rejects(plugins.setEnabled("/session", "known@market", false), /最近一次列表/);
assert.equal(calls.length, 0);
await plugins.list("/session");
await assert.rejects(plugins.setEnabled("/session", "unknown@market", true), /最近一次列表/);
await assert.rejects(plugins.setEnabled("/other", "known@market", false), /最近一次列表/);
await assert.rejects(plugins.setEnabled("/session", "known@market", false, "user"), /最近一次列表/);
assert.equal(calls.length, 1);
await plugins.setEnabled("/session", "known@market", false, "project");
await plugins.list("/session");
assert.deepEqual(calls.slice(-2), [
  { cwd: "/session", args: ["disable", "known@market", "--json", "-s", "project"] },
  { cwd: "/session", args: ["list", "--json"] },
]);
await plugins.setEnabled("/session", "auto@market", true);
assert.deepEqual(calls.at(-1)?.args, ["enable", "auto@market", "--json"]);
const failing = new ClaudePlugins(async (_cwd, args) => {
  if (args[0] === "list") return [{ id: "known@market", scope: "user" }];
  throw new Error("模拟 CLI 失败");
});
await failing.list("/session");
await assert.rejects(failing.setEnabled("/session", "known@market", true), /模拟 CLI 失败/);
console.log("✅ Claude 插件列表校验、scope、数组参数、刷新与失败处理");
