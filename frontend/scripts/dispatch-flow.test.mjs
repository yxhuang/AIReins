#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { groupDispatches, dispatchName, dispatchSeconds, dispatchTime, dispatchStatus, dispatcherTitle, dispatcherSessions, dispatcherModel, subagentWireState, RECENT_DISPATCH_MS, FINISHED_WIRE_MS } from '../src/dispatch-flow.ts';
import * as flow from '../src/dispatch-flow.ts';
import { startDispatchPolling } from '../src/dispatch-polling.ts';
import { fetchDispatches } from '../src/api.ts';

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: '#/', href: 'http://127.0.0.1:8790/' }, innerWidth: 1280, addEventListener() {} };
const { Store, store } = await import('../src/store.ts');
const { App } = await import('../src/App.tsx');
const { DispatchView, DispatchTree } = await import('../src/components/DispatchView.tsx');
const { lastWindowsCwd, loadWindowsHistory } = await import('../src/components/DirectoryBrowser.tsx');
let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error(`❌ ${name}\n${e.stack}`); process.exitCode = 1; } };
const now = Date.parse('2026-10-01T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const run = (over = {}) => ({ runId: '20261001-100000-codex-task-name', tool: 'codex', name: '任务', model: 'gpt-test', effort: 'high', status: 'running', startedAt: iso(now - 61000), endedAt: null, elapsedS: null, session: null, parent: null, ...over });

const child = (threadId, parentThreadId, depth = 1) => ({ threadId, parentThreadId, depth,
  nickname: threadId, role: 'sol', status: 'running', startedAt: iso(now - 1000), lastActivityAt: iso(now) });
const treeFor = (runs, expanded = new Set()) => flow.buildDispatchTree(groupDispatches(runs, now), now, expanded);
await t('连线：底边按行序均分起点，独立平滑曲线无侧边折线或共享总线', () => {
  const from = { left: 10, right: 150, top: 20, bottom: 110 };
  for (const count of [2, 3, 5]) {
    const starts = [];
    for (let index = 0; index < count; index++) {
      const to = { left: index * 100, right: index * 100 + 80, top: 166, bottom: 250 };
      const path = flow.dispatchWirePath(from, to, { index, count });
      assert.match(path, /^M [-\d.]+ 110 C /);
      assert.ok(!/[HLV]/.test(path), '没有侧边竖线或横向总线');
      const values = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
      assert.equal(values[0], from.left + (from.right - from.left) * (index + 1) / (count + 1));
      assert.deepEqual(values.slice(-2), [(to.left + to.right) / 2, to.top]);
      assert.equal(values[2], values[0]); assert.equal(values[4], values[6]);
      starts.push(values[0]);
    }
    assert.equal(new Set(starts).size, count);
    assert.ok(starts.every((x, index) => x > from.left && x < from.right && (!index || x > starts[index - 1])));
  }
  assert.equal(flow.dispatchWirePath(from, { left: 60, right: 100, top: 166, bottom: 250 }), 'M 80 110 C 80 138 80 138 80 166');
});
await t('模型：Sol/Luna/Astra 紧凑短名，其他模型沿用现有短名', () => {
  for (const [model, short] of [['gpt-6.1-sol', 'sol'], ['gpt-6-sol', 'sol'], ['gpt-6-luna', 'luna'],
    ['gpt-6-astra', 'astra'], ['claude-sonnet-5-5', 'sonnet-5.5'], ['claude-opus-5-5-20261001', 'opus-5.5'], ['gpt-test', 'gpt-test']]) {
    assert.equal(flow.dispatchModelName(model), short);
  }
});
await t('模型渲染：第二层单单与第三层任务显示 sol · xhigh，完整模型/档位留在 title', () => {
  const sol = run({ model: 'gpt-6.1-sol', effort: 'xhigh' });
  for (const runs of [[sol], [sol, run({ runId: 'two', model: 'gpt-6-luna', effort: 'max' })]]) {
    const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches(runs, now), title: '派单人', model: null, now }));
    assert.ok(html.includes('class="dispatch-model-name">sol</span><span class="dispatch-model-effort"> · xhigh</span>'));
    assert.ok(html.includes('gpt-6.1-sol / xhigh'));
    assert.ok(!html.includes('class="dispatch-model-name">gpt-6.1-sol'));
  }
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dispatch-model-effort \{[^}]*flex: 0 0 auto/);
});
await t('树：单 agent 无子直接占第二层，空闲端只有紧凑态', () => {
  const tree = treeFor([run()]);
  const codex = tree.executors.find(node => node.tool === 'codex');
  assert.equal(codex.mode, 'single'); assert.equal(codex.run.runId, run().runId);
  assert.equal(codex.depth, 2); assert.equal(codex.rows.length, 0);
  assert.equal(tree.levels.length, 1);
  assert.equal(tree.executors.filter(node => node.mode === 'idle').length, 2);
});
await t('树：双 agent 一行一单，第三层两个块的父指向各自摘要行', () => {
  const tree = treeFor([run({ runId: 'one' }), run({ runId: 'two' })]);
  const executor = tree.executors[0];
  assert.equal(executor.mode, 'group'); assert.equal(executor.rows.length, 2);
  assert.deepEqual(tree.levels[1].map(node => node.run.runId), ['one', 'two']);
  for (const node of tree.levels[1]) {
    const edge = tree.edges.find(edge => edge.to === node.id);
    assert.equal(edge.from, executor.rows.find(row => row.run.runId === node.run.runId).id);
    assert.equal(node.parentId, edge.from);
  }
});
await t('树：子 agent 按派单根和 parentThreadId 递归，乱序/重名/孤儿/环不串单', () => {
  const one = run({ runId: 'one', session: 'root-one', subagents: [
    child('deep', 'nested', 3), child('nested', 'shared', 2), child('shared', 'root-one'),
    child('orphan', 'missing', 2), child('cycle-a', 'cycle-b', 1), child('cycle-b', 'cycle-a', 2),
  ] });
  const two = run({ runId: 'two', session: 'root-two', subagents: [child('shared', 'root-two')] });
  const before = JSON.stringify([one, two]);
  const tree = treeFor([one, two]);
  const agents = tree.levels.flat().filter(node => node.subagent);
  assert.equal(agents.length, 4); assert.equal(new Set(agents.map(node => node.id)).size, 4);
  const nested = agents.find(node => node.subagent.threadId === 'nested');
  const deep = agents.find(node => node.subagent.threadId === 'deep');
  assert.equal(deep.parentId, nested.id); assert.equal(deep.depth, 6);
  assert.equal(agents.find(node => node.runId === 'two').parentId, tree.levels[1].find(node => node.run.runId === 'two').id);
  assert.equal(JSON.stringify([one, two]), before);
  const single = treeFor([one]);
  assert.equal(single.levels[1][0].parentId, single.executors[0].id);
  assert.equal(single.levels[1][0].depth, 3);
});
await t('树：Claude 子代理独立成组，空闲时隐藏；+N 只折叠摘要行，第三层始终完整', () => {
  assert.equal(treeFor([]).executors.some(node => node.tool === 'claude'), false);
  const runs = Array.from({ length: 5 }, (_, i) => run({ tool: 'claude', runId: `claude-${i}`, name: `检查 ${i}`, model: 'claude-sonnet-5-5' }));
  runs[4].session = 'thread-4';
  runs[4].subagents = [{ threadId: 'child-4', nickname: 'Luna', role: null, depth: 1, parentThreadId: 'thread-4', status: 'running', startedAt: null, lastActivityAt: iso(now) }];
  const tree = treeFor(runs); const group = tree.executors.find(node => node.tool === 'claude');
  assert.equal(group.mode, 'group'); assert.equal(group.rows.length, 3); assert.equal(group.more, 2);
  assert.equal(tree.levels[1].length, 5, '折叠的第二层摘要行对应的第三层块仍在');
  const folded = tree.levels[1].find(node => node.run.runId === runs[4].runId);
  assert.equal(folded.parentId, group.id, '折叠行的块从执行端卡片连出');
  assert.equal(tree.levels[2].length, 1, '折叠行的子代理也在');
  const ports = tree.edges.filter(edge => edge.kind === 'run').map(edge => edge.port);
  assert.deepEqual(ports.map(port => port.index), [0, 1, 2, 3, 4]); assert.ok(ports.every(port => port.count === 5));
  const expanded = treeFor(runs, new Set(['claude']));
  assert.equal(expanded.executors.find(node => node.tool === 'claude').rows.length, 5);
  assert.equal(expanded.levels[1].length, 5);
});

