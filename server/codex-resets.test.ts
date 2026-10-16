import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexResetWatch } from "./codex-resets.js";

const root = mkdtempSync(join(tmpdir(), "aireins-resets-"));
const fixture = JSON.parse(readFileSync(new URL("./test-fixtures/codex-resets-recent.json", import.meta.url), "utf8"));
const estimate = JSON.parse(readFileSync(new URL("./test-fixtures/codex-resets-estimate.json", import.meta.url), "utf8"));
const INTERVAL = 600_000;
let seq = 0;
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers });
function setup(enabled = true, existingPath?: string) {
  let clock = Date.parse("2026-10-16T00:00:00Z");
  const path = existingPath ?? join(root, `${seq++}.json`);
  const requests: { input: unknown; init?: RequestInit }[] = [];
  const responses: (Response | Error)[] = [];
  const sent: string[] = [], warnings: string[] = [];
  let changes = 0;
  const watch = createCodexResetWatch({ path, enabled, now: () => clock,
    fetch: (async (input: unknown, init?: RequestInit) => {
      requests.push({ input, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, "每次请求必须有本地夹具，不得联网");
      return response;
    }) as typeof fetch,
    send: async (text) => { sent.push(text); }, warn: (message) => warnings.push(message), onChange: () => { changes++; },
  });
  return { watch, path, requests, responses, sent, warnings, changes: () => changes, advance: (ms = INTERVAL) => { clock += ms; } };
}
function newActivity(payload: typeof fixture, key: string, action = "announce", kind = "event_update") {
  const copy = structuredClone(payload);
  const activity = { ...copy.activities[0], id: key, kind, action, publishedAt: "2026-10-16T00:01:00Z", text: "活动中文", fullText: "完整中文" };
  activity.eventIds = copy.events.map((e: { id: string }) => e.id);
  copy.activities.unshift(activity);
  return copy;
}

// 默认关闭：构造/start/poll 都不访问网络；开启立即查询，关闭后停止。
{
  let requests = 0;
  const watch = createCodexResetWatch({ path: join(root, "default.json"), fetch: (async () => { requests++; return json(fixture); }) as typeof fetch });
  assert.equal(watch.status().enabled, false);
  watch.start(); await watch.poll(); assert.equal(requests, 0);
  watch.setEnabled(true); await watch.poll(); assert.equal(requests, 1);
  watch.setEnabled(false); await watch.poll(); assert.equal(requests, 1);
  assert.deepEqual(watch.status().alerts, []); assert.deepEqual(watch.status().pending, []);
  watch.stop();
}

// 首次成功只建基线，带 ETag；304 不重建快照且更新最后成功时间。
{
  const t = setup();
  assert.equal(t.requests.length, 0, "构造不得请求");
  t.responses.push(json(fixture, { etag: '"baseline"' }));
  await t.watch.poll();
  assert.equal(t.sent.length, 0); assert.equal(t.watch.status().alerts.length, 0);
  assert.equal(t.watch.status().recent.length, fixture.events.length);
  assert.equal(t.watch.status().stale, false);
  assert.equal(t.requests[0].input, "https://aihot.news/api/v1/codex-resets/recent");
  assert.ok(t.requests[0].init?.signal instanceof AbortSignal);
  const before = t.watch.status().lastSuccessAt;
  t.advance(); t.responses.push(new Response(null, { status: 304 }));
  await t.watch.poll();
  assert.equal(new Headers(t.requests[1].init?.headers).get("If-None-Match"), '"baseline"');
  assert.notEqual(t.watch.status().lastSuccessAt, before);
  assert.equal(t.sent.length, 0); assert.equal(t.watch.status().recent.length, fixture.events.length);
}

// 同一帖子跨事件/重复 activity 只提醒一次；post 同 id 中文优先；只关注 announce/confirm。
{
  const t = setup();
  t.responses.push(json(fixture)); await t.watch.poll(); t.advance();
  const fresh = newActivity(fixture, "new-post");
  fresh.events[0].status = "announced";
  fresh.events[0].posts.unshift({ ...fresh.events[0].posts[0], id: "new-post", text: "事件帖优先正文", originalText: "Original source text", context: [{ text: "将在接下来 2 小时内落地", originalText: "Landing within the next 2 hours", relation: "quote", url: "https://x.com/i/status/quoted" }] });
  fresh.activities.push(fresh.activities[0]);
  fresh.activities.push({ ...fresh.activities[0], id: "related", kind: "related" });
  fresh.activities.push({ ...fresh.activities[0], id: "amended", action: "amend" });
  t.responses.push(json(fresh)); await t.watch.poll();
  let status = t.watch.status();
  assert.equal(status.alerts.length, 1); assert.equal(status.pending.length, 1);
  assert.equal(status.alerts[0].text, "事件帖优先正文");
  assert.equal(status.alerts[0].originalText, "Original source text");
  assert.equal(status.alerts[0].events.length, fresh.events.length);
  assert.equal(status.alerts[0].context[0].text, "将在接下来 2 小时内落地");
  assert.equal(t.sent.length, 1); assert.match(t.sent[0], /^\[AIReins\] Tibo 预告额度重置/);
  assert.match(t.sent[0], /事件帖优先正文/); assert.match(t.sent[0], /数据来源 AIHOT https:\/\/aihot.news\/codex-reset/);
  t.advance(); t.responses.push(json(fresh)); await t.watch.poll(); assert.equal(t.sent.length, 1);
  const confirm = newActivity(fresh, "confirmed-post", "confirm");
  confirm.events.forEach((e: { status: string }) => { e.status = "confirmed"; });
  t.advance(); t.responses.push(json(confirm)); await t.watch.poll();
  status = t.watch.status(); assert.equal(status.alerts.length, 2); assert.equal(status.pending.length, 0);
  assert.equal(t.sent.length, 2); assert.match(t.sent[1], /已确认重置/);
  const restart = setup(true, t.path);
  assert.equal(restart.watch.status().alerts.length, 2, "未读跨重启恢复");
  const key = status.alerts[0].id;
  t.watch.ack(key); const changes = t.changes(); t.watch.ack(key); t.watch.ack("unknown");
  assert.equal(t.changes(), changes, "重复或未知 ack 幂等，不广播");
  assert.equal(setup(true, t.path).watch.status().alerts.length, 1, "ack 持久恢复");
  const restored = setup(true, t.path);
  restored.responses.push(json(confirm)); await restored.watch.poll();
  assert.equal(restored.sent.length, 0, "重启后 seen 去重仍生效");
  mkdirSync(`${t.path}.tmp`);
  const remaining = t.watch.status().alerts[0].id, beforeFailedAck = t.changes();
  assert.throws(() => t.watch.ack(remaining), /确认未能保存/);
  assert.equal(t.watch.status().alerts[0].id, remaining, "写盘失败回滚 ack，保留未读");
  assert.equal(t.changes(), beforeFailedAck, "写盘失败不广播已读");
  assert.equal(setup(true, t.path).watch.status().alerts.length, 1);
}

// 活动中文/fullText 回退、不翻译英文；重置卡确认文案；estimate 来源保留。
{
  const t = setup(); t.responses.push(json({ ...fixture, activities: [] })); await t.watch.poll();
  const fresh = newActivity(estimate, "estimate-new", "confirm");
  fresh.events[0].type = "reset_credit"; fresh.events[0].schedule = null;
  fresh.activities[0].text = null; fresh.activities[0].fullText = "完整活动中文";
  t.advance(); t.responses.push(json(fresh)); await t.watch.poll();
  assert.equal(t.watch.status().alerts[0].text, "完整活动中文");
  assert.equal(t.watch.status().recent[0].estimate?.basis, "model");
  assert.match(t.sent[0], /重置卡已发放/); assert.match(t.sent[0], /推算/);
  const english = newActivity({ ...fixture, activities: [] }, "english");
  english.events[0].status = "announced";
  english.activities[0].text = "English only"; english.activities[0].fullText = "English as well";
  t.advance(); t.responses.push(json(english)); await t.watch.poll();
  assert.equal(t.watch.status().alerts.find((a) => a.id === "english")?.text, undefined);
  assert.ok(t.sent.at(-1)?.includes(fixture.events[0].title));
  assert.ok(!t.sent.at(-1)?.includes("English only"));
}

// 正文优先级：同 id 的 post.text，再 activity.text/fullText；不把 post.fullText 抢到 activity.text 前面。
{
  const t = setup(); t.responses.push(json(fixture)); await t.watch.poll();
  const fresh = newActivity(fixture, "precedence");
  fresh.events[0].status = "announced";
  fresh.activities[0].text = "活动正文";
  fresh.events[0].posts = [{ id: "precedence", text: "English", fullText: "帖子全文", url: "https://x.com/example/status/precedence" }];
  t.advance(); t.responses.push(json(fresh)); await t.watch.poll();
  assert.equal(t.watch.status().alerts[0].text, "活动正文");
}

// 开机补拉：同一轮已全部确认的预告只记 seen，确认仍提醒；重启后不补发预告。
{
  const t = setup(); t.responses.push(json(fixture)); await t.watch.poll();
  const restarted = setup(true, t.path); restarted.advance(8 * 60 * 60_000);
  const fresh = newActivity(fixture, "overnight-announce");
  fresh.events.forEach((e: { status: string }) => { e.status = "confirmed"; });
  fresh.activities.unshift({ ...fresh.activities[0], id: "overnight-confirm", action: "confirm", publishedAt: "2026-10-16T07:00:00Z" });
  restarted.responses.push(json(fresh)); await restarted.watch.poll();
  assert.deepEqual(restarted.watch.status().alerts.map((a) => a.id), ["overnight-confirm"]);
  assert.equal(restarted.sent.length, 1); assert.match(restarted.sent[0], /已确认重置/);
  assert.ok(JSON.parse(readFileSync(t.path, "utf8")).seen.includes("overnight-announce"));
  fresh.events[0].status = "announced";
  restarted.advance(); restarted.responses.push(json(fresh)); await restarted.watch.poll();
  assert.equal(restarted.sent.length, 1, "已记 seen 的预告不会因后续状态变化再次提醒");
}

// 多事件有一个待确认、关联事件缺失或无关联时，不臆断预告已经被确认取代。
for (const condition of ["pending", "missing", "empty"]) {
  const t = setup(); t.responses.push(json(fixture)); await t.watch.poll(); t.advance();
  const fresh = newActivity(fixture, `not-superseded-${condition}`);
  fresh.events.forEach((e: { status: string }) => { e.status = "confirmed"; });
  if (condition === "pending") fresh.events[0].status = "announced";
  if (condition === "missing") fresh.activities[0].eventIds.push("missing-event");
  if (condition === "empty") fresh.activities[0].eventIds = [];
  t.responses.push(json(fresh)); await t.watch.poll();
  assert.equal(t.sent.length, 1, condition); assert.equal(t.watch.status().alerts.length, 1, condition);
}

// 24 小时界限覆盖两种动作；旧/缺失/非法时间只记 seen，不弹窗也不推送。
for (const action of ["announce", "confirm"]) {
  const cutoff = Date.parse("2026-10-16T00:10:00Z") - 24 * 60 * 60_000;
  for (const [publishedAt, expected] of [
    [new Date(cutoff - 1).toISOString(), 0],
    [new Date(cutoff).toISOString(), 1],
    [new Date(cutoff + 1).toISOString(), 1],
    [null, 0], [undefined, 0], ["not-a-date", 0],
  ] as const) {
    const t = setup(); t.responses.push(json(fixture)); await t.watch.poll(); t.advance();
    const fresh = newActivity(fixture, `time-${action}`, action);
    fresh.events[0].status = action === "announce" ? "announced" : "confirmed";
    fresh.activities[0].publishedAt = publishedAt;
    t.responses.push(json(fresh)); await t.watch.poll();
    assert.equal(t.watch.status().alerts.length, expected, `${action}: ${publishedAt}`);
    assert.equal(t.sent.length, expected, `${action}: ${publishedAt}`);
    assert.ok(JSON.parse(readFileSync(t.path, "utf8")).seen.includes(`time-${action}`));
  }
}

// 长期关闭再打开：超过 24 小时的确认不补发，后续时间修正也不会复活已见帖子。
{
  const t = setup(); t.responses.push(json(fixture)); await t.watch.poll(); t.watch.setEnabled(false);
  t.advance(3 * 24 * 60 * 60_000); t.watch.setEnabled(true);
  const fresh = newActivity(fixture, "long-disabled-confirm", "confirm");
  t.responses.push(json(fresh)); await t.watch.poll();
  assert.equal(t.sent.length, 0); assert.equal(t.watch.status().alerts.length, 0);
  assert.ok(JSON.parse(readFileSync(t.path, "utf8")).seen.includes("long-disabled-confirm"));
  fresh.activities[0].publishedAt = "2026-10-19T00:01:00Z";
  t.advance(); t.responses.push(json(fresh)); await t.watch.poll();
  assert.equal(t.sent.length, 0); assert.equal(t.watch.status().alerts.length, 0);
}

// 429 Retry-After（秒与日期）及 5xx 指数退避；早于截止时间手动 poll 也不访问。
{
  const t = setup(); t.responses.push(new Response(null, { status: 429, headers: { "retry-after": "1800" } }));
  await t.watch.poll(); assert.equal(t.requests.length, 1);
  t.advance(INTERVAL); await t.watch.poll(); assert.equal(t.requests.length, 1);
  t.advance(2 * INTERVAL); t.responses.push(json(fixture)); await t.watch.poll(); assert.equal(t.requests.length, 2);
  t.advance();
  const until = new Date(Date.parse(t.watch.status().lastSuccessAt!) + 4 * INTERVAL).toUTCString();
  t.responses.push(new Response(null, { status: 503, headers: { "retry-after": until } })); await t.watch.poll();
  t.advance(2 * INTERVAL); await t.watch.poll(); assert.equal(t.requests.length, 3);
  t.advance(INTERVAL); t.responses.push(new Response(null, { status: 500 })); await t.watch.poll();
  assert.equal(t.requests.length, 4);
  t.advance(INTERVAL); await t.watch.poll(); assert.equal(t.requests.length, 4, "连续第二次失败退避 20 分钟");
  t.advance(INTERVAL); t.responses.push(new Response(null, { status: 500 })); await t.watch.poll();
  t.advance(4 * INTERVAL); t.responses.push(new Response(null, { status: 500 })); await t.watch.poll();
  assert.equal(t.watch.status().stale, true, "连续失败超过一小时标记陈旧");
  t.advance(5 * INTERVAL); await t.watch.poll(); assert.equal(t.requests.length, 6, "退避上限一小时");
  t.advance(INTERVAL); t.responses.push(json(fixture)); await t.watch.poll();
  assert.equal(t.watch.status().stale, false, "恢复成功清除失败状态");
}

// 坏 JSON、版本不符、网络失败均只有不带正文的 warn；之后首次成功仍只建基线。
{
  const t = setup();
  for (const response of [new Response("SECRET invalid json"), json({ schemaVersion: 2, secret: "SECRET" }), new Error("SECRET network error")]) {
    t.responses.push(response); await t.watch.poll(); t.advance(6 * INTERVAL);
  }
  assert.equal(t.warnings.length, 3); assert.ok(t.warnings.every((s) => !s.includes("SECRET")));
  assert.match(t.warnings[1], /schemaVersion/);
  t.responses.push(json(fixture)); await t.watch.poll(); assert.equal(t.sent.length, 0);
  t.advance(); t.responses.push(json({ schemaVersion: 1, events: [null, {}, { id: "valid", type: "direct_reset", posts: [null, {}], presentation: null }], activities: [null, { id: "empty", kind: "event_update", action: "announce", eventIds: null }], monitor: null, outage: null }));
  await t.watch.poll(); assert.equal(t.watch.status().recent.length, 1); assert.equal(t.watch.status().stale, true);
  t.advance(); t.responses.push(json({ ...fixture, outage: {} })); await t.watch.poll(); assert.equal(t.watch.status().stale, true);
}

// malformed persisted state is ignored, public URL fields reject executable schemes.
{
  const path = join(root, "malformed.json"); writeFileSync(path, "{broken");
  const t = setup(true, path); assert.equal(t.warnings.length, 1);
  const fresh = structuredClone(fixture); fresh.events[0].posts[0].url = "javascript:alert(1)";
  t.responses.push(json(fresh)); await t.watch.poll(); assert.equal(t.watch.status().recent[0].posts[0].url, undefined);
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), "落盘是完整 JSON");
}

