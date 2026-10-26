import assert from "node:assert/strict";
import React from "react";
import { contextPercent } from "../src/context-usage.ts";
import { store } from "../src/store.ts";

// 累计花费不能当成当前上下文；Codex 必须取 last 而非 total。
assert.equal(contextPercent("codex", { usage: { total: { totalTokens: 900000 }, last: { totalTokens: 25000 }, modelContextWindow: 100000 } }), 25);
assert.equal(contextPercent("codex", { usage: { total: { totalTokens: 900000 }, modelContextWindow: 100000 } }), null);
assert.equal(contextPercent("kimi", { used: 25417, size: 1048576 }), 25417 / 1048576 * 100);
assert.equal(contextPercent("claude", { usage: { input_tokens: 500000 }, modelUsage: { model: { contextWindow: 200000 } } }), null);
assert.equal(contextPercent("claude", { totalTokens: 42000, maxTokens: 200000, percentage: 21 }), 21);
assert.equal(contextPercent("claude", { totalTokens: 42000, maxTokens: 200000 }), 21);
assert.equal(contextPercent("claude", { percentage: 0 }), 0);
assert.equal(contextPercent("kimi", { used: 120, size: 100 }), 100);
for (const payload of [undefined, null, {}, { used: 3, size: 0 }, { used: -1, size: 100 }, { used: "30", size: 100 }, { used: Infinity, size: 100 }, { used: 30, size: NaN }]) {
  assert.equal(contextPercent("kimi", payload), null);
}
console.log("PASS: 三家当前上下文口径、累计值隔离、零值、越界及缺失数据");

globalThis.React = React;
const { ContextUsage } = await import("../src/components/ContextUsage.tsx");
const { compactSessionContext } = await import("../src/api.ts");
const previousFetch = globalThis.fetch;
const previousState = { sessions: store.sessions, data: store.data, drafts: store.drafts };
const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes)
  : [node, ...nodes(node.props?.children)];
function mount(session) {
  const slots = [];
  let cursor = 0;
  const dispatcher = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useId: () => "context-fixture",
    useEffect() {}, useCallback: fn => fn, useMemo: fn => fn(),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return () => {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try { return nodes(ContextUsage({ session })); }
    finally { internals.H = previous; }
  };
}
const ring = tree => tree.find(node => node.type === "button" && node.props.className?.includes("context-usage"));
const action = tree => tree.find(node => node.type === "button" && node.props.className?.includes("context-compact"));
try {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ code: 0, data: { accepted: true } }));
  };
  assert.equal(typeof compactSessionContext, "function", "manual compaction needs an HTTP acknowledgement");
  await compactSessionContext("session/id");
  assert.equal(requests[0].url, "/api/sessions/session%2Fid/compact");
  assert.equal(requests[0].options.method, "POST");

  for (const agent of ["claude", "codex", "kimi"]) {
    const session = { id: `context-${agent}`, agent, status: "idle", config: {} };
    store.sessions = [session]; store.data = new Map(); store.drafts = new Map([[session.id, "keep this draft"]]);
    const render = mount(session);
    let tree = render();
    assert.ok(ring(tree), `${agent}: the context indicator must be a button even without a reading`);
    ring(tree).props.onClick(); tree = render();
    assert.ok(action(tree)); assert.equal(action(tree).props.disabled, false);
    let finish;
    const before = requests.length;
    globalThis.fetch = (url, options) => {
      requests.push({ url, options });
      return new Promise(resolve => { finish = () => resolve(new Response(JSON.stringify({ code: 0, data: { accepted: true } }))); });
    };
    const first = action(tree).props.onClick();
    action(tree).props.onClick();
    assert.equal(requests.length, before + 1, "rapid duplicate clicks must send once");
    assert.equal(action(render()).props.disabled, true);
    assert.equal(store.getDraft(session.id), "keep this draft", "compaction must not consume the composer draft");
    finish(); await first;
    tree = render();
    assert.ok(nodes(tree).some(node => node.props?.role === "status"), "accepted is distinct from completed");
    assert.equal(action(tree).props.disabled, true, "an accepted request cannot be submitted again from the same menu");

    for (const patch of [{ status: "running" }, { status: "starting" }, { status: "dead" }, { pendingGateCount: 1 }]) {
      const guarded = mount({ ...session, ...patch });
      ring(guarded()).props.onClick();
      assert.equal(action(guarded()).props.disabled, true, `${agent}: ${JSON.stringify(patch)}`);
    }
    const failed = mount(session);
    ring(failed()).props.onClick();
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 40067, msg: "fixture failure" }));
    await action(failed()).props.onClick();
    const alert = failed().find(node => node.props?.role === "alert");
    assert.equal(alert?.props.children, "fixture failure");
    assert.equal(action(failed()).props.disabled, false, "a rejected request can be retried");
    assert.equal(store.getDraft(session.id), "keep this draft");
  }
} finally {
  globalThis.fetch = previousFetch;
  Object.assign(store, previousState);
}
console.log("PASS: 上下文按钮、三家原会话压缩、重复提交、状态守卫、错误重试与草稿隔离");