await t('固定三端，按 tool 分组；运行中保留，结束 30 分钟边界，未知日期不冒充近期单', () => {
  const groups = groupDispatches([
    run({ startedAt: iso(now - 86400000) }),
    run({ tool: 'kimi', status: 'OK', endedAt: iso(now - RECENT_DISPATCH_MS) }),
    run({ tool: 'copilot', status: 'TIMEOUT', endedAt: iso(now - RECENT_DISPATCH_MS - 1) }),
    run({ status: 'OK', endedAt: 'bad', startedAt: null }),
    run({ status: 'unknown', startedAt: null }),
    run({ tool: 'other' }),
  ], now);
  assert.deepEqual(groups.map(g => g.tool), ['codex', 'kimi', 'copilot']);
  assert.deepEqual(groups.map(g => g.runs.length), [1, 1, 0]);
  assert.deepEqual(groups.map(g => g.wireState), ['flow', 'idle', 'idle']);
  assert.equal(groupDispatches([], now).length, 3);
});
await t('结束时间缺失由 startedAt + elapsedS 推算；lost 无可信时间在刷新前后都排除', () => {
  const lost = run({ status: 'lost' });
  assert.equal(groupDispatches([lost], now)[0].runs.length, 0);
  assert.equal(groupDispatches([lost], now + RECENT_DISPATCH_MS + 1)[0].runs.length, 0);
  const completed = run({ status: 'TOOL_FAIL', startedAt: iso(now - RECENT_DISPATCH_MS - 1000), elapsedS: 1 });
  assert.equal(groupDispatches([completed], now)[0].runs.length, 1);
  assert.equal(groupDispatches([run({ status: 'lost', endedAt: iso(now) })], now)[0].runs.length, 1);
  assert.equal(groupDispatches([run({ status: 'lost', elapsedS: 10 })], now)[0].runs.length, 1);
  for (const elapsedS of [-1, NaN, Infinity]) assert.equal(groupDispatches([run({ status: 'lost', elapsedS })], now)[0].runs.length, 0);
  assert.equal(groupDispatches([run({ status: 'OK', endedAt: iso(now + 1) })], now)[0].runs.length, 0);
});
await t('运行中优先，最多三单与 +N；嵌套单仍普通分组，输入不被修改', () => {
  const items = Array.from({ length: 5 }, (_, i) => run({ runId: String(i), status: i === 4 ? 'running' : 'OK', endedAt: iso(now - 1000), parent: { runId: 'outer', agent: 'codex', sessionId: 'parent', entrypoint: null } }));
  const before = JSON.stringify(items);
  const g = groupDispatches(items, now)[0];
  assert.equal(g.visible.length, 3); assert.equal(g.more, 2); assert.equal(g.visible[0].runId, '4');
  assert.equal(groupDispatches(items.slice(0, 2), now)[0].more, 0);
  assert.equal(JSON.stringify(items), before);
});
await t('简述只用 name 或 runId 尾段；运行走秒，结束只用 elapsedS；状态全覆盖', () => {
  assert.equal(dispatchName(run({ name: '' })), 'task-name');
  assert.equal(dispatchName(run({ name: '  简述  ', promptHead: '不显示' })), '简述');
  assert.equal(dispatchSeconds(run(), now), 61);
  assert.equal(dispatchSeconds(run(), now + 1000), 62);
  assert.equal(dispatchSeconds(run({ status: 'OK', elapsedS: 18 }), now), 18);
  assert.equal(dispatchSeconds(run({ status: 'OK' }), now), null);
  assert.equal(dispatchSeconds(run({ startedAt: 'bad' }), now), null);
  assert.equal(dispatchTime(3661), '1:01:01'); assert.equal(dispatchTime(null), '—');
  assert.deepEqual(['running', 'OK', 'TOOL_FAIL', 'ACCEPT_FAIL', 'TIMEOUT', 'lost', 'unknown'].map(x => dispatchStatus(x).label), ['运行中', '刚完成 ✓', '失败 ✗', '失败 ✗', '失败 ✗', 'lost', '未知']);
});
await t('派单人标题：三家 parent.sessionId、工作台/原生 id 匹配、短 id、多个会话、执行端 session 不算', () => {
  const titles = [{ id: 'wb', nativeSessionId: 'native', title: '工作台标题' }];
  const by = (sessionId, agent = 'claude') => run({ session: 'executor-own', parent: { agent, sessionId, entrypoint: null } });
  assert.equal(dispatcherTitle([by('native')], titles), '工作台标题');
  assert.equal(dispatcherTitle([by('wb'), by('native')], titles), '工作台标题');
  assert.equal(dispatcherTitle([by('abcdefgh-123')], titles), 'Claude Code 会话 · abcdefgh');
  assert.equal(dispatcherTitle([by('native'), by('other')], titles), '工作台标题\nClaude Code 会话 · other');
  assert.equal(dispatcherTitle([by('native', 'codex')], titles), '工作台标题');
  assert.equal(dispatcherTitle([by('kimi-native', 'kimi')], titles), 'Kimi 会话 · kimi-nat');
  assert.equal(dispatcherTitle([run({ session: 'native' })], titles), '未关联父会话');
});

