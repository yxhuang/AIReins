import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feishuSender, GateNotifier, gateLabel, gateText, larkCliSender, loadNotifyConfig } from "./notify.js";
import type { SessionRecord, UnifiedEvent } from "./types.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const session = { id: "s1", agent: "claude", cwd: "/home/me/proj", status: "running" } as SessionRecord;
const base = "https://desk.tail1234.ts.net";
let seq = 0;
const event = (type: UnifiedEvent["type"], payload: Record<string, unknown>): UnifiedEvent =>
  ({ type, sessionId: "s1", agentId: "a1", seq: ++seq, timestamp: new Date().toISOString(), payload });

function harness() {
  const sent: string[] = [];
  const notifier = new GateNotifier(
    async (text) => { sent.push(text); },
    (id) => id === "s1" ? session : undefined,
    30,
    base,
    100,
  );
  return { sent, notifier };
}

// 挂起超过延迟才发送，文案包括会话信息和直达链接。
{
  const { sent, notifier } = harness();
  notifier.handle(event("permission_request", { requestId: "r1", toolName: "Bash" }));
  await wait(80);
  assert.deepEqual(sent, [`[AIReins] claude @ proj 有闸门等你处理：Bash\n${base}/#/session/s1`]);
}
// 延迟内解决、进程退出、重复请求都不能额外发送。
{
  const { sent, notifier } = harness();
  const pending = event("permission_request", { requestId: "r1", toolName: "Bash" });
  notifier.handle(pending);
  notifier.handle(pending);
  notifier.handle(event("permission_resolved", { requestId: "r1", decision: "allow" }));
  await wait(80);
  assert.deepEqual(sent, []);
}
{
  const { sent, notifier } = harness();
  notifier.handle(event("permission_request", { requestId: "r1", toolName: "Bash" }));
  notifier.handle(event("process_exited", { code: 0 }));
  await wait(80);
  assert.deepEqual(sent, []);
}
// 同一会话冷却期只发一条；到期时仅补发仍挂起的闸门。
{
  const { sent, notifier } = harness();
  notifier.handle(event("permission_request", { requestId: "r1", toolName: "Bash" }));
  notifier.handle(event("permission_request", { requestId: "r2", toolName: "Write" }));
  notifier.handle(event("permission_request", { requestId: "r3", toolName: "Edit" }));
  await wait(80);
  assert.equal(sent.length, 1);
  notifier.handle(event("permission_resolved", { requestId: "r3", decision: "allow" }));
  await wait(150);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Write/);
}
// 失败被捕获，日志不泄露可能夹在错误文本中的 webhook。
{
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
  try {
    const notifier = new GateNotifier(
      async () => { throw new Error("https://open.feishu.cn/open-apis/bot/v2/hook/secret"); },
      () => session,
      10,
    );
    notifier.handle(event("permission_request", { requestId: "r1", toolName: "Bash" }));
    await wait(50);
    assert.equal(output.length, 1);
    assert.match(output[0], /gate notification failed/);
    assert.doesNotMatch(output[0], /secret|open\.feishu/);
  } finally {
    console.log = original;
  }
}

assert.equal(gateLabel({ interactionType: "ask_user_question", toolName: "AskUserQuestion" }), "提问");
assert.equal(gateLabel({ gate: "terminal/create" }), "terminal/create");
assert.equal(gateText(session, "Bash"), "[AIReins] claude @ proj 有闸门等你处理：Bash");

const dir = await mkdtemp(join(tmpdir(), "workbench-notify-test-"));
const file = join(dir, "notify.json");
assert.equal(loadNotifyConfig(file), null);
await writeFile(file, JSON.stringify({ feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x" }));
assert.equal(loadNotifyConfig(file)?.delaySeconds, 60);
await writeFile(file, JSON.stringify({ larkUserId: "ou_abc123", delaySeconds: 5 }));
assert.deepEqual(loadNotifyConfig(file), { larkUserId: "ou_abc123", delaySeconds: 5 });
for (const bad of [
  { feishuWebhook: "http://x" },
  { feishuWebhook: "https://x", delaySeconds: -1 },
  {},
  { larkUserId: "abc" },
  { larkUserId: "ou_a", feishuWebhook: "https://x" },
]) {
  await writeFile(file, JSON.stringify(bad));
  assert.throws(() => loadNotifyConfig(file), /notify\.json/);
}

// 仅向临时本地假服务发 HTTP 请求，不连接飞书。
const replies = [{ code: 0, msg: "success" }, { StatusCode: 0 }, { code: 19024, msg: "Key Words Not Found" }];
const bodies: unknown[] = [];
const fake = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    bodies.push(JSON.parse(raw));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(replies[bodies.length - 1]));
  });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
try {
  const send = feishuSender(`http://127.0.0.1:${(fake.address() as AddressInfo).port}/hook`);
  await send("a");
  await send("b");
  await assert.rejects(send("c"), /19024/);
  assert.deepEqual(bodies[0], { msg_type: "text", content: { text: "a" } });
} finally {
  fake.closeAllConnections();
  fake.close();
}

// lark-cli：用假脚本代替，不连飞书。假脚本回显参数；第一个参数不是 im 时输出 ok:false。
const fakeCli = join(dir, "fake-lark-cli");
await writeFile(fakeCli, `#!/bin/sh\nif [ "$1" = im ]; then printf '{"ok":true}'; echo "$@" > "${dir}/args"; else printf '{"ok":false}'; fi\n`);
await chmod(fakeCli, 0o755);
await larkCliSender("ou_me", fakeCli)("[AIReins] hi");
assert.equal((await readFile(join(dir, "args"), "utf8")).trim(), "im +messages-send --as bot --user-id ou_me --text [AIReins] hi");
await assert.rejects(larkCliSender("ou_me", join(dir, "missing"))("x"), /lark-cli 发送失败/);
await writeFile(fakeCli, `#!/bin/sh\nprintf '{"ok":false}'\n`);
await assert.rejects(larkCliSender("ou_me", fakeCli)("x"), /lark-cli 发送失败/);

console.log(JSON.stringify({ notifier: 5, text: 3, config: 8, feishu: 4, larkCli: 3 }));
