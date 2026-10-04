#!/usr/bin/env node
// terminal.ts（面板宽度 clamp / 快捷键栏按键→控制序列 / /ws/terminal 下行帧归约 / WS URL）纯逻辑单测。
import { strict as assert } from "node:assert";

const {
  isTerminalToggleKey,
  isTerminalPasteKey,
  createTermTitlebarGesture,
  TERM_ACTIVE_STORAGE_KEY,
  TERM_MIN_WIDTH,
  TERM_MAIN_MIN_WIDTH,
  TERM_DEFAULT_WIDTH,
  TERM_SHORTCUT_KEYS,
  buildTerminalWsUrl,
  buildTermTabs,
  clampPanelWidth,
  initialTermState,
  pickBootTerminal,
  pickRecentTerminal,
  pickAdjacentTerminal,
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

t("粘贴按键交给浏览器：Ctrl+V、Ctrl+Shift+V、Cmd+V；普通 V 与其他控制键仍交给终端", () => {
  const key = { code: "KeyV", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isTerminalPasteKey(key), true);
  assert.equal(isTerminalPasteKey({ ...key, shiftKey: true }), true);
  assert.equal(isTerminalPasteKey({ ...key, ctrlKey: false, metaKey: true }), true);
  assert.equal(isTerminalPasteKey({ ...key, ctrlKey: false }), false);
  assert.equal(isTerminalPasteKey({ ...key, altKey: true }), false);
  assert.equal(isTerminalPasteKey({ ...key, metaKey: true }), false);
  for (const code of ["KeyC", "KeyD", "Backquote", "Enter"]) {
    assert.equal(isTerminalPasteKey({ ...key, code }), false);
  }
});

const swipeFixture = () => {
  const changes = [];
  const state = { mobile: true, atTop: false };
  const gesture = createTermTitlebarGesture({
    isMobile: () => state.mobile,
    isAtTop: () => state.atTop,
    onHiddenChange: (hidden) => changes.push(hidden),
  });
  const point = (y, x = 0, identifier = 1) => [{ identifier, clientX: x, clientY: y }];
  return { gesture, changes, state, point };
};

t("手机顶栏：上滑不到阈值保留，达到 48px 隐藏且不重复触发", () => {
  const { gesture, changes, point } = swipeFixture();
  gesture.start(point(200));
  gesture.move(point(175));
  gesture.move(point(153));
  assert.deepEqual(changes, []);
  gesture.move(point(152));
  gesture.move(point(80));
  assert.deepEqual(changes, [true]);
});

t("手机顶栏：下拉先滚输出，到达顶部后的额外 48px 才恢复", () => {
  const { gesture, changes, state, point } = swipeFixture();
  gesture.start(point(200));
  gesture.move(point(100));
  gesture.end();
  gesture.start(point(100));
  gesture.move(point(200));
  assert.deepEqual(changes, [true], "非顶部下拉不恢复");
  state.atTop = true;
  gesture.move(point(247));
  assert.deepEqual(changes, [true], "滚到顶部之前的距离不能计入阈值");
  gesture.move(point(248));
  assert.deepEqual(changes, [true, false]);
});

t("手机顶栏：可跨手势恢复，但多次短滑不能累计成一次长滑", () => {
  const { gesture, changes, state, point } = swipeFixture();
  for (let i = 0; i < 3; i++) {
    gesture.start(point(200));
    gesture.move(point(170));
    gesture.end();
  }
  assert.deepEqual(changes, []);
  gesture.start(point(200));
  gesture.move(point(150));
  gesture.end();
  state.atTop = true;
  gesture.start(point(100));
  gesture.move(point(150));
  assert.deepEqual(changes, [true, false]);
});

t("手机顶栏：离开顶部或反向移动后重新累计下拉力度", () => {
  const { gesture, changes, state, point } = swipeFixture();
  gesture.start(point(300));
  gesture.move(point(250));
  state.atTop = true;
  gesture.move(point(290));
  state.atTop = false;
  gesture.move(point(310));
  state.atTop = true;
  gesture.move(point(340));
  gesture.move(point(335));
  gesture.move(point(370));
  assert.deepEqual(changes, [true]);
  gesture.move(point(383));
  assert.deepEqual(changes, [true, false]);
});

t("手机顶栏：横向、多指、手指身份变化不触发；桌面也不触发", () => {
  const { gesture, changes, state, point } = swipeFixture();
  gesture.start(point(200));
  gesture.move(point(190, 80));
  gesture.move(point(100, 80));
  gesture.start([...point(200), ...point(200, 20, 2)]);
  gesture.move(point(100));
  gesture.start(point(200));
  gesture.move([...point(170), ...point(170, 20, 2)]);
  gesture.move(point(100));
  gesture.start(point(200));
  gesture.move(point(100, 0, 2));
  state.mobile = false;
  gesture.start(point(200));
  gesture.move(point(100));
  assert.deepEqual(changes, []);
});

t("手机顶栏：重新进入或结束确认的 reset 显示顶栏并取消在途手势", () => {
  const { gesture, changes, state, point } = swipeFixture();
  gesture.start(point(200));
  gesture.move(point(100));
  gesture.reset();
  state.atTop = true;
  gesture.move(point(200));
  assert.deepEqual(changes, [true, false]);
  gesture.start(point(200));
  gesture.move(point(152));
  assert.deepEqual(changes, [true, false, true]);
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

// ══ pickTerminalCwd / pickBootTerminal / buildTermTabs ══
const term = (id, exited, kind = "bash") => ({ id, cwd: `/${id}`, kind, shell: kind, cols: 80, rows: 24, createdAt: "", exited, exitCode: null });

t("新建终端 cwd：当前会话优先，没有会话取 defaultCwd，都没有则不带", () => {
  assert.equal(pickTerminalCwd("/a", "/b"), "/a");
  assert.equal(pickTerminalCwd(undefined, "/b"), "/b");
  assert.equal(pickTerminalCwd("", "  /b  "), "/b");
  assert.equal(pickTerminalCwd(undefined, undefined), undefined);
});

t("引导 attach：持久化的激活 id 仍存活优先；已退出或不存在则第一个未退出的；都没有返回 null（调用方新建）", () => {
  const list = [term("a", true), term("b", false), term("c", false, "powershell")];
  assert.equal(pickBootTerminal(list, "c")?.id, "c", "持久化 id 存活时不限 shell 种类");
  assert.equal(pickBootTerminal(list, "a")?.id, "b", "持久化 id 已退出则回落");
  assert.equal(pickBootTerminal(list, "term_不存在的")?.id, "b");
  assert.equal(pickBootTerminal(list, null)?.id, "b");
  assert.equal(pickBootTerminal([term("a", true)], "a"), null);
  assert.equal(pickBootTerminal([], null), null);
});

t("滑块：按激活顺序选同 kind 存活终端，忽略退出/删除/异种记录，无记录回落注册表首项", () => {
  const list = [term("a", false), term("b", false), term("dead", true), term("p", false, "powershell")];
  const before = JSON.stringify(list);
  assert.equal(pickRecentTerminal(list, "bash", ["a", "b", "dead", "missing", "p"])?.id, "b");
  assert.equal(pickRecentTerminal(list, "bash", ["b", "a"])?.id, "a");
  assert.equal(pickRecentTerminal(list, "bash", [])?.id, "a");
  assert.equal(pickRecentTerminal(list, "powershell", ["b", "p", "a"])?.id, "p");
  assert.equal(pickRecentTerminal([term("dead", true)], "bash", ["dead"]), null);
  assert.equal(pickRecentTerminal([], "powershell", []), null);
  assert.equal(JSON.stringify(list), before);
});

t("关闭退出标签：右邻优先、左邻回落、跳过退出记录，没有存活邻居清空", () => {
  const list = [term("a", false), term("dead", true), term("p", false, "powershell")];
  assert.equal(pickAdjacentTerminal(list, "dead")?.id, "p");
  assert.equal(pickAdjacentTerminal(list.slice(0, 2), "dead")?.id, "a");
  assert.equal(pickAdjacentTerminal([term("a", false), term("dead", true), term("dead2", true)], "dead2")?.id, "a");
  assert.equal(pickAdjacentTerminal([term("dead", true)], "dead"), null);
  assert.equal(pickAdjacentTerminal(list, "missing"), null);
});

t("标签：唯一时不带序号；同种多个按注册表顺序全体编号", () => {
  assert.deepEqual(buildTermTabs([term("a", false)], "a").map((x) => x.label), ["bash"]);
  const duo = buildTermTabs([term("a", false), term("b", false)], "a");
  assert.deepEqual(duo.map((x) => x.label), ["bash 1", "bash 2"]);
  const trio = buildTermTabs([term("a", false), term("b", false), term("c", false)], "b");
  assert.deepEqual(trio.map((x) => x.label), ["bash 1", "bash 2", "bash 3"]);
  const mixed = buildTermTabs([term("p", false, "powershell"), term("a", false)], "a");
  assert.deepEqual(mixed.map((x) => x.label), ["PowerShell", "bash"], "不同种各自唯一就都不编号，顺序保持注册表顺序");
});

t("标签：已退出的只保留当前激活的（看输出与退出码），其余藏掉", () => {
  const list = [term("a", true), term("b", false), term("c", true)];
  assert.deepEqual(buildTermTabs(list, "b").map((x) => x.id), ["b"]);
  const keepActive = buildTermTabs(list, "a");
  assert.deepEqual(keepActive.map((x) => x.id), ["a", "b"]);
  assert.equal(keepActive[0].exited, true);
  assert.equal(keepActive[1].exited, false);
});

t("标签：cwd 与 kind 原样带出（title 与样式用）", () => {
  const [tab] = buildTermTabs([term("a", false, "powershell")], "a");
  assert.equal(tab.cwd, "/a");
  assert.equal(tab.kind, "powershell");
  assert.equal(tab.id, "a");
});

t("激活 id 的 localStorage 键固定为 workbench-term-active", () => {
  assert.equal(TERM_ACTIVE_STORAGE_KEY, "workbench-term-active");
});

if (!process.exitCode) console.log(`✅ terminal 纯逻辑单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