await t('三家独立会话分图，运行端与原生 ID 一起隔离；嵌套派单留在同一棵树', () => {
  const sessions = ['claude', 'codex', 'kimi'].map(agent => ({ id: `wb-${agent}`, agent, nativeSessionId: 'same-native', title: `${agent} 的会话` }));
  const direct = ['claude', 'codex', 'kimi'].map(agent => run({ runId: agent, tool: agent === 'kimi' ? 'copilot' : 'kimi', session: `${agent}-executor`, parent: { agent, sessionId: 'same-native' } }));
  const nested = run({ runId: 'copilot-nested', tool: 'copilot', parent: { agent: 'kimi', runId: 'codex' } });
  const forests = flow.dispatchForests([...direct, nested], sessions);
  assert.equal(forests.length, 3);
  assert.deepEqual(forests.map(forest => forest.title), ['Claude Code', 'Codex', 'Kimi']);
  assert.deepEqual(forests.find(forest => forest.agent === 'codex').runs.map(run => run.runId), ['codex', 'copilot-nested']);
  for (const forest of forests) {
    const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches(forest.runs, now),
      title: forest.title, agent: forest.agent, model: null, now }));
    assert.ok(html.includes(`data-source-agent="${forest.agent}"`));
    assert.ok(html.includes(`<span>${flow.dispatcherLabel(forest.agent)}</span>`));
  }
});

