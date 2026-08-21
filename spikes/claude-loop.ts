import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const root = process.cwd();
const capture = resolve(root, "spikes/captures/claude.ndjson");
const target = resolve(root, "spikes/sandbox/claude-approved.txt");
const expected = `CLAUDE_APPROVED_${Date.now()}`;
mkdirSync(dirname(capture), { recursive: true });

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [/^(authorization|cookie|apiKey|accessToken|refreshToken|authToken|secret)$/i].some((r) => r.test(k))
      ? [k, "[REDACTED]"] : [k, redact(v)]));
  return value;
}
function record(dir: "in" | "out", raw: unknown) {
  appendFileSync(capture, JSON.stringify({ dir, t: Date.now(), raw: redact(raw) }) + "\n");
}
function parse(line: string): unknown {
  try { return JSON.parse(line); } catch { return line; }
}

const env = { ...process.env };
delete env.CLAUDE_CODE_ENTRYPOINT;
const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--include-partial-messages", "--replay-user-messages", "--permission-mode", "manual",
  "--permission-prompt-tool", "stdio",
  "--model", "claude-haiku-4-5-20251001"];
const child = spawn("claude", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
const stderr: string[] = [];
let turns = 0, approvals = 0, replayed = 0, partials = 0, sessionId = "", timedOut = false;

function send(raw: unknown) {
  record("out", raw);
  child.stdin.write(JSON.stringify(raw) + "\n");
}
function user(text: string) {
  send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
createInterface({ input: child.stdout }).on("line", (line) => {
  const raw = parse(line); record("in", raw);
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, any>;
  if (typeof msg.session_id === "string") sessionId = msg.session_id;
  if (msg.type === "user") replayed++;
  if (msg.type === "stream_event") partials++;
  if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
    const response = { type: "control_response", response: { subtype: "success", request_id: msg.request_id,
      response: { behavior: "allow", updatedInput: msg.request.input } } };
    approvals++; send(response);
  }
  if (msg.type === "result") {
    turns++;
    if (turns === 1) user(`使用 Write 工具在 spikes/sandbox/claude-approved.txt 写入 ${expected}，禁止修改其他文件；完成后只回复 OK。`);
    else child.stdin.end();
  }
});

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Claude spike 180s 超时；turns=${turns} approvals=${approvals}\n${stderr.join("")}`);
  child.kill("SIGTERM");
}, 180_000);
user("只回复 OK");

child.on("close", (code, signal) => {
  clearTimeout(timer);
  const fileOk = existsSync(target) && readFileSync(target, "utf8").trim() === expected;
  const ok = !timedOut && code === 0 && turns === 2 && approvals > 0 && replayed >= 2 && partials > 0 && fileOk;
  console.log(JSON.stringify({ ok, code, signal, sessionId, turns, approvals, replayed, partials, fileOk }));
  if (!ok) { console.error(stderr.join("")); process.exitCode = 1; }
});
