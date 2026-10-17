// 消息显示截图验收（M21）：注入合成的三家会话，截 长图(查横滚) ×2 / 1280×820 / 390×844触屏 × 深浅色，
// 报页面横滚、XSS 节点、页面错误。
// 只改写本页面的 /api/sessions 与 /snapshot、WS 接空连接，不碰真实会话；需目标服务在跑。
// playwright 不是项目依赖：在任意目录 npm i playwright@1.63.0（对上 ~/.cache/ms-playwright 的 chromium_headless_shell-1243），
// 用法：PLAYWRIGHT=<该目录>/node_modules/playwright/index.mjs node frontend/scripts/msg-display-shots.mjs <输出目录>
// 环境变量：
//   BASE=目标地址，默认 http://127.0.0.1:8790；对 vite 开发服务器截图用 BASE=http://127.0.0.1:5173
//        （npm run dev，/api 代理到 8790），看到的是源码效果，不用 build。
//   UI_SCENARIOS=1 额外截工单 C 场景及 320/390/430px × 1.25 字号；原有截图和文件名保持不变。
//   FIXTURES=1 改用 frontend/scripts/fixtures/tool-events/<agent>.ndjson 的真实事件（阶段 2 工具行验收）。
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const out = process.argv[2] ?? join(tmpdir(), "aireins-msg-display-shots");
const base = process.env.BASE ?? "http://127.0.0.1:8790";
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
  const e = [ev(sid, "session_created", { agent, cwd: "/home/user/projects/workbench", config: {} })];
  e.push(ev(sid, "external_messages_added", { nativeSessionId: "x", truncated: false, messages: [
    { role: "user", text: "在别处问的：**加粗** 和 `code`", timestamp: null },
    { role: "assistant", text: "别处的回答：\n\n- 列表一\n- 列表二", timestamp: null }] }));
  e.push(ev(sid, "user_message", { text: "帮我看一下 @frontend/src/styles.css 和 @server/index.ts 然后跑测试" }));
  e.push(ev(sid, "thought_delta", { text: "" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t1", toolName: "Read", input: { file_path: "/home/user/projects/workbench/frontend/src/styles.css" } }));
  e.push(ev(sid, "tool_call_completed", { toolCallId: "t1", result: "/* 设计令牌 */\n:root { --bg: #FAF9F5; }" }));
  e.push(ev(sid, "thought_delta", { text: "先读样式文件，再跑 npm test 看看哪些断言会受「本轮结束」降噪影响。" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t2", toolName: "Bash", input: { command: "npm test" } }));
  e.push(ev(sid, "tool_call_completed", { toolCallId: "t2", isError: true, result: "❌ render-items.test.mjs\nexpected 本轮结束" }));
  for (const chunk of md.match(/[\s\S]{1,40}/g)) e.push(ev(sid, "agent_text_delta", { text: chunk }));
  e.push(ev(sid, "turn_completed", { subtype: "success", isError: false, stopReason: "end_turn", status: "completed" }));
  e.push(ev(sid, "user_message", { text: "继续，改一下" }));
  e.push(ev(sid, "tool_call_started", { toolCallId: "t3", toolName: "Grep", input: { pattern: "本轮结束" } }));
  e.push(ev(sid, "permission_request", { requestId: "g1", toolName: "Edit", input: { file_path: "/home/user/projects/workbench/frontend/src/render-items.ts", old_string: 'text: "本轮结束",', new_string: 'text: "本轮异常结束",' } }));
  e.push(ev(sid, "agent_text_delta", { text: "正在等你批准这次编辑……" }));
  const bad = { claude: { subtype: "error_during_execution", isError: true }, codex: { status: "failed", error: { message: "boom" } }, kimi: { stopReason: "cancelled" } }[agent];
  e.push(ev(sid, "turn_completed", bad));
  return e;
}
const ids = { claude: "FAKECLAUDE000000000000000A", codex: "FAKECODEX0000000000000000B", kimi: "FAKEKIMI00000000000000000C" };
/** @returns {import("../src/types.ts").SessionRecord} */
const record = (agent) => ({
  id: ids[agent], agent, agentId: "main", status: "idle", seq: 99,
  title: `Synthetic ${agent} session`, config: {}, riskyMode: false,
  createdAt: "2026-09-28T13:00:00.000Z", lastActivityAt: "2026-09-28T13:01:00.000Z",
  cwd: process.env.FIXTURES ? "/work/proj" : "/home/user/projects/workbench", transcriptPath: "/dev/null",
});
const browser = await chromium.launch();
const report = [];
// 三组视口：长图两组（整页高度，查横滚用）+ 真实桌面 1280×820 + 真实手机 390×844
// （触屏配置不可缺少，否则 pointer: coarse 样式和 TOUCH 分支都不生效）。每组都截深浅两色。
const viewports = [
  { width: 1280, height: 2600 },
  { width: 390, height: 3400 },
  { width: 1280, height: 820 },
  { width: 390, height: 844, touch: true },
];
for (const scheme of ["light", "dark"]) for (const { width: w, height: h, touch } of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1,
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (err) => errors.push(err.message));
  page.on("dialog", (d) => { errors.push("DIALOG " + d.message()); d.dismiss(); });
  await page.routeWebSocket("**/ws", () => {});
  await page.route("**/api/sessions", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: { code: 0, msg: "success", data: { sessions: Object.keys(ids).map(record) } } }) : r.continue());
  await page.route("**/api/sessions/*/snapshot*", (r) => {
    const agent = Object.keys(ids).find((a) => r.request().url().includes(ids[a]));
    // FIXTURES=1：改用 frontend/scripts/fixtures/tool-events/<agent>.ndjson 的真实事件（阶段 2 工具行验收）
    const evs = process.env.FIXTURES
      ? readFileSync(new URL(`./fixtures/tool-events/${agent}.ndjson`, import.meta.url), "utf8").trim().split("\n").map((l) => ({ ...JSON.parse(l), sessionId: ids[agent] }))
      : events(ids[agent], agent);
    r.fulfill({ json: { code: 0, msg: "success", data: { session: record(agent), seq: evs.length, events: evs } } });
  });
  for (const agent of Object.keys(ids)) {
    await page.goto(`${base}/#/session/${ids[agent]}`);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const scripts = await page.evaluate(() => document.querySelectorAll(".stream script, .stream img[onerror], .stream a[href^='javascript']").length);
    const file = `${out}/${agent}-${w}x${h}-${scheme}.png`;
    await page.screenshot({ path: file });
    report.push(`${file} overflowX=${overflow} xssNodes=${scripts} errors=${errors.length ? errors.join("|") : 0}`);
  }
  await ctx.close();
}
// 工单 C 额外场景：全部使用合成记录，不发送消息或更改真实会话。
if (process.env.UI_SCENARIOS === "1") {
  const scenes = ["empty", "gate-long-path", "running-input", "back-to-latest", "model-cwd", "title-dispatch"];
  const sizes = [{ width: 1280, height: 820 }, { width: 390, height: 844, touch: true },
    ...[320, 390, 430].map((width) => ({ width, height: 844, touch: true, large: true }))];
  const longCwd = "/home/user/projects/workbench/一个很长的项目目录/用于核对模型菜单路径";
  const longPath = `${longCwd}/${"路径需要换行的子目录/".repeat(7)}文件名必须可见.ts`;
  const sceneMeta = {
    serverVersion: "ui-fixture", defaultCwd: longCwd,
    cliVersions: { claude: "fixture", codex: "fixture", kimi: "fixture" }, capabilities: { terminal: true },
    drivers: Object.fromEntries(Object.keys(ids).map((agent) => [agent, {
      usage: false, interrupt: true, commands: true, mentions: true,
      options: [
        { id: "model", name: "模型", default: "long-model", mutable: true,
          values: [{ value: "long-model", label: `${agent} 一个很长的模型名称用于验证只截模型文字` }] },
        { id: "effort", name: "推理强度", default: "high", mutable: true,
          values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
        { id: "permissionMode", name: "审批模式", default: "auto", mutable: true,
          values: [{ value: "auto", label: "Auto" }] },
      ],
    }])),
  };
  for (const scheme of ["light", "dark"]) for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height },
      colorScheme: scheme, deviceScaleFactor: 1, ...(size.touch ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript((large) => {
      localStorage.removeItem("workbench-sidebar-collapsed");
      localStorage.setItem("workbench-font-scale", large ? "xlarge" : "default");
      localStorage.setItem("workbench-focus-view", "false");
    }, Boolean(size.large));
    let scene = "empty", agent = "claude";
    const session = () => ({ ...record(agent), title: "界面验收：很长的会话标题按屏幕中轴居中", cwd: longCwd,
      nativeSessionId: "fixture-native", processId: 12345,
      status: scene === "running-input" ? "running" : "idle", config: { model: "long-model", effort: "high", permissionMode: "auto" },
      backgroundTasks: scene === "title-dispatch" ? [{ id: "fixture-bg", type: "bash", description: "合成后台任务" }] : [],
    });
    const sceneEvents = () => {
      seq = 0;
      const e = [ev(ids[agent], "session_created", { agent, cwd: longCwd, config: session().config }),
        ev(ids[agent], "user_message", { text: "检查界面布局" })];
      if (["gate-long-path", "back-to-latest", "title-dispatch"].includes(scene)) e.push(ev(ids[agent], "permission_request", {
        requestId: "fixture-gate", toolName: "Edit", input: { file_path: longPath, old_string: "const before = 1;", new_string: "const after = 2;" },
      }));
      for (let i = 0; i < (scene === "back-to-latest" ? 40 : 1); i++) {
        e.push(ev(ids[agent], "agent_text_delta", { text: `第 ${i + 1} 段界面验收内容。\n\n${"这是一段用于检查滚动及路径布局的合成文字。".repeat(3)}` }));
        e.push(ev(ids[agent], "turn_completed", { subtype: "success", status: "completed", stopReason: "end_turn" }));
      }
      if (scene === "running-input") e.push(ev(ids[agent], "tool_call_started", { toolCallId: "fixture-running", toolName: "Bash", input: { command: "合成任务，无实际执行" } }));
      return e;
    };
    const reply = (route, data) => route.fulfill({ json: { code: 0, msg: "success", data } });
    await ctx.route("**/api/meta", (route) => reply(route, sceneMeta));
    await ctx.route("**/api/pages", (route) => reply(route, { pages: [] }));
    await ctx.route("**/api/sessions", (route) => reply(route, { sessions: scene === "empty" ? [] : [session()] }));
    await ctx.route("**/api/sessions/*/snapshot*", (route) => {
      const e = sceneEvents(); return reply(route, { session: session(), seq: seq, events: e });
    });
    await ctx.route("**/api/sessions/*/commands", (route) => reply(route, { commands: [] }));
    await ctx.route("**/api/dispatches?parent=*", (route) => reply(route, { dispatches: scene === "title-dispatch" ? [{
      runId: "fixture-dispatch", tool: "codex", name: "合成派单", model: "fixture", effort: "high", status: "running",
      startedAt: new Date().toISOString(), endedAt: null, elapsedS: 10, session: null, parent: null,
    }] : [] }));
    await ctx.routeWebSocket("**/ws", () => {});
    for (scene of scenes) for (agent of scene === "empty" || scene === "title-dispatch" ? ["claude"] : Object.keys(ids)) {
      // 每个场景新开页面：同页只改 hash 不会重取会话列表，场景状态（如 running）会沿用上一场景
      const page = await ctx.newPage();
      const errors = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/#/${scene === "empty" ? "" : `session/${ids[agent]}`}`);
      if (scene === "empty") await page.locator(".empty-state").waitFor({ state: "attached" }); // 手机首页是列表，空状态隐藏
      else await page.locator(".stream .user-block").waitFor();
      if (scene === "running-input") {
        await page.locator(".composer-box textarea").fill("继续检查布局，保留中断入口");
        await page.locator(".composer-interrupt").waitFor();
      }
      if (scene === "back-to-latest") {
        await page.locator(".stream").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
        await page.locator(".back-to-latest").waitFor();
      }
      if (scene === "model-cwd") {
        await page.locator(".cfg-pill-main > button").click();
        const menu = page.locator(".cfg-pill-main .cfg-menu");
        await menu.waitFor();
        // 只等本浮层的动画，避免会话中其他无限循环动画阻塞截图。
        await menu.evaluate(async (element) => {
          await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
        });
      }
      if (scene === "title-dispatch") await page.locator(size.touch ? ".session-dispatch-badge" : ".session-head-actions > .session-dispatch-link").waitFor();
      const file = `${out}/ui-${scene}-${agent}-${size.width}x${size.height}-${scheme}${size.large ? "-xlarge" : ""}.png`;
      const metrics = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
        const main = rect(".cfg-pill-main"), perm = rect(".cfg-pill-perm"), title = rect(".mobile-title-text");
        const menu = document.querySelector(".cfg-pill-main .cfg-menu"), menuRect = menu?.getBoundingClientRect();
        return { overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          modelWidth: main?.width, permissionWidth: perm?.width,
          menuLeft: menuRect?.left, menuRightGap: menuRect ? innerWidth - menuRect.right : undefined,
          menuOpacity: menu ? getComputedStyle(menu).opacity : undefined,
          controlsOverflow: (() => { const el = document.querySelector(".cfg-bar"); return el ? el.scrollWidth - el.clientWidth : null; })(),
          titleCenterOffset: title ? (title.left + title.right) / 2 - innerWidth / 2 : null,
          permissionClipped: (() => { const el = document.querySelector(".cfg-pill-perm .cfg-pill > span"); return el ? el.scrollWidth > el.clientWidth : null; })() };
      });
      await page.screenshot({ path: file });
      report.push(`${file} ${JSON.stringify(metrics)} errors=${errors.length ? errors.join("|") : 0}`);
      if (scene === "back-to-latest") {
        await page.locator(".back-to-latest").click();
        await page.waitForFunction(() => !document.querySelector(".back-to-latest"));
      }
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
console.log(report.join("\n"));
