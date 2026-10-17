// 外部续聊真机冒烟（2026-09-27）。只对临时实例跑（18790 + 临时 WORKBENCH_HOME），会消耗少量真实额度。
// 用法：NO_PROXY='*' node server/scripts/external-resume-smoke.mjs http://127.0.0.1:18790 <claude|codex|kimi> <空目录>
// 流程：工作台记 APPLE → 外部 CLI 续聊记 CHERRY → 工作台问全部单词（应含 CHERRY、出现 external_messages_added）→ 再问（不应再续接）。
// Codex 外部续接会被单写者锁拒绝（EXT_FAILED … active writer），属预期。
import { execFileSync } from "node:child_process";
const [base, agent, cwd] = process.argv.slice(2);
const api = async (path, init) => {
  const r = await fetch(base + path, { headers: { "content-type": "application/json" }, ...init });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${path} ${JSON.stringify(j)}`);
  return j.data;
};
const config = agent === "claude" ? { model: "haiku" } : {};
const { session } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ agent, cwd, config }) });
const id = session.id;
const snap = await api(`/api/sessions/${id}/snapshot`);
const ws = new WebSocket(`${base.replace("http", "ws")}/ws?sessionId=${id}&afterSeq=${snap.seq}`);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let waiter = null, events = [];
ws.onmessage = (m) => {
  const e = JSON.parse(String(m.data));
  events.push(e);
  if (e.type === "permission_request") console.log("!! permission_request", JSON.stringify(e.payload).slice(0, 200));
  if (waiter && (e.type === "turn_completed" || e.type === "session_error")) { const w = waiter; waiter = null; w(e); }
};
async function turn(text) {
  events = [];
  const done = new Promise((ok) => { waiter = ok; });
  ws.send(JSON.stringify({ type: "user_message", sessionId: id, text }));
  const end = await Promise.race([done, new Promise((_, bad) => setTimeout(() => bad(new Error("turn timeout")), 240_000))]);
  const reply = events.filter((e) => e.type === "agent_text_delta").map((e) => e.payload?.text ?? e.payload?.delta ?? "").join("");
  const types = [...new Set(events.map((e) => e.type))];
  return { end: end.type, reply: reply.trim(), types, events };
}
const t1 = await turn("记住单词 APPLE，只回复 OK");
console.log("T1", t1.end, JSON.stringify(t1.reply), t1.types.join(","));
const native = (await api(`/api/sessions/${id}`)).session?.nativeSessionId ?? (await api(`/api/sessions/${id}`)).nativeSessionId;
console.log("native", native);
const ext = "记住单词 CHERRY，只回复 OK";
const cmd = {
  claude: ["claude", ["-p", "--resume", native, "--model", "haiku", ext]],
  codex: ["codex", ["exec", "--skip-git-repo-check", "resume", native, ext]],
  kimi: ["kimi", ["-S", native, "-p", ext]],
}[agent];
const env = { ...process.env }; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDECODE;
let out; try { out = execFileSync(cmd[0], cmd[1], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 }).toString(); } catch (e) { out = "EXT_FAILED " + String(e.stderr).split("\n").filter((l) => /ERROR|error/.test(l)).join(" | ").slice(0, 800); }
console.log("EXT", JSON.stringify(out.trim().slice(-900)));
const t2 = await turn("按顺序列出我让你记住的所有单词，只列单词，用空格分隔");
console.log("T2", t2.end, JSON.stringify(t2.reply), t2.types.join(","));
const extra = t2.events.filter((e) => !["agent_text_delta", "thought_delta", "usage_updated", "user_message", "turn_completed", "raw_event", "ack", "ready"].includes(e.type));
for (const e of extra) console.log("  T2 event", e.type, JSON.stringify(e.payload ?? e).slice(0, 300));
console.log("CHERRY_RECOVERED", /CHERRY/i.test(t2.reply), "APPLE", /APPLE/i.test(t2.reply));
const t3 = await turn("再列一次，只列单词");
console.log("T3", t3.end, JSON.stringify(t3.reply), t3.types.join(","));
ws.close();
await api(`/api/sessions/${id}`, { method: "DELETE" });