await t('同主体不同会话合为一树；Copilot 不作根，仍可作为第二层执行端', () => {
  const sessions = [{ id: 'one', agent: 'claude', title: '会话一' }, { id: 'two', agent: 'claude', title: '会话二' }];
  const runs = [run({ runId: 'one', parent: { agent: 'claude', sessionId: 'one' } }),
    run({ runId: 'two', tool: 'copilot', parent: { agent: 'claude', sessionId: 'two' } }),
    run({ runId: 'copilot-root', parent: { agent: 'copilot', sessionId: 'three' } })];
  const forests = flow.dispatchForests(runs, sessions);
  assert.equal(forests.length, 1); assert.equal(forests[0].title, 'Claude Code');
  assert.deepEqual(forests[0].runs.map(run => run.runId), ['one', 'two']);
  const dispatchers = dispatcherSessions(forests[0].runs, sessions);
  assert.deepEqual(dispatchers.map(source => source.title), ['会话一', '会话二']);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches(forests[0].runs, now),
    title: forests[0].title, agent: forests[0].agent, dispatchers, model: null, now }));
  assert.ok(html.includes('会话一')); assert.ok(html.includes('会话二'));
  assert.ok(treeFor(forests[0].runs).executors.some(node => node.tool === 'copilot' && node.run?.runId === 'two'));
  const oldParent = run({ runId: 'old-parent', tool: 'codex', session: 'old-session', parent: { agent: 'claude', sessionId: 'one' } });
  const nested = run({ runId: 'nested', tool: 'kimi', parent: { agent: 'codex', sessionId: 'old-session' } });
  assert.equal(flow.dispatchForests([nested], sessions, [oldParent, nested])[0].agent, 'claude');
});
await t('运行时三树固定排序；CLI Codex 委派 Claude 可点详情并保留子代理层级', () => {
  const codex = run({ runId: 'codex-to-claude', tool: 'claude', model: 'opus', effort: 'high', session: 'claude-executor',
    parent: { agent: 'codex', sessionId: 'cli-codex', title: '独立 Codex 审核' } });
  const childRun = run({ runId: 'claude-child', tool: 'claude', native: true, parent: { agent: 'claude', sessionId: 'claude-executor' } });
  const items = [run({ runId: 'kimi-root', parent: { agent: 'kimi', sessionId: 'cli-kimi' } }), codex, childRun,
    run({ runId: 'claude-root', parent: { agent: 'claude', sessionId: 'wb-claude' } }),
    run({ runId: 'codex-second', tool: 'copilot', parent: { agent: 'codex', sessionId: 'cli-codex-second' } })];
  const forests = flow.dispatchForests(items, []);
  assert.deepEqual(forests.map(forest => forest.agent), ['claude', 'codex', 'kimi']);
  const forest = forests[1];
  const roots = forest.runs.filter(item => !flow.dispatchParent(item, items));
  assert.deepEqual(dispatcherSessions(roots, []).map(source => source.title), ['独立 Codex 审核', 'Codex 会话 · cli-code']);
  const tree = treeFor(forest.runs);
  const claude = tree.levels.flat().find(node => node.run?.runId === codex.runId);
  assert.equal(claude.parentId, 'dispatcher');
  assert.equal(tree.levels.flat().find(node => node.run?.runId === childRun.runId).parentId, claude.id);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches(forest.runs, now),
    title: forest.title, agent: forest.agent, dispatchers: dispatcherSessions(roots, []), model: null, now }));
  assert.match(html, /<button[^>]*data-tool="claude"/);
  assert.ok(html.includes('opus')); assert.ok(html.includes(' · high'));
  assert.match(html, /<article[^>]*data-tool="claude"/);
  assert.deepEqual(flow.dispatchForests([codex], []).map(forest => forest.agent), ['codex']);
});

await t('Claude native 子代理作根侧支，显示类型/模型/状态，嵌套派单挂在侧支下', () => {
  const native = run({ runId: 'native', tool: 'claude', native: true, session: 'native-thread', model: 'claude-sonnet-5-5', agentType: 'Explore',
    parent: { agent: 'claude', sessionId: 'root' } });
  const nested = run({ runId: 'nested', tool: 'kimi', parent: { agent: 'claude', sessionId: 'native-thread' } });
  const tree = treeFor([native, nested, run({ runId: 'external', parent: { agent: 'claude', sessionId: 'root' } })]);
  assert.equal(tree.sidebranches.length, 1);
  assert.ok(!tree.executors.some(node => node.tool === 'claude'));
  assert.ok(!tree.levels[0].some(node => node.run?.runId === 'native'));
  assert.equal(tree.levels.flat().find(node => node.run?.runId === 'nested').parentId, tree.sidebranches[0].id);
  assert.equal(tree.edges.find(edge => edge.to === tree.sidebranches[0].id).from, 'dispatcher');
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches([native, nested], now), title: 'Claude Code', agent: 'claude', model: null, now }));
  for (const text of ['dispatch-sidebranches', 'dispatch-sidebranch-wire', 'Explore', 'sonnet-5.5', '运行中']) assert.ok(html.includes(text));
  const empty = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches([run()], now), title: 'Claude Code', model: null, now }));
  assert.ok(!empty.includes('dispatch-sidebranches'));
  assert.equal(flow.dispatchWirePath({ left: 0, right: 100, top: 0, bottom: 60 }, { left: 140, right: 200, top: 20, bottom: 80 }, undefined, true),
    'M 100 30 C 120 30 120 50 140 50');
});

await t('跨工具子任务连到真实父节点，Luna 派单连到 Luna；原生子代理不打开工单详情', () => {
  const parent = run({ runId: 'parent-run', session: 'codex-parent', subagents: [child('luna-native', 'codex-parent')] });
  const kimi = run({ runId: 'kimi-child', tool: 'kimi', session: 'kimi-executor', parent: { agent: 'codex', sessionId: 'luna-native', runId: 'parent-run' } });
  const copilot = run({ runId: 'copilot-child', tool: 'copilot', parent: { agent: 'kimi', sessionId: 'kimi-executor' } });
  const tree = treeFor([copilot, kimi, parent]);
  const nodes = tree.levels.flat();
  const luna = nodes.find(node => node.subagent?.threadId === 'luna-native');
  const kimiNode = nodes.find(node => node.run?.runId === 'kimi-child');
  const copilotNode = nodes.find(node => node.run?.runId === 'copilot-child');
  assert.equal(kimiNode.parentId, luna.id);
  assert.equal(copilotNode.parentId, kimiNode.id);
  assert.equal(kimiNode.depth, luna.depth + 1);
  assert.equal(copilotNode.depth, kimiNode.depth + 1);
  const native = run({ runId: 'native-luna', native: true, name: 'Luna', parent: { agent: 'codex', sessionId: 'direct-root' } });
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches([native], now), title: 'Codex 会话', agent: 'codex', model: null, now }));
  assert.match(html, /<article[^>]*class="dispatch-node dispatch-executor/);
  assert.ok(!html.includes('<button'));
  assert.equal(flow.dispatchForests([run({ runId: 'cycle-a', parent: { agent: 'codex', runId: 'cycle-b' } }),
    run({ runId: 'cycle-b', parent: { agent: 'codex', runId: 'cycle-a' } })], []).length, 1);
});

