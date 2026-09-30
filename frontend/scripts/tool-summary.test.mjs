#!/usr/bin/env node
// tool-summary.ts（工具行人话化）+ render-items.ts 原始字段透传的单测。
// 三家样本 fixture 跑 buildRenderItems + summarizeTool，verb/target/note 逐条写死；
// 合成用例覆盖：kimi terminalOutput、名字中途变化、完成无名字、codex 数组命令与
// bash -lc 外壳、未知工具回落（不丢信息）、cwd 外路径、旧 transcript 缺字段。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const { buildRenderItems } = await import("../src/render-items.ts");
const { summarizeTool, relPath } = await import("../src/tool-summary.ts");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } };

const ev = (seq, type, payload = {}) => ({
  type,
  sessionId: "s1",
  agentId: "s1",
  seq,
  timestamp: "2026-09-28T00:00:00.000Z",
  payload,
});

const CWD = "/work/proj";

// 从事件流折叠出工具条目并逐个摘要
function summaries(agent, events) {
  return buildRenderItems(events, agent)
    .filter((i) => i.kind === "tool")
    .map((view) => ({ view, s: summarizeTool(agent, view, CWD) }));
}

function fixtureSummaries(agent) {
  const events = readFileSync(new URL(`./fixtures/tool-events/${agent}.ndjson`, import.meta.url), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  return summaries(agent, events);
}

const vtn = (list) => list.map(({ s }) => [s.verb, s.target, s.note]);

// ══ claude 样本：每种工具的 verb/target/note 写死 ══
t("claude fixture：18 个工具逐个对上 verb/target/note", () => {
  const list = fixtureSummaries("claude");
  assert.equal(list.length, 18);
  assert.deepEqual(vtn(list), [
    ["ToolSearch", "select:TodoWrite", ""],
    ["更新待办", "", "7 项"],
    ["更新待办", "", "7 项"],
    ["读取", "a.ts", "3 行"],
    ["更新待办", "", "7 项"],
    ["运行", "Search for TODO in directory", ""],
    ["更新待办", "", "7 项"],
    ["运行", "List all .ts files in directory", ""],
    ["更新待办", "", "7 项"],
    ["编辑", "a.ts", "+1 −1"],
    ["更新待办", "", "7 项"],
    ["写入", "b.txt", "+1"],
    ["更新待办", "", "7 项"],
    ["运行", "Run ls -la && false command to demonstrate failure", "退出码 1"],
    ["更新待办", "", "7 项"],
    ["ToolSearch", "select:WebFetch", ""],
    ["抓取", "example.com", ""],
    ["更新待办", "", "7 项"],
  ]);
  assert.deepEqual(list.map(({ s }) => s.body.type), [
    "raw", "raw", "raw", "read", "raw", "command", "raw", "command", "raw",
    "diff", "raw", "diff", "raw", "command", "raw", "raw", "raw", "raw",
  ]);
});

t("claude fixture：Read 的 body 只有路径与行数（不回显全文）", () => {
  const read = fixtureSummaries("claude").find(({ s }) => s.body.type === "read");
  assert.deepEqual(read.s.body, { type: "read", path: "a.ts", lineCount: 3 });
});

t("claude fixture：Edit 的 diff body 带删/增文本；失败命令带退出码与输出", () => {
  const list = fixtureSummaries("claude");
  const edit = list.find(({ s }) => s.verb === "编辑");
  assert.deepEqual(edit.s.body.chunks, [{ removed: "function foo() {}", added: "function bar() {}" }]);
  const failed = list.find(({ s }) => s.note === "退出码 1");
  assert.equal(failed.s.body.type, "command");
  assert.equal(failed.s.body.command, "cd /work/proj && ls -la && false");
  assert.equal(failed.s.body.exitCode, 1);
  assert.ok(failed.s.body.output.startsWith("total 24"), "「Exit code 1」首行应从输出里剥掉");
});

// ══ codex 样本 ══
t("codex fixture：7 个工具逐个对上 verb/target/note（bash -lc 外壳已剥）", () => {
  const list = fixtureSummaries("codex");
  assert.equal(list.length, 7);
  assert.deepEqual(vtn(list), [
    ["运行", "cat a.ts", ""],
    ["运行", "rg -n --hidden 'TODO' .", ""],
    ["运行", "rg --files --hidden -g '*.ts'", ""],
    ["编辑", "a.ts", "+1 −1"],
    ["写入", "b.txt", "+1"],
    ["运行", "ls -la && false", "退出码 1"],
    ["抓取", "example.com", ""],
  ]);
  assert.deepEqual(list.map(({ s }) => s.body.type), [
    "command", "command", "command", "diff", "diff", "command", "raw",
  ]);
});

t("codex fixture：命令 body 带输出与退出码；fileChange 的统一 diff 解析成删/增", () => {
  const list = fixtureSummaries("codex");
  const cat = list[0];
  assert.equal(cat.s.body.output, "function foo() {}\n// TODO: fix\n");
  assert.equal(cat.s.body.exitCode, 0);
  const failed = list[5];
  assert.equal(failed.s.body.exitCode, 1);
  assert.ok(failed.s.body.output.startsWith("total 24"));
  const update = list[3];
  assert.deepEqual(update.s.body.chunks, [{ removed: "function foo() {}", added: "function bar() {}" }]);
  const add = list[4];
  assert.deepEqual(add.s.body.chunks, [{ removed: "", added: "hello" }]);
});

// ══ kimi 样本：toolName 从短名变人话标题、完成事件不带名字 ══
t("kimi fixture：7 个工具逐个对上 verb/target/note（阶段差异不影响分类）", () => {
  const list = fixtureSummaries("kimi");
  assert.equal(list.length, 7);
  assert.deepEqual(vtn(list), [
    ["读取", "a.ts", "2 行"],
    ["搜索", '"TODO"', ""],
    ["列出", "**/*.ts", "2 个文件"],
    ["编辑", "a.ts", "+1 −1"],
    ["写入", "b.txt", "+1"],
    ["运行", "ls -la && false", ""],
    ["抓取", "example.com", ""],
  ]);
  // 人话标题仍保留在 toolName 上，最初短名在 baseToolName 上
  assert.equal(list[0].view.toolName, "Reading a.ts");
  assert.equal(list[0].view.baseToolName, "Read");
});

t("kimi fixture：Bash 的 content 只有终端引用时输出为空、不丢命令", () => {
  const bash = fixtureSummaries("kimi").find(({ s }) => s.verb === "运行");
  assert.equal(bash.s.body.type, "command");
  assert.equal(bash.s.body.command, "ls -la && false");
  assert.equal(bash.s.body.output, "");
  assert.equal(bash.s.body.exitCode, null);
});

// ══ 合成：kimi terminalOutput（后端阶段 2 契约字段） ══
t("kimi terminalOutput：输出、退出码、截断标记都从它取（含超过 20 行、非零退出码）", () => {
  const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Bash" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", toolName: "Running: seq 1 25", input: { command: "seq 1 25" } }),
    ev(3, "tool_call_completed", {
      toolCallId: "t1",
      content: [{ type: "terminal", terminalId: "term-1" }],
      terminalOutput: { terminalId: "term-1", output, truncated: true, exitCode: 1, signal: null },
      isError: true,
    }),
  ]);
  assert.equal(item.s.verb, "运行");
  assert.equal(item.s.target, "seq 1 25");
  assert.equal(item.s.note, "退出码 1");
  assert.equal(item.s.body.type, "command");
  assert.equal(item.s.body.output.split("\n").length, 25, "body 保留完整输出（20 行预览是组件的事）");
  assert.equal(item.s.body.truncated, true);
  assert.equal(item.s.body.exitCode, 1);
  assert.equal(item.view.terminalOutput.terminalId, "term-1");
});

