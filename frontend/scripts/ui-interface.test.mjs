import coreZh from "../src/i18n/core.zh-CN.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = source("../src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const view = source("../src/components/SessionView.tsx");
const config = source("../src/components/ConfigMenu.tsx");
const rule = (selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim().split(/,\s*/).includes(selector)).map(([, , body]) => body).join("\n");

test("R：末尾追加 refine 命令，去末尾空白且不重复，空输入保持原样", async () => {
  const { appendRefineCommand } = await import("../src/session-ui.ts");
  for (const command of ["/refine-prompt", "$refine-prompt"]) {
    assert.equal(appendRefineCommand("普通文本", command), `普通文本\n${command}`);
    assert.equal(appendRefineCommand("普通文本 \n\t", command), `普通文本\n${command}`);
    assert.equal(appendRefineCommand(`普通文本\n${command}`, command), `普通文本\n${command}`);
    assert.equal(appendRefineCommand(`普通文本\n${command} \n`, command), `普通文本\n${command}`);
    assert.equal(appendRefineCommand("", command), "");
    assert.equal(appendRefineCommand(" \n", command), " \n");
  }
});

test("D1：单行标题优先占宽，cwd 末两段且不使用 bidi", async () => {
  const { compactCwd } = await import("../src/session-ui.ts");
  for (const [path, expected] of [["/home/user/projects/workbench", "…/projects/workbench"], ["/a/b", "/a/b"], ["/", "/"], ["C:\\Users\\user\\repo", "…/user/repo"]]) assert.equal(compactCwd(path), expected);
  assert.match(view, /className="session-title"/);
  assert.match(rule(".session-title"), /flex:\s*1/);
  assert.match(rule(".session-model"), /max-width:\s*35%/);
  assert.doesNotMatch(rule(".session-cwd"), /direction:\s*rtl/);
});
test("D2：共享桌面圆钮覆盖顶栏及面板", () => {
  assert.match(rule(".chrome-icon-btn"), /width:\s*32px/);
  for (const file of ["SessionView", "PanelActions", "TerminalPanel", "FilePanel", "DispatchPanel", "Sidebar"]) assert.match(source(`../src/components/${file}.tsx`), /chrome-icon-btn/);
});
test("D3：侧栏让宽、时间和计数等宽数字", () => {
  assert.match(rule(".sidebar"), /width:\s*304px/);
  assert.match(rule(".row-time"), /min-width:\s*3\.25em/);
  assert.match(rule(".gate-badge"), /font-variant-numeric:\s*tabular-nums/);
});
test("D4：空状态只有标题、行动说明和按钮", () => {
  const app = source("../src/App.tsx");
  assert.ok(app.includes('t("core.001")'));
  assert.equal(coreZh["core.001"], "选一个会话，或新建一个");
  assert.doesNotMatch(app, /暖色只出现在/);
  assert.match(rule(".empty-state"), /max-width:\s*360px/);
  assert.match(rule(".empty-state h1"), /font-size:\s*16px/);
  // 审批胶囊不被长模型名挤成只剩图标
  assert.match(rule(".cfg-pills > .cfg-pill-wrap + .cfg-pill-wrap"), /flex-shrink:\s*0/);
  // 空状态 logo：wb 缩写 + 竖线 + workbench 整体放大显示
  assert.match(rule(".empty-state .empty-logo"), /display:\s*inline-flex/);
  assert.match(rule(".empty-logo-mark"), /44px/);
  assert.match(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), /empty-logo-mark[\s\S]*empty-logo-line[\s\S]*empty-logo-name/);
});
test("D5：桌面派单胶囊收进顶栏，手机横带另留", () => {
  assert.match(view.slice(view.indexOf('<header'), view.indexOf('</header>')), /SessionDispatchLink/);
  assert.match(rule(".session-head-actions > .session-dispatch-link"), /border-radius:\s*999px/);
  assert.match(rule(".session > .session-dispatch-link"), /display:\s*none/);
});
test("U1：长闸门路径换行并完整保留", () => {
  const body = rule(".gate-path");
  assert.match(body, /white-space:\s*normal/); assert.match(body, /overflow-wrap:\s*anywhere/); assert.match(body, /line-height:\s*1\.45/); assert.match(body, /font-size:\s*var\(--detail-font-size\)/);
});
test("U2：手机深色发送箭头改深底色，身份填充保留", () => {
  assert.match(rule(".cfg-bar .send-btn"), /color:\s*light-dark\(#fff,\s*var\(--bg\)\)/);
  for (const agent of ["codex", "kimi"]) assert.match(rule(`.agent-${agent} .cfg-bar .send-btn`), new RegExp(`background(?:-color)?:\\s*var\\(--agent-${agent}\\)`));
});
test("U3：触屏折叠按钮补 44px 命中区而不改视觉高度", () => {
  for (const cls of ["tool-head", "thought-head", "gate-fold"]) assert.match(rule(`.${cls}::after`), /min-height:\s*44px/);
});
test("U4：减少动态效果包含旋转和滑动", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.new-session-icon,\s*\.session-item \.session-row\s*\{\s*transition:\s*none/);
});
test("U5：异常显示中文，原始码放 SystemLine title", () => {
  assert.match(source("../src/components/StreamItems.tsx"), /title=\{item\.rawCode\}/);
});
test("U6：侧栏刷新和折叠使用 20px SVG", () => {
  const sidebar = source("../src/components/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /↻|«|»/); assert.match(sidebar, /width="20" height="20"/);
});
test("M1：模型胶囊保留完整 title（手机伸展布局 10-03 用户要求撤回）", () => {
  assert.match(config, /className="cfg-pill-model"/); assert.match(config, /fullText/);
});
test("M2：超过 120px 显示回到最新，两端可用且不轮询", async () => {
  const { awayFromLatest } = await import("../src/session-ui.ts");
  assert.equal(awayFromLatest(1000, 280, 600), false);
  assert.equal(awayFromLatest(1000, 279, 600), true);
  assert.match(view, /className="back-to-latest"/); assert.match(rule(".back-to-latest"), /height:\s*36px/);
  assert.match(rule(".back-to-latest::after"), /min-height:\s*44px/);
});
test("M3：标题按中轴居中，有派单和徽标时对称让位", () => {
  assert.match(rule(".mobile-title"), /position:\s*absolute/);
  assert.match(css, /\.session-head:has\(\.session-dispatch-badge\)/);
  assert.match(css, /\.session-head:has\(\.mobile-tail\)/);
});
test("C1：浮层与外框在深色主题分层", () => {
  assert.match(css, /--surface:\s*light-dark\(#FFFFFF, #2A2926\)/);
  assert.match(css, /--chrome:\s*light-dark\(#F0EEE6, #262624\)/);
});
test("C2：运行中输入有字时可单独中断，空白保持原入口", async () => {
  const { showComposerInterrupt } = await import("../src/session-ui.ts");
  assert.equal(showComposerInterrupt("running", true, 42, "继续"), true);
  for (const args of [["idle", true, 42, "继续"], ["running", false, 42, "继续"], ["running", true, undefined, "继续"], ["running", true, 42, "  "]]) assert.equal(showComposerInterrupt(...args), false);
  assert.match(view, /className="composer-interrupt"/);
  assert.match(rule(".composer-interrupt"), /width:\s*30px/); assert.doesNotMatch(rule(".composer-interrupt"), /--gate|--danger/);
});
test("C4：手机模型浮层展示 14px 完整 cwd", () => {
  assert.match(config, /className="cfg-menu-cwd mono"/); assert.match(view, /cwd=\{session\.cwd\}/);
  assert.match(rule(".cfg-menu-cwd"), /font-size:\s*14px/);
});
test("截图场景：覆盖空状态、长路径闸门、运行中断、回到最新及窄屏大字号", () => {
  const shots = source("./msg-display-shots.mjs");
  for (const scene of ["empty", "gate-long-path", "running-input", "back-to-latest", "model-cwd", "title-dispatch"]) assert.ok(shots.includes(`"${scene}"`), scene);
  assert.match(shots, /\[320, 390, 430\]/); assert.match(shots, /workbench-font-scale.*xlarge/);
});
test("M1/C2：极窄输入区为固定宽控件让位，胶囊保持 30px", () => {
  assert.match(rule(".composer-box"), /container:\s*composer\s*\/\s*inline-size/);
  assert.match(css, /@container composer \(max-width: 280px\)/);
  assert.match(rule(".cfg-bar .cfg-pills"), /flex-basis:\s*100%/);
  assert.match(rule(".cfg-bar .cfg-pill"), /min-height:\s*30px/);
});

// 媒体范围也属于契约；只汇总选择器会漏掉手机规则污染桌面的回归。
const scopedRules = [];
const scopeStack = [];
for (const match of css.matchAll(/([^{}]*)[{}]/g)) {
  if (match[0].endsWith("{")) scopeStack.push(match[1].trim());
  else {
    const selector = scopeStack.pop();
    if (selector && !selector.startsWith("@")) scopedRules.push({ selector, body: match[1], scopes: [...scopeStack] });
  }
}
const mobileRule = (selector) => scopedRules.filter((r) => r.selector.split(/,\s*/).includes(selector)
  && r.scopes.includes("@media (max-width: 720px)")).map((r) => r.body).join("\n");
const sharedRule = (selector) => scopedRules.filter((r) => r.selector.split(/,\s*/).includes(selector)
  && r.scopes.length === 0).map((r) => r.body).join("\n");
const desktopRule = (selector) => scopedRules.filter((r) => r.selector.split(/,\s*/).includes(selector)
  && r.scopes.includes("@media (min-width: 721px)")).map((r) => r.body).join("\n");

test("桌面底栏1：模型与审批共享 30px 浅底胶囊，模型按内容宽、审批靠右", () => {
  for (const selector of [".cfg-bar .cfg-pill", ".cfg-bar .cfg-pill:hover:not(:disabled)", ".cfg-bar .cfg-pill.open"]) {
    const body = sharedRule(selector);
    assert.match(body, /min-height:\s*30px/);
    assert.match(body, /padding:\s*0 8px/);
    assert.match(body, /gap:\s*3px/);
    assert.match(body, /border-radius:\s*999px/);
    assert.match(body, /font-weight:\s*400/);
    assert.match(body, /background:\s*color-mix\(in srgb, var\(--text\) 9%, var\(--surface\)\)/);
    assert.doesNotMatch(mobileRule(selector), /background:|border-radius:|padding:|min-height:/);
  }
  assert.match(sharedRule(".cfg-pill-sub"), /color:\s*var\(--text-faint\)/);
  assert.match(sharedRule(".cfg-pills > .cfg-pill-wrap + .cfg-pill-wrap"), /margin-left:\s*auto/);
});

test("桌面底栏2：发送与空输入中断共享圆形身份色，桌面直径 32px", () => {
  const body = sharedRule(".cfg-bar .send-btn");
  assert.match(body, /border-radius:\s*50%/);
  assert.match(body, /background(?:-color)?:\s*var\(--agent-claude\)/);
  assert.match(body, /color:\s*light-dark\(#fff,\s*var\(--bg\)\)/);
  for (const agent of ["codex", "kimi"]) assert.match(sharedRule(`.agent-${agent} .cfg-bar .send-btn`), new RegExp(`background(?:-color)?:\\s*var\\(--agent-${agent}\\)`));
  assert.match(desktopRule(".cfg-bar .send-btn"), /width:\s*32px/);
  assert.match(desktopRule(".cfg-bar .send-btn"), /height:\s*32px/);
  assert.match(desktopRule(".cfg-bar .send-btn svg"), /width:\s*20px/);
  assert.match(desktopRule(".cfg-bar .send-btn svg"), /height:\s*20px/);
  assert.match(sharedRule(".cfg-bar .send-btn svg"), /stroke-width:\s*2\.5/);
  assert.doesNotMatch(mobileRule(".cfg-bar .send-btn"), /background:|border-radius:|color:/);
  assert.equal((view.match(/className="send-btn"/g) ?? []).length, 2);
  assert.match(sharedRule(".send-btn:disabled"), /opacity:\s*0\.4/);
});

test("桌面底栏3：独立中断钮用身份色，手机中断钮与命中区保留", () => {
  const body = desktopRule(".cfg-bar .composer-interrupt");
  assert.match(body, /background:\s*var\(--agent-claude\)/);
  assert.match(body, /color:\s*light-dark\(#fff,\s*var\(--bg\)\)/);
  for (const agent of ["codex", "kimi"]) assert.match(desktopRule(`.agent-${agent} .cfg-bar .composer-interrupt`), new RegExp(`background(?:-color)?:\\s*var\\(--agent-${agent}\\)`));
  assert.match(desktopRule(".cfg-bar .composer-interrupt::after"), /content:\s*none/);
  assert.match(sharedRule(".composer-interrupt"), /width:\s*30px/);
  assert.match(sharedRule(".composer-interrupt"), /border-radius:\s*50%/);
  assert.match(sharedRule(".composer-interrupt"), /background:\s*var\(--surface-sunk\)/);
  assert.match(sharedRule(".composer-interrupt::after"), /min-height:\s*44px/);
  assert.match(mobileRule(".cfg-bar .cfg-pill::after"), /inset:\s*-7px 0/);
  assert.match(mobileRule(".cfg-bar .send-btn svg"), /width:\s*22px/);
  assert.match(mobileRule(".cfg-bar .send-btn svg"), /height:\s*22px/);
});

test("返工1-1：模型胶囊任何宽度都不伸展，「模型 强度」紧凑、审批靠右（用户 10-03 定）", () => {
  for (const selector of [".cfg-pill-main", ".cfg-pill-model", ".cfg-pill-main > .cfg-pill"]) {
    assert.ok(!scopedRules.some((r) => r.selector.split(/,\s*/).includes(selector) && /flex:\s*1\b|width:\s*100%/.test(r.body)), selector);
  }
});
test("返工1-2：手机滑块菜单定宽且受视口约束，标签与滑块分行", () => {
  const menu = mobileRule(".cfg-bar .cfg-menu:has(.cfg-slider-row)");
  assert.match(menu, /width:\s*min\(300px,/);
  assert.match(menu, /100vw\s*-\s*16px/);
  assert.match(menu, /var\(--font-scale\)/);
  assert.match(mobileRule(".cfg-bar .cfg-slider-row"), /display:\s*grid/);
  assert.match(mobileRule(".cfg-bar .cfg-slider-label"), /white-space:\s*nowrap/);
  assert.match(mobileRule(".cfg-bar .cfg-slider"), /grid-column:\s*1\s*\/\s*-1/);
  assert.match(mobileRule(".cfg-bar .cfg-slider"), /width:\s*100%/);
});
test("返工1-3：浮层宽度减去定位偏移，不能造成底栏 6px 溢出", () => {
  const menu = mobileRule(".cfg-bar .cfg-menu");
  assert.match(menu, /min-width:\s*0/);
  assert.match(menu, /100%\s*-\s*12px/);
  assert.match(mobileRule(".cfg-bar .cfg-menu:has(.cfg-slider-row)"), /100%\s*-\s*12px/);
  assert.doesNotMatch(rule(".cfg-bar"), /overflow(?:-x)?:\s*hidden/);
});
test("返工1-4：模型菜单拍摄前等待动画完成，保留逐场景新页面和 attached 等待", () => {
  const shots = source("./msg-display-shots.mjs");
  const start = shots.indexOf('if (scene === "model-cwd")');
  const block = shots.slice(start, shots.indexOf('if (scene === "title-dispatch")', start));
  assert.match(block, /getAnimations\(\{\s*subtree:\s*true\s*\}\)/);
  assert.match(block, /await Promise\.all/);
  assert.match(block, /animation\.finished/);
  assert.match(shots, /for \(scene of scenes\)[\s\S]*?const page = await ctx\.newPage\(\)/);
  assert.match(shots, /\.empty-state"\)\.waitFor\(\{ state: "attached" \}\)/);
});