await t('派单人保持窄块：多会话压成一行摘要，完整标题保留 title，别名去重', () => {
  const titles = Array.from({ length: 5 }, (_, i) => ({ id: `wb-${i}`, nativeSessionId: `native-${i}`, title: `派单会话 ${i}` }));
  const by = (id, status = 'running') => run({ runId: id, status, endedAt: iso(now), parent: { agent: 'claude', sessionId: id, entrypoint: null } });
  const runs = [...titles.map(s => by(s.nativeSessionId)), by('wb-0'), by('native-0', 'OK')];
  const dispatchers = dispatcherSessions(runs, titles);
  assert.deepEqual(dispatchers.map(s => s.title), titles.map(s => s.title));
  assert.deepEqual(dispatchers.map(s => s.running), [2, 1, 1, 1, 1]);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches(runs, now), title: dispatcherTitle(runs, titles), dispatchers, model: null, now,
  }));
  const source = html.match(/<article class="dispatch-node dispatch-source"[^>]*>([\s\S]*?)<\/article>/)[1];
  assert.equal((source.match(/class="dispatch-session-title"/g) || []).length, 1);
  for (const text of ['派单会话 0 · 2 单运行中', '派单会话 1 · 1 单运行中', '派单会话 2 · 1 单运行中', '派单会话 4 · 1 单运行中']) assert.ok(source.includes(text));
  assert.ok(source.includes('title="派单会话 0\n派单会话 1\n派单会话 2\n派单会话 3\n派单会话 4"'));
  const single = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches([runs[0]], now), title: dispatcherTitle([runs[0]], titles),
    dispatchers: dispatcherSessions([runs[0]], titles), model: null, now,
  }));
  assert.ok(single.includes('title="派单会话 0">派单会话 0</p>'));
});

await t('工具组连线结束十分钟前/正好/之后变灰，卡片仍显示三十分钟；运行中始终 flow', () => {
  for (const age of [FINISHED_WIRE_MS - 1, FINISHED_WIRE_MS, FINISHED_WIRE_MS + 1]) {
    const g = groupDispatches([run({ status: 'OK', endedAt: iso(now - age) })], now)[0];
    assert.equal(g.runs.length, 1);
    assert.equal(g.wireState, age <= FINISHED_WIRE_MS ? 'finish' : 'idle');
  }
  const inferred = run({ status: 'OK', endedAt: null, startedAt: iso(now - FINISHED_WIRE_MS - 1001), elapsedS: 1 });
  assert.equal(groupDispatches([inferred], now)[0].wireState, 'idle');
  const lost = run({ status: 'lost', startedAt: null });
  assert.equal(groupDispatches([lost], now)[0].wireState, 'idle');
  assert.equal(groupDispatches([lost], now + FINISHED_WIRE_MS)[0].runs.length, 0);
  assert.equal(groupDispatches([inferred, run({ startedAt: iso(now - 86400000) })], now)[0].wireState, 'flow');
  assert.equal(groupDispatches([inferred, run({ status: 'OK', endedAt: iso(now - 1) })], now)[0].wireState, 'finish');
});

await t('子 agent 连线按自身 lastActivityAt，十分钟后变灰；运行中和未知日期处理独立', () => {
  const agent = { threadId: 'child', nickname: 'child', role: 'sol', depth: 1, parentThreadId: 'parent',
    status: 'finished', startedAt: iso(now), lastActivityAt: iso(now - FINISHED_WIRE_MS) };
  assert.equal(subagentWireState(agent, now - 1), 'finish');
  assert.equal(subagentWireState(agent, now), 'finish');
  assert.equal(subagentWireState(agent, now + 1), 'idle');
  assert.equal(subagentWireState({ ...agent, status: 'running', lastActivityAt: iso(now - 86400000) }, now), 'flow');
  assert.equal(subagentWireState({ ...agent, lastActivityAt: 'bad' }, now), 'idle');
  assert.equal(subagentWireState({ ...agent, status: 'unknown' }, now), 'idle');
  const html = renderToStaticMarkup(React.createElement(DispatchTree, {
    groups: groupDispatches([run({ subagents: [agent] })], now + 1), title: '派单人', model: null, now: now + 1,
  }));
  assert.ok(html.includes('dispatch-subagent-wire idle'));
  assert.ok(html.includes('已完成')); assert.ok(html.includes('dispatch-wire flow'));
});

await t('Windows 目录比较三家历史与工作台时间，历史更新者胜出；历史失败回落', async () => {
  const local = [{ cwd: '/mnt/c/Users/local', lastActivityAt: iso(now - 1000) }];
  for (const agent of ['claude', 'codex', 'kimi']) {
    const history = { agent, cwd: `/mnt/d/${agent}`, lastActivityAt: iso(now), title: agent };
    globalThis.fetch = async url => {
      assert.equal(url, '/api/history?q=%2Fmnt%2F&limit=1');
      return { json: async () => ({ code: 0, data: { sessions: [history] } }) };
    };
    assert.equal(lastWindowsCwd(local, await loadWindowsHistory()), history.cwd);
    assert.equal(lastWindowsCwd([{ ...local[0], lastActivityAt: iso(now + 1) }], [history]), local[0].cwd);
  }
  globalThis.fetch = async () => { throw new Error('历史接口失败'); };
  assert.equal(lastWindowsCwd(local, await loadWindowsHistory()), local[0].cwd);
  assert.equal(lastWindowsCwd([], await loadWindowsHistory()), '/mnt/c/Users');
  assert.equal(lastWindowsCwd([{ cwd: '/home/repo', lastActivityAt: iso(now) }]), '/mnt/c/Users');
  assert.equal(lastWindowsCwd([{ cwd: '/mnt/c/Users', lastActivityAt: iso(now) }], [{ cwd: '/mnt/d/older', lastActivityAt: iso(now - 1) }]), '/mnt/c/Users');
});