// ══ 合成：kimi 名字中途变化 + 完成事件无名字 ══
t("kimi 名字中途变人话标题、完成事件不带名字：按最初短名分类", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Bash" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", toolName: "Running: npm test", input: { command: "npm test" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "ok" } }] }),
  ]);
  assert.equal(item.view.baseToolName, "Bash");
  assert.equal(item.view.toolName, "Running: npm test");
  assert.equal(item.s.verb, "运行");
  assert.equal(item.s.target, "npm test");
});

t("kimi 只有人话标题（无短名、无 kind、无 rawInput）：从标题回落解析", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Reading docs/a.md" }),
    ev(2, "tool_call_completed", { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "1\tx" } }] }),
  ]);
  assert.equal(item.s.verb, "读取");
  assert.equal(item.s.target, "docs/a.md");
  assert.equal(item.s.note, "1 行");
});

t("kimi kind/locations 优先：kind=read + locations 绝对路径，无 input 也能定位", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Read", kind: "read" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", locations: [{ path: "/work/proj/src/a.ts", line: 3 }] }),
    ev(3, "tool_call_completed", { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "1\tx\n2\ty" } }] }),
  ]);
  assert.equal(item.s.verb, "读取");
  assert.equal(item.s.target, "src/a.ts");
  assert.equal(item.s.note, "2 行");
});