// 关闭时抑制已经发出的请求结果和外部通知，并中止请求。
{
  let release!: (response: Response) => void, signal: AbortSignal | undefined;
  let sent = 0;
  const path = join(root, "inflight.json"); writeFileSync(path, JSON.stringify({ version: 1, baseline: true, seen: [] }));
  const watch = createCodexResetWatch({ path, enabled: true,
    fetch: (async (_input, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((resolve) => { release = resolve; }); }) as typeof fetch,
    send: async () => { sent++; },
  });
  const pending = watch.poll(); await Promise.resolve(); watch.setEnabled(false); release(json(fixture)); await pending;
  assert.equal(signal?.aborted, true); assert.equal(watch.status().lastSuccessAt, null); assert.equal(sent, 0);
}

// 半损坏状态不能用 ETag 请求 304，否则永远无法建立首个基线。
{
  const path = join(root, "etag-no-baseline.json"); writeFileSync(path, JSON.stringify({ version: 1, baseline: false, etag: '"old"' }));
  const t = setup(true, path); t.responses.push(json(fixture)); await t.watch.poll();
  assert.equal(new Headers(t.requests[0].init?.headers).get("If-None-Match"), null);
  assert.equal(t.sent.length, 0);
}

console.log("✅ codex resets: offline polling, baseline, dedup, backoff, parsing, ack and restart");
