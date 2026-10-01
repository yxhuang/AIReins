// 仅访问现有会话；不发送消息、不确认移除、不创建终端进程。
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import("../../scratch/pw/node_modules/playwright/index.mjs");
const base = "http://127.0.0.1:8790";
const shots = new URL("../../scratch/fe-batch/", import.meta.url).pathname;
await mkdir(shots, { recursive: true });
let browser;
try {
  browser = await chromium.launch();
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktop.goto(base, { timeout: 12000 });
  await desktop.waitForSelector(".sidebar", { timeout: 12000 });
  const sessions = await desktop.evaluate(async () => (await (await fetch("/api/sessions")).json()).data.sessions);
  assert.ok(sessions.length, "需要一个现有会话");
  let session;
  for (const candidate of sessions) {
    const snapshot = await desktop.evaluate(async (id) => (await (await fetch(`/api/sessions/${encodeURIComponent(id)}/snapshot`)).json()).data, candidate.id);
    const text = snapshot.events.map((event) => Object.values(event.payload).filter((value) => typeof value === "string").join("\n")).join("");
    if (!text.includes("```")) continue;
    await desktop.goto(`${base}/#/session/${candidate.id}`);
    await desktop.waitForSelector(".composer-box textarea");
    try {
      await desktop.locator(".stream .markdown-code-block code[class*=language-]").first().waitFor({ timeout: 4000 });
      session = candidate;
      break;
    } catch { /* 含围栏字符串但未渲染为代码块，继续找历史会话 */ }
  }
  assert.ok(session, "现有会话没有找到带语言标注的围栏代码；不可伪造截图");
  const sessionUrl = `${base}/#/session/${session.id}`;
  const code = desktop.locator(".stream .markdown-code-block:has(code[class*=language-])").first();
  const screenshot = (page, name) => page.screenshot({ path: `${shots}${name}.png` });
  const settings = desktop.locator(".settings-panel");
  await desktop.getByRole("button", { name: "设置", exact: true }).click();
  await settings.locator("#settings-body-font").fill("16");
  await screenshot(desktop, "desktop-settings");
  await desktop.getByRole("button", { name: "设置", exact: true }).click();
  for (const theme of ["light", "dark"]) {
    await desktop.evaluate((value) => {
      localStorage.setItem("workbench-theme", value);
      document.documentElement.dataset.theme = value;
    }, theme);
    await code.scrollIntoViewIfNeeded();
    await screenshot(desktop, `desktop-${theme}`);
  }
  // 正文与 chrome 的字号分开；每档都实际点选并验证，包含刷新持久化。
  await desktop.evaluate(() => { localStorage.setItem("workbench-theme", "light"); document.documentElement.dataset.theme = "light"; });
  const inputBefore = await desktop.locator(".composer-box textarea").evaluate((el) => getComputedStyle(el).fontSize);
  for (const size of [14, 15.5, 16, 18, 20]) {
    await desktop.getByRole("button", { name: "设置", exact: true }).click();
    await settings.locator("#settings-body-font").fill(String(size));
    await desktop.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal(await code.locator("pre").evaluate((el) => getComputedStyle(el).fontSize), `${Math.max(14, size - 2)}px`);
    assert.equal(await desktop.locator(".composer-box textarea").evaluate((el) => getComputedStyle(el).fontSize), inputBefore);
  }
  await desktop.reload();
  await desktop.waitForSelector(".composer-box textarea");
  assert.equal(await code.locator("pre").evaluate((el) => getComputedStyle(el).fontSize), "18px");
  await code.scrollIntoViewIfNeeded();
  await screenshot(desktop, "desktop-body22");
  assert.equal(await desktop.locator(".mobile-topbar").isVisible(), false);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  // 终端 UI 路径可测；阻断进程接口，防止测试启动任何 shell。
  await mobile.route("**/api/terminals**", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: 403, msg: "浏览器测试不创建终端进程", data: null }) }));
  await mobile.route("**/api/sessions/**", (route) => route.request().method() === "DELETE" ? route.abort() : route.continue());
  await mobile.goto(sessionUrl);
  await mobile.waitForSelector(".composer-box textarea");
  await screenshot(mobile, "mobile-topbar");
  await mobile.locator(".session-head").getByRole("button", { name: "AI 用量", exact: true }).click();
  await mobile.getByRole("button", { name: "收起AI 用量", exact: true }).waitFor();
  await screenshot(mobile, "mobile-usage");
  await mobile.getByRole("button", { name: "收起AI 用量", exact: true }).click();
  assert.equal(new URL(mobile.url()).hash, `#/session/${session.id}`);
  await mobile.locator(".session-head").getByRole("button", { name: "终端", exact: true }).click();
  await mobile.locator(".term-panel").waitFor();
  assert.equal(await mobile.locator(".main").isVisible(), false);
  await mobile.locator(".term-back").click();
  assert.equal(new URL(mobile.url()).hash, `#/session/${session.id}`);
  assert.equal(await mobile.locator(".mobile-back").isVisible(), true);
  await mobile.locator(".mobile-back").click();
  if (await mobile.locator(".session-row").count() < 2) await mobile.locator(".session-dead-toggle").click();
  const rows = mobile.locator(".session-row");
  assert.ok(await rows.count() >= 2, "单行互斥测试需要至少两个现有会话");
  const touch = async (row, dx, dy, cancel = false) => row.evaluate((el, { dx, dy, cancel }) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(200, rect.width - 20), y = rect.top + rect.height / 2;
    const dispatch = (type, offsetX, offsetY) => {
      const item = new Touch({ identifier: 1, target: el, clientX: x + offsetX, clientY: y + offsetY });
      const end = type === "touchend" || type === "touchcancel";
      const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [item], targetTouches: end ? [] : [item], changedTouches: [item] });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    dispatch("touchstart", 0, 0);
    const prevented = dispatch("touchmove", dx, dy);
    dispatch(cancel ? "touchcancel" : "touchend", dx, dy);
    return prevented;
  }, { dx, dy, cancel });
  const first = rows.nth(0), second = rows.nth(1);
  assert.equal(await touch(first, -4, 70), false, "竖向移动保留默认滚动");
  assert.equal(await mobile.locator(".session-swipe-open").count(), 0);
  assert.equal(await touch(first, -70, 4), true, "横向锁定后才阻止默认动作");
  await mobile.locator(".session-swipe-open").waitFor();
  await screenshot(mobile, "mobile-swipe");
  await touch(second, -70, 2);
  assert.equal(await mobile.locator(".session-swipe-open").count(), 1);
  assert.equal(await second.evaluate((el) => el.parentElement.classList.contains("session-swipe-open")), true);
  await mobile.locator(".sidebar-session-area").evaluate((el) => el.dispatchEvent(new Event("scroll")));
  assert.equal(await mobile.locator(".session-swipe-open").count(), 0);
  await touch(first, -70, 2);
  await mobile.locator(".brand").tap();
  assert.equal(await mobile.locator(".session-swipe-open").count(), 0);
  await touch(first, -70, 2, true);
  assert.equal(await mobile.locator(".session-swipe-open").count(), 0);
  // 长按仍显示菜单；移除只到二次确认，绝不点击最终确认。
  await first.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  await mobile.locator(".row-menu").waitFor({ timeout: 1500 });
  await first.dispatchEvent("pointerup", { pointerType: "touch" });
  await mobile.keyboard.press("Escape");
  await touch(first, -70, 2);
  await mobile.locator(".session-swipe-open .session-swipe-remove").tap();
  await mobile.locator(".session-confirm").waitFor();
  await screenshot(mobile, "mobile-confirm");
  assert.match(await mobile.locator(".session-confirm").innerText(), /自己的对话记录不会被删除/);
  await mobile.locator(".session-confirm").getByRole("button", { name: "取消", exact: true }).click();
  await rows.first().dispatchEvent("contextmenu", { clientX: 0, clientY: 0 });
  await mobile.locator(".row-menu").waitFor();
  await mobile.keyboard.press("Escape");
  console.log("OK 手机顶栏返回、触屏方向锁/互斥/点外/滚动/取消、长按/行菜单、正文字号与持久化；8 张截图");
} catch (error) {
  console.error(`BLOCKED Playwright / 截图未跑完: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
