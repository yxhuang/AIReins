#!/usr/bin/env node
// terminal.ts（面板宽度 clamp / 快捷键栏按键→控制序列 / /ws/terminal 下行帧归约 / WS URL）纯逻辑单测。
import { strict as assert } from "node:assert";

const {
  isTerminalToggleKey,
  TERM_MIN_WIDTH,
  TERM_MAIN_MIN_WIDTH,
  TERM_DEFAULT_WIDTH,
  TERM_SHORTCUT_KEYS,
  buildTerminalWsUrl,
  clampPanelWidth,
  initialTermState,
  pickAttachTarget,
  pickTerminalCwd,
  reduceTermFrame,
} = await import("../src/terminal.ts");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } };

t("Ctrl+Backquote requires exactly Ctrl and physical Backquote", () => {
  const key = { ctrlKey: true, code: "Backquote", altKey: false, metaKey: false, shiftKey: false };
  assert.equal(isTerminalToggleKey(key), true);
  for (const modifier of ["altKey", "metaKey", "shiftKey"]) {
    assert.equal(isTerminalToggleKey({ ...key, [modifier]: true }), false);
  }
  assert.equal(isTerminalToggleKey({ ...key, ctrlKey: false }), false);
  assert.equal(isTerminalToggleKey({ ...key, code: "KeyQ" }), false);
});

// ══ clampPanelWidth ══
t("clamp：区间内原样保留", () => {
  assert.equal(clampPanelWidth(800, 1600), 800);
  assert.equal(clampPanelWidth(TERM_MIN_WIDTH, 1600), TERM_MIN_WIDTH);
});

t("clamp：低于下限收 320，超过上限收「视口宽 − 480」", () => {
  assert.equal(clampPanelWidth(100, 1600), TERM_MIN_WIDTH);
  assert.equal(clampPanelWidth(2000, 1600), 1600 - TERM_MAIN_MIN_WIDTH);
});

t("clamp：视口过窄（上限 < 下限）按下限收口，面板不消失", () => {
  // 600 - 480 = 120 < 320：宁挤主区也要保住面板可用宽度
  assert.equal(clampPanelWidth(500, 600), TERM_MIN_WIDTH);
  assert.equal(clampPanelWidth(100, 600), TERM_MIN_WIDTH);
  // 边界：800 - 480 = 320，上下限重合
  assert.equal(clampPanelWidth(9999, TERM_MIN_WIDTH + TERM_MAIN_MIN_WIDTH), TERM_MIN_WIDTH);
});

t("clamp：非有限输入（坏 localStorage 数据）回默认宽度再 clamp", () => {
  assert.equal(clampPanelWidth(NaN, 1600), TERM_DEFAULT_WIDTH);
  assert.equal(clampPanelWidth(Infinity, 1600), TERM_DEFAULT_WIDTH);
  // 默认宽度超出上限时也要收住
  assert.equal(clampPanelWidth(NaN, 700), TERM_MIN_WIDTH);
});

t("clamp：小数取整", () => {
  assert.equal(clampPanelWidth(513.6, 1600), 514);
});

// ══ 快捷键栏按键 → 控制序列 ══
t("快捷键栏：八个键的控制序列逐字正确", () => {
  const byId = Object.fromEntries(TERM_SHORTCUT_KEYS.map((k) => [k.id, k.seq]));
  assert.deepEqual(byId, {
    "esc": "\x1b",
    "tab": "\t",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "left": "\x1b[D",
    "right": "\x1b[C",
  });
  // 顺序即界面顺序：Esc、Tab、Ctrl-C、Ctrl-D、↑、↓、←、→
  assert.deepEqual(
    TERM_SHORTCUT_KEYS.map((k) => k.label),
    ["Esc", "Tab", "Ctrl-C", "Ctrl-D", "↑", "↓", "←", "→"],
  );
});

// ══ buildTerminalWsUrl ══
t("WS URL：http → ws，https → wss（远程入口）", () => {
  assert.equal(buildTerminalWsUrl("http:", "127.0.0.1:8790"), "ws://127.0.0.1:8790/ws/terminal");
  assert.equal(buildTerminalWsUrl("https:", "nas.tailnet.ts.net"), "wss://nas.tailnet.ts.net/ws/terminal");
});

// ══ reduceTermFrame ══
const fx = (out) => out.effects.map((e) => e.type);

t("attached：reset 副作用 + omitted 入状态", () => {
  const out = reduceTermFrame(initialTermState(), "t1", { type: "attached", terminalId: "t1", omitted: 1234 });
  assert.deepEqual(fx(out), ["reset"]);
  assert.equal(out.state.attached, true);
  assert.equal(out.state.omitted, 1234);
  assert.equal(out.state.exited, false);
});