// ══ 合成：codex 数组命令与外壳 ══
t("codex 命令是数组：拼接显示；bash -lc 数组外壳同样剥掉", () => {
  const [plain, wrapped] = [
    summaries("codex", [
      ev(1, "tool_call_started", { toolCallId: "t1", toolName: "commandExecution", input: { type: "commandExecution", command: ["npm", "test"] } }),
      ev(2, "tool_call_completed", { toolCallId: "t1", result: { type: "commandExecution", command: ["npm", "test"], aggregatedOutput: "ok\n", exitCode: 0 } }),
    ]),
    summaries("codex", [
      ev(1, "tool_call_started", { toolCallId: "t2", toolName: "commandExecution", input: { type: "commandExecution", command: ["bash", "-lc", "echo hi"] } }),
      ev(2, "tool_call_completed", { toolCallId: "t2", result: { type: "commandExecution", command: ["bash", "-lc", "echo hi"], aggregatedOutput: "hi\n", exitCode: 0 } }),
    ]),
  ].map((l) => l[0]);
  assert.equal(plain.s.target, "npm test");
  assert.equal(wrapped.s.target, "echo hi");
});

// ══ 合成：未知工具回落（不丢信息） ══
t("未知工具回落：原始工具名作动词，raw body 保留完整入参与结果", () => {
  const [item] = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "NotebookEdit", input: { notebook_path: "/work/proj/n.ipynb" } }),
    ev(2, "tool_call_completed", { toolCallId: "t1", result: "cell 已更新" }),
  ]);
  assert.equal(item.s.verb, "NotebookEdit");
  assert.equal(item.s.target, "/work/proj/n.ipynb");
  assert.equal(item.s.body.type, "raw");
  assert.ok(item.s.body.input.includes("notebook_path"), "入参不丢");
  assert.equal(item.s.body.result, "cell 已更新", "结果不丢");
});

// ══ 合成：cwd 外路径保留绝对形式 ══
t("cwd 外的路径保留绝对路径；relPath 边界", () => {
  const [item] = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Read", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { file_path: "/etc/hosts" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", result: "1\t127.0.0.1 localhost" }),
  ]);
  assert.equal(item.s.target, "/etc/hosts");
  assert.equal(relPath("/work/proj", "/work/proj"), ".");
  assert.equal(relPath("/work/proj2/x", "/work/proj"), "/work/proj2/x", "前缀目录名不算 cwd 内");
});

// ══ 合成：claude 其余工具（Grep/Glob/MultiEdit/WebSearch/Task） ══
t("claude Grep/Glob/MultiEdit/WebSearch/Task", () => {
  const grep = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "g", toolName: "Grep", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "g", input: { pattern: "TODO" } }),
    ev(3, "tool_call_completed", { toolCallId: "g", result: "a.ts:1:x\nb.ts:2:y" }),
  ])[0];
  assert.deepEqual([grep.s.verb, grep.s.target, grep.s.note], ["搜索", '"TODO"', "2 处"]);

  const glob = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "l", toolName: "Glob", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "l", input: { pattern: "**/*.ts" } }),
    ev(3, "tool_call_completed", { toolCallId: "l", result: "a.ts\nb.ts\nc.ts" }),
  ])[0];
  assert.deepEqual([glob.s.verb, glob.s.target, glob.s.note], ["列出", "**/*.ts", "3 个文件"]);

  const multi = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "m", toolName: "MultiEdit", input: {} }),
    ev(2, "tool_call_updated", {
      toolCallId: "m",
      input: { file_path: "/work/proj/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    }),
    ev(3, "tool_call_completed", { toolCallId: "m", result: "ok" }),
  ])[0];
  assert.deepEqual([multi.s.verb, multi.s.target, multi.s.note], ["编辑", "a.ts", "+2 −2"]);
  assert.equal(multi.s.body.chunks.length, 2);

  const search = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "w", toolName: "WebSearch", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "w", input: { query: "foo bar" } }),
    ev(3, "tool_call_completed", { toolCallId: "w", result: "结果" }),
  ])[0];
  assert.deepEqual([search.s.verb, search.s.target], ["搜索", '"foo bar"']);

  const task = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "k", toolName: "Task", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "k", input: { description: "探索代码结构", prompt: "看看仓库" } }),
    ev(3, "tool_call_completed", { toolCallId: "k", result: "done" }),
  ])[0];
  assert.deepEqual([task.s.verb, task.s.target], ["委派", "探索代码结构"]);
});

