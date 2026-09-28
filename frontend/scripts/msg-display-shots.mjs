// 消息显示截图验收（M21）：注入合成的三家会话，截 1280/390 × 深浅色，报页面横滚、XSS 节点、页面错误。
// 只改写本页面的 /api/sessions 与 /snapshot、WS 接空连接，不碰真实会话；需 8790 在跑。
// playwright 不是项目依赖：在任意目录 npm i playwright@1.63.0（对上 ~/.cache/ms-playwright 的 chromium_headless_shell-1243），
// 用法：PLAYWRIGHT=<该目录>/node_modules/playwright/index.mjs node frontend/scripts/msg-display-shots.mjs <输出目录>
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const out = process.argv[2] ?? "shots";
const base = "http://127.0.0.1:8790";
const md = `## 改动摘要

已把 **Markdown 渲染** 接进消息流，要点：

1. 助手文字走 \`react-markdown\` + \`remark-gfm\`
2. 链接如 [VSCode 文档](https://code.visualstudio.com) 新窗口打开
   - 嵌套列表项
   - 另一项含 \`frontend/src/components/StreamItems.tsx\`

> 引用：闸门卡片仍独占琥珀金。

| 文件 | 改动 | 说明 |
|---|---:|---|
| StreamItems.tsx | +120 −40 | 时间线与 Markdown |
| styles.css | +80 −12 | 令牌与版式 |

\`\`\`ts
export function renderMarkdown(text: string): string {
  const veryLongLine = "这一行故意写得很长用来测试代码块是否只在块内横向滚动而不会撑开整个页面的宽度 ".repeat(3);
  return text.trim() + veryLongLine;
}
\`\`\`

软换行：第一行\n第二行\n第三行

XSS 探针：<script>alert(1)</script> <img src=x onerror=alert(1)> [坏链接](javascript:alert(1))`;
let seq = 0;
const ev = (sid, type, payload) => ({ type, sessionId: sid, agentId: "main", seq: ++seq, timestamp: new Date(Date.UTC(2026, 8, 28, 13, 0, seq)).toISOString(), payload });
function events(sid, agent) {
  seq = 0;
  const e = [ev(sid, "session_created", { agent, cwd: "/home/user/dev/workbench", config: {} })];
  e.push(ev(sid, "external_messages_added", { nativeSessionId: "x", truncated: false, messages: [
    { role: "user", text: "在别处问的：**加粗** 和 `code`", timestamp: null },
    { role: "assistant", text: "别处的回答：\n\n- 列表一\n- 列表二", timestamp: null }] }));
  e.push(ev(sid, "user_message", { text: "帮我看一下 @frontend/src/styles.css 和 @server/index.ts 然后跑测试" }));
  e.push(ev(sid, "thought_delta", { text: "" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t1", toolName: "Read", input: { file_path: "/home/user/dev/workbench/frontend/src/styles.css" } }));
  e.push(ev(sid, "tool_call_completed", { toolCallId: "t1", result: "/* 设计令牌 */\n:root { --bg: #FAF9F5; }" }));
  e.push(ev(sid, "thought_delta", { text: "先读样式文件，再跑 npm test 看看哪些断言会受「本轮结束」降噪影响。" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t2", toolName: "Bash", input: { command: "npm test" } }));
  e.push(ev(sid, "tool_call_completed", { toolCallId: "t2", isError: true, result: "❌ render-items.test.mjs\nexpected 本轮结束" }));
  for (const chunk of md.match(/[\s\S]{1,40}/g)) e.push(ev(sid, "agent_text_delta", { text: chunk }));
  e.push(ev(sid, "turn_completed", { subtype: "success", isError: false, stopReason: "end_turn", status: "completed" }));
  e.push(ev(sid, "user_message", { text: "继续，改一下" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t3", toolName: "Grep", input: { pattern: "本轮结束" } }));
  e.push(ev(sid, "permission_request", { requestId: "g1", toolName: "Edit", input: { file_path: "/home/user/dev/workbench/frontend/src/render-items.ts", old_string: 'text: "本轮结束",', new_string: 'text: "本轮异常结束",' } }));
  e.push(ev(sid, "agent_text_delta", { text: "正在等你批准这次编辑……" }));
  const bad = { claude: { subtype: "error_during_execution", isError: true }, codex: { status: "failed", error: { message: "boom" } }, kimi: { stopReason: "cancelled" } }[agent];
  e.push(ev(sid, "turn_completed", bad));
  return e;
}
const ids = { claude: "FAKECLAUDE000000000000000A", codex: "FAKECODEX0000000000000000B", kimi: "FAKEKIMI00000000000000000C" };
const real = (await (await fetch(`${base}/api/sessions`)).json()).data.sessions[0];
const record = (agent) => ({ ...real, id: ids[agent], agent, status: "idle", seq: 99, cwd: "/home/user/dev/workbench", transcriptPath: "/dev/null" });
const browser = await chromium.launch();
const report = [];
for (const scheme of ["light", "dark"]) for (const [w, h] of [[1280, 2600], [390, 3400]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (err) => errors.push(err.message));
  page.on("dialog", (d) => { errors.push("DIALOG " + d.message()); d.dismiss(); });
  await page.routeWebSocket("**/ws", () => {});
  await page.route("**/api/sessions", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: { code: 0, msg: "success", data: { sessions: Object.keys(ids).map(record) } } }) : r.continue());
  await page.route("**/api/sessions/*/snapshot", (r) => {
    const agent = Object.keys(ids).find((a) => r.request().url().includes(ids[a]));
    const evs = events(ids[agent], agent);
    r.fulfill({ json: { code: 0, msg: "success", data: { session: record(agent), seq: evs.length, events: evs } } });
  });
  for (const agent of Object.keys(ids)) {
    await page.goto(`${base}/#/session/${ids[agent]}`);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const scripts = await page.evaluate(() => document.querySelectorAll(".stream script, .stream img[onerror], .stream a[href^='javascript']").length);
    const file = `${out}/${agent}-${w}-${scheme}.png`;
    await page.screenshot({ path: file });
    report.push(`${file} overflowX=${overflow} xssNodes=${scripts} errors=${errors.length ? errors.join("|") : 0}`);
  }
  await ctx.close();
}
await browser.close();
console.log(report.join("\n"));
