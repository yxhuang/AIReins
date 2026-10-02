import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wb-claude-menu-routes-"));
const bin = join(root, "bin"); mkdirSync(bin);
const wire = join(root, "wire.ndjson");
writeFileSync(join(bin, "claude"), `#!${process.execPath}
const {createInterface}=require('node:readline'); const {appendFileSync}=require('node:fs');
if(process.argv.includes('--version')) { console.log('2.1.285'); process.exit(0); }
const out=m=>console.log(JSON.stringify(m));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); appendFileSync(${JSON.stringify(wire)},line+'\\n'); if(m.type!=='control_request')return;
const success=response=>out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
if(m.request.subtype==='initialize')success({commands:[],models:[{value:'haiku'},{value:'opus',supportsFastMode:true}]});
else if(m.request.subtype==='side_question'){out({type:'system',subtype:'control_request_progress',request_id:m.request_id,status:'started'}); if(m.request.question!=='cancel')success({response:'4',synthetic:false});}
else if(m.request.subtype==='set_max_thinking_tokens'){success({});out({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'fixture-task',task_type:'shell',description:'Fixture task'}]});}
else if(m.request.subtype==='stop_task'){success({});out({type:'system',subtype:'background_tasks_changed',tasks:[]});}
else success({}); });
`, { mode: 0o755 });
for (const name of ["codex", "kimi"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address(); assert(address && typeof address !== "string"); const port = address.port;
assert.notEqual(port, 8790); await new Promise<void>(resolve => listener.close(() => resolve()));
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(),
  env: { ...process.env, WORKBENCH_HOME: root, CLAUDE_CONFIG_DIR: join(root, "config"), WORKBENCH_PORT: String(port), PATH: `${bin}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let output = "";
const ready = new Promise<void>((resolve, reject) => {
  child.stdout.on("data", data => { output += String(data); if (output.includes('"message":"workbench server started"')) resolve(); });
  child.stderr.on("data", data => { output += String(data); });
  child.once("error", reject); child.once("exit", () => reject(new Error(output)));
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
const api = async (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }), signal });
  return { status: response.status, envelope: await response.json() as any };
};
try {
  await ready;
  const created = await api("/api/sessions", "POST", { agent: "claude", cwd: root, snapshot: "skip", config: { model: "haiku" } });
  assert.equal(created.envelope.code, 0); const id = created.envelope.data.session.id; const base = `/api/sessions/${id}`;
  const thinking = await api(`${base}/thinking`, "PUT", { enabled: false });
  assert.equal(thinking.status, 200); assert.equal(thinking.envelope.data.session.config.thinkingLevel, "off");
  assert.equal((await api(`${base}/thinking`, "PUT", { enabled: "false" })).envelope.code, 40069);
  assert.equal((await api(`${base}/thinking`, "PUT", [])).status, 400);
  const caps = await api(`${base}/info/capabilities`); assert.deepEqual(caps.envelope.data, { supportsFastMode: false });
  const answer = await api(`${base}/side-question`, "POST", { question: "2+2?" }); assert.deepEqual(answer.envelope.data, { response: "4", synthetic: false });
  assert.equal((await api(`${base}/side-question`, "POST", { question: " " })).envelope.code, 40069);
  assert.equal((await api(`${base}/tasks/stop`, "POST", { taskId: "unknown" })).envelope.code, 40069);
  assert.equal((await api(`${base}/tasks/stop`, "POST", { taskId: "fixture-task" })).envelope.data.stopped, true);
  const frames = readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert(frames.some(frame => frame.request?.subtype === "stop_task" && frame.request.task_id === "fixture-task"));
  assert.equal(frames.some(frame => frame.request?.task_id === "unknown"), false);
  const before = (await api(`${base}/snapshot`)).envelope.data.seq;
  await api(`${base}/side-question`, "POST", { question: "again" });
  assert.equal((await api(`${base}/snapshot`)).envelope.data.seq, before, "HTTP 侧问不写事件流");
  const cancel = new AbortController();
  const request = api(`${base}/side-question`, "POST", { question: "cancel" }, cancel.signal);
  const rejected = assert.rejects(request, /Abort/);
  // 一次短等待让 HTTP body 送达；不轮询进程或模型。
  await new Promise(resolve => setTimeout(resolve, 100)); cancel.abort(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 100));
  const cancelledFrames = readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const side = cancelledFrames.find(frame => frame.request?.question === "cancel"); assert(side);
  assert(cancelledFrames.some(frame => frame.type === "control_cancel_request" && frame.request_id === side.request_id));
  assert.equal((await api("/api/sessions/missing/thinking", "PUT", { enabled: true })).status, 404);
} finally { clearTimeout(timeout); child.kill("SIGTERM"); await exited; }
console.log("✅ Claude 菜单 HTTP：Thinking 参数/状态、能力、task 白名单、侧问隔离与断连取消");