// ══ 合成：失败附注是错误首行 ══
t("非命令工具失败时附注显示错误首行", () => {
  const [item] = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Read", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { file_path: "/work/proj/不存在.ts" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", result: "ENOENT: no such file or directory\n堆栈第二行", isError: true }),
  ]);
  assert.equal(item.s.note, "ENOENT: no such file or directory");
});

// ══ 旧 transcript：只有展示字段也能摘要（input 是 JSON 文本） ══
t("旧 transcript 无 rawInput/rawResult：从 input 文本解析回对象", () => {
  const legacy = {
    toolName: "Read",
    baseToolName: "Read",
    input: '{"file_path": "/work/proj/src/app.ts"}',
    result: "1\tx\n2\ty",
    status: "ok",
  };
  const s = summarizeTool("claude", legacy, CWD);
  assert.deepEqual([s.verb, s.target, s.note], ["读取", "src/app.ts", "2 行"]);
  assert.deepEqual(s.body, { type: "read", path: "src/app.ts", lineCount: 2 });
});

// ══ 评审修复 1：ACP kind 进摘要器（存在 toolKind，不是 ToolView.kind） ══
t("ACP kind：短名与标题都认不出时按 kind 分类（只靠 kind 才能识别）", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "opaque-x1", kind: "execute" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { command: "make build" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "done" } }] }),
  ]);
  assert.equal(item.view.toolKind, "execute");
  assert.equal(item.s.verb, "运行");
  assert.equal(item.s.target, "make build");
  assert.equal(item.s.body.type, "command");
});

// ══ 评审修复 2：kimi 完成事件不把结果 content 写回入参 ══
t("kimi 完成态只更新结果：入参保持最后一次真实入参，raw 展开体从留存入参构造", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "CustomTool" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { foo: "bar" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "结果文本" } }] }),
  ]);
  assert.ok(item.view.input.includes("foo"), "入参不被结果覆盖");
  assert.ok(!item.view.input.includes("结果文本"), "结果不进入入参字段");
  assert.equal(item.s.body.type, "raw");
  assert.ok(item.s.body.input.includes("foo"), "raw 展开体显示留存的原始入参");
  assert.equal(item.s.body.result, "结果文本");
});

t("kimi 终端引用更新不覆盖真实入参", () => {
  const [item] = summaries("kimi", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Bash" }),
    ev(2, "tool_call_updated", { toolCallId: "t1", toolName: "Running: ls -la", input: { command: "ls -la" } }),
    ev(3, "tool_call_updated", { toolCallId: "t1", content: [{ type: "terminal", terminalId: "term-1" }] }),
    ev(4, "tool_call_completed", { toolCallId: "t1", content: [{ type: "terminal", terminalId: "term-1" }], isError: true }),
  ]);
  assert.ok(item.view.input.includes("ls -la"), "终端引用不覆盖入参");
  assert.ok(!item.view.input.includes("terminalId"));
  assert.equal(item.s.target, "ls -la");
});

// ══ 评审修复 3：失败时展开体能看完整错误；codex 多文件 diff 逐块标路径 ══
t("读取失败：body 在路径行数之外附完整错误全文", () => {
  const [item] = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Read", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { file_path: "/work/proj/不存在.ts" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", result: "ENOENT: no such file or directory\n堆栈第二行\n堆栈第三行", isError: true }),
  ]);
  assert.equal(item.s.body.type, "read");
  assert.equal(item.s.body.error, "ENOENT: no such file or directory\n堆栈第二行\n堆栈第三行");
  assert.equal(item.s.note, "ENOENT: no such file or directory", "折叠行仍只取首行");
  assert.equal(item.s.body.lineCount, null, "失败时错误文本的行数不算文件行数");
});