await t('历史关键词误匹配 Linux 会话标题时继续最小页；忽略无效时间，不修改输入', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    return { json: async () => ({ code: 0, data: calls === 1
      ? { sessions: [{ cwd: '/home/repo', title: '/mnt/ 的说明', lastActivityAt: iso(now) }], nextCursor: 'next' }
      : { sessions: [{ cwd: '/mnt/d/native', lastActivityAt: iso(now - 1) }] } }) };
  };
  const history = await loadWindowsHistory();
  assert.equal(calls, 2); assert.equal(lastWindowsCwd([], history), '/mnt/d/native');
  const local = [{ cwd: '/mnt/d/current', lastActivityAt: iso(now) }];
  const before = JSON.stringify(local);
  assert.equal(lastWindowsCwd(local, [{ cwd: '/mnt/c/bad-date', lastActivityAt: 'bad' }]), local[0].cwd);
  assert.equal(JSON.stringify(local), before);
});

await t('简要：name 是执行端兜底时用派单首行', () => {
  assert.equal(dispatchName(run({ name: 'codex', promptHead: '# 工单：派单流程图正式版\n\n正文' })), '派单流程图正式版');
  assert.equal(dispatchName(run({ name: '自定义名', promptHead: '# 工单：别的' })), '自定义名');
  assert.equal(dispatchName(run({ name: 'codex', promptHead: null })), 'codex');
});
await t('派单模型优先匹配 nativeSessionId，外部会话用 parent.model，共用模型短名；缺失无占位', () => {
  const parent = { agent: 'claude', sessionId: 'native', model: 'claude-sonnet-4-5', entrypoint: 'cli' };
  assert.equal(dispatcherModel([run({ parent })], [{ id: 'wb', nativeSessionId: 'native', title: '会话', model: 'claude-opus-5-5' }]), 'opus-5.5');
  assert.equal(dispatcherModel([run({ parent })], []), 'sonnet-4.5');
  assert.equal(dispatcherModel([run({ parent: { ...parent, model: null } })], []), null);
  assert.equal(dispatcherModel([run({ parent: { ...parent, agent: 'codex', model: 'gpt-6-luna' } })], []), 'gpt-6-luna');
});
await t('只读列表 URL 与现有信封，错误 msg 透传', async () => {
  let url;
  globalThis.fetch = async (input) => { url = input; return { json: async () => ({ code: 0, data: { dispatches: [run()] } }) }; };
  assert.equal((await fetchDispatches()).dispatches.length, 1); assert.equal(url, '/api/dispatches?limit=50');
  globalThis.fetch = async () => ({ json: async () => ({ code: 1, msg: '拒绝访问' }) });
  await assert.rejects(fetchDispatches(), /拒绝访问/);
});
await t('轮询 3 秒、走秒 1 秒；隐藏停、恢复立即取、慢请求不重叠、卸载丢弃迟到结果', async () => {
  let visible = true, change, calls = 0, resolve, signal, ticks = 0, received = 0, errors = [];
  const timers = new Map();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const stop = startDispatchPolling({ visible: () => visible, now: () => now, every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: fn => { change = fn; return () => { change = null; }; } },
    s => { calls++; signal = s; return new Promise(r => { resolve = r; }); }, () => received++, msg => errors.push(msg), () => ticks++);
  assert.equal(calls, 1); assert.deepEqual([...timers.keys()], [3000, 1000]);
  timers.get(1000)(); assert.equal(ticks, 2);
  timers.get(3000)(); assert.equal(calls, 1);
  visible = false; change(); assert.equal(timers.size, 0); assert.ok(signal.aborted);
  resolve({ dispatches: [run()] }); await flush(); assert.equal(received, 0);
  visible = true; change(); assert.equal(calls, 2);
  resolve({ dispatches: [] }); await flush(); assert.equal(received, 1); assert.deepEqual(errors, ['']);
  timers.get(3000)(); assert.equal(calls, 3);
  stop(); assert.equal(timers.size, 0); assert.equal(change, null); assert.ok(signal.aborted);
  resolve({ dispatches: [] }); await flush(); assert.equal(received, 1);
});
await t('加载失败后可重试；初始隐藏零请求', async () => {
  let visible = false, change, calls = 0, error = '', data = 0;
  const timers = new Map();
  const stop = startDispatchPolling({ visible: () => visible, now: () => now, every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: fn => { change = fn; return () => {}; } }, async () => { if (++calls === 1) throw new Error('离线'); return { dispatches: [] }; }, () => data++, msg => { error = msg; }, () => {});
  assert.equal(calls, 0); visible = true; change(); await Promise.resolve(); await Promise.resolve(); assert.equal(error, '离线');
  timers.get(3000)(); await Promise.resolve(); await Promise.resolve(); assert.equal(data, 1); assert.equal(error, ''); stop();
});
await t('面板路由保留会话/历史预览/页面；关闭恢复，主页和旧链接可用', () => {
  const s = new Store(); s.ensureLoaded = async () => {};
  s.navigate('session-a'); s.toggleDispatches();
  assert.equal(s.dispatchesOpen, true); assert.equal(s.currentId, 'session-a');
  assert.equal(window.location.hash, '#/dispatches');
  s.toggleDispatches(); assert.equal(s.currentId, 'session-a'); assert.equal(window.location.hash, '#/session/session-a');
  s.navigateHistory(); s.selectHistory({ title: '预览' }); const preview = s.historySelection;
  s.toggleDispatches(); assert.equal(s.historyOpen, true); assert.equal(s.historySelection, preview);
  s.toggleDispatches(); assert.equal(s.historySelection, preview); assert.equal(s.currentId, 'session-a');
  s.navigatePage('ai-usage'); s.toggleDispatches(); assert.equal(s.currentPageId, 'ai-usage');
  s.toggleDispatches(); assert.equal(s.currentPageId, 'ai-usage');
  s.navigate('session-a');
  for (const hash of ['#/dispatches', '#/dispatches/run-one', '#/dispatches?runs=one,two']) {
    window.location.hash = hash; s.onHashChange();
    assert.equal(s.currentId, 'session-a'); assert.ok(s.dispatchesOpen);
    s.closeDispatches(); assert.equal(window.location.hash, '#/session/session-a');
  }
  s.toggleDispatches(); s.navigatePage('ai-usage');
  assert.equal(s.dispatchesOpen, true); assert.equal(s.currentPageId, 'ai-usage');
  assert.equal(s.currentId, 'session-a');
  const fresh = new Store(); window.location.hash = '#/dispatches/run-one'; fresh.onHashChange();
  assert.ok(fresh.dispatchesOpen); assert.equal(fresh.currentId, null);
  fresh.closeDispatches(); assert.equal(window.location.hash, '#/');
});
await t('终端与派单所有打开入口互斥，切详情不关闭面板或丢失会话', () => {
  const s = new Store(); s.ensureLoaded = async () => {};
  s.navigate('parent'); s.setTerminalOpen(true);
  s.toggleDispatches(); assert.ok(s.dispatchesOpen); assert.equal(s.termOpen, false);
  s.navigateDispatches(['one']); assert.equal(s.currentId, 'parent');
  s.setTerminalOpen(true); assert.equal(s.dispatchesOpen, false); assert.ok(s.termOpen);
  assert.equal(window.location.hash, '#/session/parent');
  s.navigateDispatches(['one', 'two']); assert.equal(s.termOpen, false); assert.ok(s.dispatchesOpen);
  s.setTerminalOpen(true); window.location.hash = '#/dispatches/old-link'; s.onHashChange();
  assert.equal(s.termOpen, false); assert.ok(s.dispatchesOpen);
  s.closeDispatches(); assert.equal(s.currentId, 'parent'); assert.equal(s.termOpen, false);
});
await t('派单与主区并列，当前会话仍有输入框；主页仍可打开并关闭', () => {
  store.ensureLoaded = async () => {};
  store.sessions = [{ id: 'parent', agent: 'claude', cwd: '/repo', status: 'idle', createdAt: iso(now), title: '父会话', config: {} }];
  store.navigate('parent'); store.navigateDispatches();
  const html = renderToStaticMarkup(React.createElement(App));
  const main = html.match(/<main class="main">([\s\S]*?)<\/main>/)[1];
  assert.ok(main.includes('composer-box')); assert.ok(main.includes('/repo'));
  assert.ok(!main.includes('派单面板')); assert.ok(html.indexOf('aria-label="派单面板"') > html.indexOf('</main>'));
  assert.ok(html.includes('aria-label="关闭派单面板"')); assert.ok(html.includes('aria-label="调整派单面板宽度"'));
  assert.ok(html.includes('aria-label="派单" aria-pressed="true"'));
  assert.ok(main.includes('aria-label="派单" aria-pressed="true"'));
  const sidebar = html.match(/<aside class="sidebar(?: sidebar-page-open)?">([\s\S]*?)<\/aside>/)[1];
  assert.ok(!sidebar.includes('aria-label="派单"'));
  store.closeDispatches(); const closed = renderToStaticMarkup(React.createElement(App));
  assert.ok(closed.includes('composer-box')); assert.ok(!closed.includes('aria-label="派单面板"'));
  store.navigate(null); store.navigateDispatches(); const home = renderToStaticMarkup(React.createElement(App));
  assert.ok(home.includes('aria-label="派单面板"')); assert.ok(home.includes('新建会话'));
  store.closeDispatches(); assert.equal(store.currentId, null);
  const flow = renderToStaticMarkup(React.createElement(DispatchView));
  assert.equal((flow.match(/dispatch-node dispatch-source/g) || []).length, 0);
  assert.ok(!flow.includes('dispatch-intro')); assert.ok(!flow.includes('谁在接力'));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('dispatch-intro'));
  assert.match(css, /--agent-copilot:\s+light-dark\(#8053C8, #B69AEB\)/);
  assert.match(css, /@container dispatch \(min-width: 720px\)/);
  assert.doesNotMatch(css, /\.dispatch-wire\.flow \{ animation: none/); // 不跟随系统减少动画（用户 2026-10-16 定）
  assert.match(css, /\.app.term-open \.main \{\s*display: none/);
  assert.match(css, /\.workspace.term-open \.term-panel \{[\s\S]*?width: auto !important/);
});
await t('小块渲染：多层递归、正确父块、三行内容与身份色；四列以上换行', () => {
  const subagents = [child('Carver', 'parent'), child('Luna', 'parent'), child('Unknown', 'parent'),
    ...Array.from({ length: 3 }, (_, i) => child(`Child${i}`, 'parent')),
    child('Nested', 'Carver', 2), child('Deeper', 'Nested', 3), child('Orphan', 'missing', 2)];
  subagents[0].activity = '正在核对夹具'; subagents[1].role = 'luna'; subagents[1].status = 'finished';
  subagents[2].status = 'unknown';
  const groups = groupDispatches([run({ session: 'parent', subagents })], now);
  const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups, title: '派单人', model: null, now }));
  assert.equal((html.match(/class="dispatch-node dispatch-subagent"/g) || []).length, 8);
  assert.equal((html.match(/class="dispatch-level/g) || []).length, 4);
  assert.ok(html.includes('执行树第 5 层'));
  for (const text of ['Carver', 'luna', 'sol', '运行中', '已完成', '未知', '正在核对夹具', 'Deeper']) assert.ok(html.includes(text));
  assert.ok(html.includes('data-parent-id="Carver"')); assert.ok(!html.includes('Orphan'));
  assert.equal((html.match(/dispatch-subagent-wire flow/g) || []).length, 6);
  assert.ok(html.includes('dispatch-subagent-wire finish')); assert.ok(html.includes('dispatch-subagent-wire idle'));
  assert.ok(html.includes('--wire-color:var(--agent-codex)'));
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dispatch-level \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.dispatch-node \{[^}]*width: min\(148px,/);
  assert.match(css, /\.dispatch-source \{ width: min\(208px, 76%\)/);
  assert.match(css, /\.dispatch-executor.idle \{ width: min\(90px,/);
  assert.ok(!css.includes('min-height: 210px')); assert.ok(!css.includes('min-height: calc((100cqi'));
});
await t('渲染：单 agent 无内嵌块，双 agent 行锚点独立，Claude 只读展示使用珊瑚橙', () => {
  const render = runs => renderToStaticMarkup(React.createElement(DispatchTree, { groups: groupDispatches(runs, now), title: '派单人', model: null, now }));
  const single = render([run()]);
  assert.ok(!single.includes('dispatch-jobs')); assert.ok(!single.includes('dispatch-job-link'));
  assert.equal((single.match(/class="dispatch-job-meta"/g) || []).length, 1);
  const double = render([run({ runId: 'one' }), run({ runId: 'two' })]);
  assert.equal((double.match(/class="dispatch-summary-row/g) || []).length, 2);
  assert.equal((double.match(/class="dispatch-node dispatch-run"/g) || []).length, 2);
  assert.ok(double.includes('data-from="row:'));
  const claude = render([run({ tool: 'claude', native: true, model: 'claude-sonnet-5-5' })]);
  assert.ok(claude.includes('data-tool="claude"')); assert.ok(claude.includes('sonnet-5.5'));
  assert.ok(claude.includes('--wire-color:var(--agent-claude)'));
  assert.ok(!claude.match(/<button[^>]*data-tool="claude"/));
});
await t('树：每单独立计算十分钟连线，无时间 lost 不产生节点/连线', () => {
  const lost = run({ runId: 'lost', status: 'lost', startedAt: null });
  const tree = treeFor([lost, run({ runId: 'active' })]);
  assert.ok(!tree.levels.flat().some(node => node.run?.runId === 'lost'));
  const recent = run({ runId: 'recent', status: 'lost', endedAt: iso(now) });
  const mixed = treeFor([recent, run({ runId: 'old', status: 'OK', endedAt: iso(now - FINISHED_WIRE_MS - 1) })]);
  for (const [id, state] of [['recent', 'finish'], ['old', 'idle']]) {
    const node = mixed.levels[1].find(node => node.run.runId === id);
    assert.equal(mixed.edges.find(edge => edge.to === node.id).state, state);
  }
});
await t('无子 agent 不新增层/连线；空数组和旧列表都保持原来三端布局', () => {
  for (const subagents of [undefined, []]) {
    const groups = groupDispatches([run({ subagents })], now);
    const html = renderToStaticMarkup(React.createElement(DispatchTree, { groups, title: '派单人', model: null, now }));
    assert.ok(!html.includes('dispatch-subagent')); assert.ok(!html.includes('Codex 子 agent'));
    assert.equal((html.match(/class="dispatch-node dispatch-executor/g) || []).length, 3);
    assert.equal((html.match(/class="dispatch-wire /g) || []).length, 3);
  }
});
await t('关闭面板或切到终端后停止列表轮询和走秒，清理在途请求', async () => {
  for (const close of [s => s.closeDispatches(), s => s.setTerminalOpen(true)]) {
    const s = new Store(); s.navigateDispatches();
    const timers = new Map(); let signal, resolve, received = 0, ticks = 0;
    const stop = startDispatchPolling({ visible: () => s.dispatchesOpen, now: () => now,
      every: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: id => timers.delete(id), onVisibility: () => () => {},
    }, value => { signal = value; return new Promise(done => { resolve = done; }); }, () => received++, () => {}, () => ticks++);
    assert.deepEqual([...timers.keys()], [3000, 1000]);
    close(s); stop(); // App 的条件渲染在关闭/互斥时卸载 DispatchPanel。
    assert.equal(timers.size, 0); assert.ok(signal.aborted);
    const previousTicks = ticks; resolve({ dispatches: [run()] });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(received, 0); assert.equal(ticks, previousTicks);
  }
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('{dispatchesOpen && <DispatchPanel'));
  const detail = readFileSync(new URL('../src/components/DispatchDetail.tsx', import.meta.url), 'utf8');
  const history = readFileSync(new URL('../src/components/DispatchHistory.tsx', import.meta.url), 'utf8');
  assert.ok(detail.includes('request?.abort()')); assert.ok(detail.includes('window.clearInterval(tick)'));
  assert.ok(history.includes('controller.abort()')); assert.ok(history.includes('window.clearInterval(timer)'));
});
if (!process.exitCode) console.log(`✅ dispatch flow 全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