t("data：attached 之后才追加；attached 之前的 data 忽略", () => {
  const early = reduceTermFrame(initialTermState(), "t1", { type: "data", terminalId: "t1", data: "太早" });
  assert.deepEqual(fx(early), []);
  const attached = reduceTermFrame(initialTermState(), "t1", { type: "attached", terminalId: "t1", omitted: 0 });
  const wrote = reduceTermFrame(attached.state, "t1", { type: "data", terminalId: "t1", data: "hello\r\n" });
  assert.deepEqual(fx(wrote), ["write"]);
  assert.equal(wrote.effects[0].data, "hello\r\n");
});

t("重复 attach 同一 id：再次 reset（重新回放语义），omitted 归零", () => {
  let s = reduceTermFrame(initialTermState(), "t1", { type: "attached", terminalId: "t1", omitted: 99 }).state;
  s = reduceTermFrame(s, "t1", { type: "data", terminalId: "t1", data: "x" }).state;
  const again = reduceTermFrame(s, "t1", { type: "attached", terminalId: "t1", omitted: 0 });
  assert.deepEqual(fx(again), ["reset"]);
  assert.equal(again.state.omitted, 0);
});

t("exit：标记退出与退出码；缺 exitCode 记 null", () => {
  const attached = reduceTermFrame(initialTermState(), "t1", { type: "attached", terminalId: "t1" });
  const out = reduceTermFrame(attached.state, "t1", { type: "exit", terminalId: "t1", exitCode: 3 });
  assert.deepEqual(fx(out), ["exited"]);
  assert.equal(out.state.exited, true);
  assert.equal(out.state.exitCode, 3);
  const noCode = reduceTermFrame(attached.state, "t1", { type: "exit", terminalId: "t1" });
  assert.equal(noCode.state.exited, true);
  assert.equal(noCode.state.exitCode, null);
});

t("未知 terminalId 的帧一律忽略（attached/data/exit）", () => {
  const s0 = initialTermState();
  for (const frame of [
    { type: "attached", terminalId: "other", omitted: 1 },
    { type: "data", terminalId: "other", data: "x" },
    { type: "exit", terminalId: "other", exitCode: 0 },
  ]) {
    const out = reduceTermFrame(s0, "t1", frame);
    assert.equal(out.state, s0, `${frame.type} 不得改动状态`);
    assert.deepEqual(out.effects, []);
  }
});

t("error：terminalId 缺省或匹配才转提示，其他终端的 error 忽略", () => {
  const s0 = initialTermState();
  const global = reduceTermFrame(s0, "t1", { type: "error", message: " boom " });
  assert.deepEqual(fx(global), ["error"]);
  const own = reduceTermFrame(s0, "t1", { type: "error", terminalId: "t1", message: "已退出" });
  assert.deepEqual(fx(own), ["error"]);
  assert.equal(own.effects[0].message, "已退出");
  const other = reduceTermFrame(s0, "t1", { type: "error", terminalId: "other", message: "别的事" });
  assert.deepEqual(other.effects, []);
});

t("垃圾帧（非对象 / 无 type / 未知 type）不产生副作用", () => {
  const s0 = initialTermState();
  for (const frame of [null, 42, "x", {}, { type: "mystery", terminalId: "t1" }]) {
    const out = reduceTermFrame(s0, "t1", frame);
    assert.equal(out.state, s0);
    assert.deepEqual(out.effects, []);
  }
});

// ══ pickTerminalCwd / pickAttachTarget ══
t("新建终端 cwd：当前会话优先，没有会话取 defaultCwd，都没有则不带", () => {
  assert.equal(pickTerminalCwd("/a", "/b"), "/a");
  assert.equal(pickTerminalCwd(undefined, "/b"), "/b");
  assert.equal(pickTerminalCwd("", "  /b  "), "/b");
  assert.equal(pickTerminalCwd(undefined, undefined), undefined);
});

t("attach 目标：该种 shell 第一个未退出的；默认 bash；没有返回 null（调用方新建）", () => {
  const term = (id, exited, kind = "bash") => ({ id, cwd: "/", kind, shell: kind, cols: 80, rows: 24, createdAt: "", exited, exitCode: null });
  assert.equal(pickAttachTarget([term("p", false, "powershell"), term("a", true), term("b", false), term("c", false)])?.id, "b");
  assert.equal(pickAttachTarget([term("a", false), term("p", true, "powershell"), term("q", false, "powershell")], "powershell")?.id, "q");
  assert.equal(pickAttachTarget([term("a", false)], "powershell"), null);
  assert.equal(pickAttachTarget([term("a", true)]), null);
  assert.equal(pickAttachTarget([]), null);
});

if (!process.exitCode) console.log(`✅ terminal 纯逻辑单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
