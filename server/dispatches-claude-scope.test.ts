import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSubagentReader, listDispatches, readClaudeSubagent, type Dispatch } from "./dispatches.js";

const root = await mkdtemp(join(tmpdir(), "wb-claude-scope-"));
const projects = join(root, "projects");
const delegate = join(root, "delegate");
const now = Date.now();
const timestamp = new Date(now - 1000).toISOString();
const outsideCwd = "/home/user/dev";
const encode = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/gu, "-");
async function fixture(cwd: string, parent: string, agent: string) {
  const project = join(projects, encode(cwd));
  const directory = join(project, parent, "subagents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(project, `${parent}.jsonl`), JSON.stringify({ type: "user", sessionId: parent, cwd, timestamp }) + "\n");
  await writeFile(join(directory, `agent-${agent}.jsonl`), [
    { type: "user", isSidechain: true, agentId: agent, sessionId: parent, cwd, timestamp, message: { content: "检查其他 cwd 的任务" } },
    { type: "assistant", timestamp, message: { model: "claude-sonnet-5-5", stop_reason: "end_turn" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return directory;
}
const registeredDirectory = await fixture(outsideCwd, "wb-native", "sonnet");
const fallbackDirectory = await fixture("/another/project", "delegate-parent", "fallback");
const unrelatedDirectory = await fixture("/unrelated/project", "unrelated-parent", "unrelated");
const unrelatedSibling = await fixture(outsideCwd, "unregistered-sibling", "sibling");
await mkdir(delegate);
const previous = process.env.WORKBENCH_CLAUDE_PROJECTS_DIR;
process.env.WORKBENCH_CLAUDE_PROJECTS_DIR = projects;
try {
  let providerCalls = 0;
  const provide = () => { providerCalls++; return [{ cwd: outsideCwd, nativeSessionId: "wb-native" }]; };
  const listed = await listDispatches(20, delegate, provide);
  assert.equal(listed.find(run => run.session === "sonnet")?.parent?.sessionId, "wb-native",
    "注册在非 wb 项目 cwd 的 Claude 会话，无 delegate 也纳入子代理");
  assert.equal(listed.filter(run => run.tool === "claude").length, 1, "不纳入无关项目或同项目未注册父会话");
  assert.equal(providerCalls, 1);
  const hidden = await listDispatches(20, delegate, () => []);
  assert.equal(hidden.length, 0, "注册表候选变化立即失效，不能沿用其他候选缓存");
  const relisted = await listDispatches(20, delegate, provide);
  assert.equal(relisted.filter(run => run.tool === "claude").length, 1);

  const reads: string[] = [], listings: string[] = [];
  const read = createClaudeSubagentReader(async path => { reads.push(path); return readClaudeSubagent(path); },
    async path => { listings.push(path); return readdir(path, { withFileTypes: true }); });
  const sessions = [{ cwd: outsideCwd, nativeSessionId: "wb-native" }];
  const direct = await read([], projects, now, sessions);
  assert.equal(direct.length, 1);
  assert.deepEqual(listings, [registeredDirectory], "已知 cwd/id 只枚举该父会话 subagents");
  assert.equal(reads.length, 1);
  await read([], projects, now, sessions);
  assert.equal(reads.length, 1, "跨项目注册会话仍使用文件指纹缓存");

  const parentRun = { runId: "delegate", tool: "codex", cwd: "/executor/codex-project",
    parent: { agent: "claude", sessionId: "delegate-parent", entrypoint: null, model: null } } as Dispatch;
  const combined = await read([parentRun], projects, now, sessions);
  assert.deepEqual(combined.map(run => run.session).sort(), ["fallback", "sonnet"]);
  assert.equal((await read([{ ...parentRun, cwd: null }], projects, now, sessions)).length, 2,
    "executor cwd 与父 cwd 不同或完全缺失时，都按父 ID 定位");
  assert.ok(listings.includes(projects), "未知 cwd 只枚举项目根目录名字");
  assert.ok(listings.includes(fallbackDirectory));
  assert.ok(!listings.includes(unrelatedDirectory) && !listings.includes(unrelatedSibling));
  assert.ok(listings.every(path => path === projects || path === registeredDirectory || path === fallbackDirectory),
    "不递归枚举无关项目、会话或 transcript 文件");
  const beforeListings = listings.filter(path => path === projects).length;
  await read([parentRun], projects, now, sessions);
  assert.equal(listings.filter(path => path === projects).length, beforeListings, "父 ID 定位结果缓存命中");
  const duplicated = await read([parentRun, parentRun], projects, now, [...sessions, ...sessions]);
  assert.equal(duplicated.length, 2, "注册表与 delegate 父候选去重");
  const invalid = await read([{ ...parentRun, parent: { ...parentRun.parent!, sessionId: "../escape" } }], projects, now,
    [{ cwd: outsideCwd, nativeSessionId: "../escape" }]);
  assert.deepEqual(invalid, [], "无效父 ID 不成为路径候选");
} finally {
  if (previous === undefined) delete process.env.WORKBENCH_CLAUDE_PROJECTS_DIR;
  else process.env.WORKBENCH_CLAUDE_PROJECTS_DIR = previous;
}
console.log("✅ Claude 注册会话跨项目、delegate 父 ID 定位、无关项目/同项目会话隔离、候选与指纹缓存通过");