t("编辑失败：diff body 附完整错误全文", () => {
  const [item] = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Edit", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "t1", input: { file_path: "/work/proj/a.ts", old_string: "x", new_string: "y" } }),
    ev(3, "tool_call_completed", { toolCallId: "t1", result: "old_string 在文件中出现了 3 次\n请提供更多上下文", isError: true }),
  ]);
  assert.equal(item.s.body.type, "diff");
  assert.equal(item.s.body.error, "old_string 在文件中出现了 3 次\n请提供更多上下文");
});

t("codex fileChange 一次改多个文件：每个 diff 块标出所属路径", () => {
  const [item] = summaries("codex", [
    ev(1, "tool_call_started", {
      toolCallId: "t1",
      toolName: "fileChange",
      input: {
        type: "fileChange",
        changes: [
          { path: "/work/proj/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old a\n+new a\n" },
          { path: "/work/proj/sub/c.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old c\n+new c\n" },
        ],
      },
    }),
    ev(2, "tool_call_completed", {
      toolCallId: "t1",
      result: {
        type: "fileChange",
        changes: [
          { path: "/work/proj/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old a\n+new a\n" },
          { path: "/work/proj/sub/c.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old c\n+new c\n" },
        ],
        status: "completed",
      },
    }),
  ]);
  assert.equal(item.s.verb, "编辑");
  assert.equal(item.s.target, "2 个文件");
  assert.equal(item.s.body.type, "diff");
  assert.deepEqual(item.s.body.chunks.map((c) => c.title), ["a.ts", "sub/c.ts"]);
  assert.deepEqual(item.s.body.chunks[0], { title: "a.ts", removed: "old a", added: "new a" });
});

// ══ 评审修复 4：未知工具不被入参形状误判 ══
t("未知工具带 command/old_string 也一律 raw 回落（动词=原名，不丢信息）", () => {
  const withCommand = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "u1", toolName: "Deployinator", input: { command: "rm -rf /" } }),
    ev(2, "tool_call_completed", { toolCallId: "u1", result: "已部署" }),
  ])[0];
  assert.equal(withCommand.s.verb, "Deployinator");
  assert.equal(withCommand.s.body.type, "raw");
  assert.ok(withCommand.s.body.input.includes("rm -rf /"));

  const withOldString = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "u2", toolName: "MysteryTool", input: { old_string: "a", new_string: "b" } }),
    ev(2, "tool_call_completed", { toolCallId: "u2", result: "ok" }),
  ])[0];
  assert.equal(withOldString.s.verb, "MysteryTool");
  assert.equal(withOldString.s.body.type, "raw");
});

// ══ 评审修复 6：Grep 附注按 output_mode 区分「处 / 个文件」，判不定省略 ══
t("Grep 附注：content 模式「N 处」、files_with_matches「N 个文件」、判不定省略", () => {
  const content = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "g1", toolName: "Grep", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "g1", input: { pattern: "TODO", output_mode: "content" } }),
    ev(3, "tool_call_completed", { toolCallId: "g1", result: "a.ts:1:x\nb.ts:2:y" }),
  ])[0];
  assert.equal(content.s.note, "2 处");

  const files = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "g2", toolName: "Grep", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "g2", input: { pattern: "TODO", output_mode: "files_with_matches" } }),
    ev(3, "tool_call_completed", { toolCallId: "g2", result: "a.ts\nb.ts\nc.ts" }),
  ])[0];
  assert.equal(files.s.note, "3 个文件");

  const undetermined = summaries("claude", [
    ev(1, "tool_call_started", { toolCallId: "g3", toolName: "Grep", input: {} }),
    ev(2, "tool_call_updated", { toolCallId: "g3", input: { pattern: "TODO" } }),
    ev(3, "tool_call_completed", { toolCallId: "g3", result: "a.ts\nb.ts" }),
  ])[0];
  assert.equal(undetermined.s.note, "", "模式判不定时省略附注");
});

if (!process.exitCode) console.log(`✅ tool-summary 单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
