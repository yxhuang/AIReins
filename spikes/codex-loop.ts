import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const root = process.cwd(), capture = resolve(root, "spikes/captures/codex.ndjson");
const target = resolve(root, "spikes/sandbox/codex-approved.txt");
mkdirSync(dirname(capture), { recursive: true });
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/Bearer\s+\S+|\b(sk|sess)-[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    /^(authorization|cookie|apiKey|accessToken|refreshToken|authToken|secret)$/i.test(k) ? [k, "[REDACTED]"] : [k, redact(v)]));
  return value;
}
function record(dir: "in" | "out", raw: unknown) {
  appendFileSync(capture, JSON.stringify({ dir, t: Date.now(), raw: redact(raw) }) + "\n");
}
function parse(line: string): unknown { try { return JSON.parse(line); } catch { return line; } }

const child = spawn("codex", ["app-server", "--stdio"], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const stderr: string[] = [];
let threadId = "", rolloutPath = "", approvals = 0, completed = false, resumed = false, timedOut = false;
function send(raw: unknown) { record("out", raw); child.stdin.write(JSON.stringify(raw) + "\n"); }
function request(id: number, method: string, params: unknown) { send({ jsonrpc: "2.0", id, method, params }); }

child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
createInterface({ input: child.stdout }).on("line", (line) => {
  const raw = parse(line); record("in", raw);
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, any>;
  if (msg.error) console.error(`Codex RPC error: ${JSON.stringify(msg.error)}`);
  if (msg.id === 1 && msg.result) {
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    request(2, "thread/start", {
      cwd: root, approvalPolicy: "untrusted", sandbox: "workspace-write", ephemeral: false
    });
  }
  if (msg.id === 2 && msg.result) {
    threadId = msg.result.thread?.id ?? ""; rolloutPath = msg.result.thread?.path ?? "";
    request(3, "turn/start", { threadId,
      input: [{ type: "text", text: "执行且只执行这个 shell 命令：printf 'CODEX_APPROVED\\n' > spikes/sandbox/codex-approved.txt。不要用 apply_patch，不要修改其他文件；成功后只回复 OK。", text_elements: [] }],
      approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  }
  if (msg.method && Object.hasOwn(msg, "id")) {
    const current = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(msg.method);
    const legacy = ["execCommandApproval", "applyPatchApproval"].includes(msg.method);
    if (current || legacy) { approvals++; send({ jsonrpc: "2.0", id: msg.id, result: { decision: current ? "accept" : "approved" } }); }
  }
  if (msg.method === "turn/completed" && msg.params?.threadId === threadId) {
    completed = true; request(4, "thread/resume", { threadId, cwd: root });
  }
  if (msg.id === 4 && msg.result) { resumed = true; request(5, "thread/unsubscribe", { threadId }); }
  if (msg.id === 5 && msg.result) child.stdin.end();
});

const timer = setTimeout(() => {
  timedOut = true; console.error(`Codex spike 180s 超时；thread=${threadId} approvals=${approvals}\n${stderr.join("")}`);
  child.kill("SIGTERM");
}, 180_000);
request(1, "initialize", { clientInfo: { name: "workbench-spike", title: "Workbench M0", version: "0.0.0" }, capabilities: null });

child.on("close", (code, signal) => {
  clearTimeout(timer);
  const fileOk = existsSync(target) && readFileSync(target, "utf8").trim() === "CODEX_APPROVED";
  const ok = !timedOut && code === 0 && !!threadId && completed && resumed && approvals > 0 && fileOk;
  console.log(JSON.stringify({ ok, code, signal, threadId, rolloutPath, approvals, completed, resumed, fileOk }));
  if (!ok) { console.error(stderr.join("")); process.exitCode = 1; }
});
