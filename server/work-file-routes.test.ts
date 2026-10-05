import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_LIMIT, TEXT_LIMIT } from "./work-files.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "workbench-work-file-routes-"));
const cwd = join(home, "workspace");
await mkdir(cwd);
await mkdir(join(home, "bin"));
await mkdir(join(home, "transcripts"));
for (const cli of ["claude", "codex", "kimi"]) await writeFile(join(home, "bin", cli), "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", { mode: 0o700 });
const sessionId = "work-file-session";
await writeFile(join(home, "sessions.json"), JSON.stringify([{
  id: sessionId, agent: "codex", agentId: "main", cwd, status: "dead", createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(), seq: 0, transcriptPath: join(home, "transcripts", "session.ndjson"), config: {}, riskyMode: false,
}]));
await writeFile(join(cwd, "a.html"), "<script>fetch('/api/sessions')</script><p>hello</p>");
await writeFile(join(cwd, "中文 空格.pdf"), "%PDF-1.7\n0123456789");
await writeFile(join(cwd, "a.txt"), "original");
await writeFile(join(cwd, "office.docx"), "office bytes");
await writeFile(join(cwd, "large.pdf"), Buffer.alloc(MEDIA_LIMIT + 1));
const listener = createServer();
await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
const port = (listener.address() as { port: number }).port;
await new Promise<void>(done => listener.close(() => done()));
const child = spawn(process.execPath, ["--import", "tsx", join(root, "server/index.ts")], {
  cwd: root, env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port), PATH: `${join(home, "bin")}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const closed = new Promise<void>(done => child.once("close", () => done()));
let output = "";
child.stderr.on("data", chunk => { output += chunk.toString(); });
const base = `http://127.0.0.1:${port}`;
const query = (name: string, withSession = true) => new URLSearchParams({ path: join(cwd, name), root: cwd, ...(withSession ? { sessionId } : {}) });
const post = (value: unknown, headers = {}) => fetch(`${base}/api/fs/file`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
function foreignHost(path: string): Promise<number> {
  return new Promise((done, fail) => {
    const req = request(`${base}${path}`, { headers: { host: "foreign.example" } }, response => { response.resume(); done(response.statusCode!); });
    req.once("error", fail);
    req.end();
  });
}
async function oversizedThenPdf(value: unknown): Promise<void> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const send = (path: string, body?: string) => new Promise<{ status: number; bytes: Buffer }>((done, fail) => {
    const req = request(`${base}${path}`, {
      agent, method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { range: "bytes=0-4" } : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", fail);
      response.once("end", () => done({ status: response.statusCode!, bytes: Buffer.concat(chunks) }));
    });
    req.once("error", fail);
    req.setTimeout(5_000, () => req.destroy(new Error(`${body === undefined ? "PDF GET" : "oversized POST"} timeout`)));
    req.end(body);
  });
  try {
    const oversized = await send("/api/fs/file", JSON.stringify(value));
    assert.equal(oversized.status, 413, "超限请求必须完整返回413");
    assert.equal(JSON.parse(oversized.bytes.toString()).code, 41300);
    const pdf = await send(`/api/fs/content?${query("中文 空格.pdf")}`);
    assert.equal(pdf.status, 206, "超限请求后同一客户端仍能读取PDF");
    assert.equal(pdf.bytes.toString(), "%PDF-");
  } finally {
    agent.destroy();
  }
}
try {
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`startup timeout: ${output}`)), 15_000);
    child.once("error", fail);
    child.once("close", code => { clearTimeout(timeout); fail(new Error(`server exited ${code}: ${output}`)); });
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes('"message":"workbench server started"')) { clearTimeout(timeout); done(); }
    });
  });
  assert.equal((await fetch(`${base}/api/fs/file?${query("a.txt", false)}`)).status, 403, "任意客户端 root 不授权");
  for (const route of ["file", "content"]) {
    assert.equal(await foreignHost(`/api/fs/${route}?${query("a.txt")}`), 403, "沿用 GET Host 访问检查");
  }
  assert.equal((await post({}, { origin: "https://foreign.example" })).status, 403);
  const unknown = query("a.txt"); unknown.set("sessionId", "unknown");
  assert.equal((await fetch(`${base}/api/fs/file?${unknown}`)).status, 404);
  const original = await (await fetch(`${base}/api/fs/file?${query("a.txt")}`)).json();
  assert.equal(original.code, 0);
  assert.equal(original.data.text, "original");
  const saveBody = { path: join(cwd, "a.txt"), root: cwd, sessionId, version: original.data.version, text: "changed" };
  const saved = await post(saveBody);
  assert.equal(saved.status, 200);
  const savedData = (await saved.json()).data;
  assert.equal(savedData.text, "changed");
  assert.equal(await readFile(saveBody.path, "utf8"), "changed");
  assert.equal((await post(saveBody)).status, 409);
  assert.equal((await post({ ...saveBody, version: savedData.version, text: "\n".repeat(TEXT_LIMIT) })).status, 200, "1 MiB文本即使 JSON 转义也可保存");
  assert.equal((await post({ ...saveBody, version: savedData.version, text: "x".repeat(TEXT_LIMIT + 1) })).status, 413);
  await oversizedThenPdf({ ...saveBody, text: "x".repeat(TEXT_LIMIT * 7) });
  const html = await fetch(`${base}/api/fs/content?${query("a.html")}`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html.headers.get("content-security-policy")!, /sandbox; default-src 'none'/);
  assert.ok(!html.headers.get("content-security-policy")!.includes("allow-scripts"));
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(await html.text(), /<script>/, "返回源码，脚本由 sandbox/CSP 禁止");
  const pdfBytes = await readFile(join(cwd, "中文 空格.pdf"));
  for (const [range, expectedStart, expectedEnd] of [["bytes=0-4", 0, 4], ["bytes=5-", 5, pdfBytes.length - 1], ["bytes=-4", pdfBytes.length - 4, pdfBytes.length - 1]] as const) {
    const pdf = await fetch(`${base}/api/fs/content?${query("中文 空格.pdf")}`, { headers: { range } });
    assert.equal(pdf.status, 206);
    assert.equal(pdf.headers.get("content-range"), `bytes ${expectedStart}-${expectedEnd}/${pdfBytes.length}`);
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), pdfBytes.subarray(expectedStart, expectedEnd + 1));
  }
  for (const range of ["bytes=999-", "bytes=3-2", "bytes=0-1,3-4", "bytes=-0", "items=0-1"]) {
    const pdf = await fetch(`${base}/api/fs/content?${query("中文 空格.pdf")}`, { headers: { range } });
    assert.equal(pdf.status, 416);
    assert.equal(pdf.headers.get("content-range"), `bytes */${pdfBytes.length}`);
  }
  const download = await fetch(`${base}/api/fs/content?${query("中文 空格.pdf")}&download=1`, { headers: { range: "bytes=0-2" } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /^attachment; filename\*=UTF-8''/);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdfBytes);
  assert.equal((await fetch(`${base}/api/fs/content?${query("large.pdf")}`)).status, 413);
  const office = await fetch(`${base}/api/fs/content?${query("office.docx")}&download=1`);
  assert.equal(office.status, 200);
  assert.equal(await office.text(), "office bytes");
  assert.equal((await fetch(`${base}/api/fs/content?${query("a.html")}&download=0`)).status, 400);
  console.log("work-file HTTP: access, session roots, save/conflict/limits, HTML CSP, PDF ranges and downloads passed");
} catch (error) {
  console.error(`work-file test server output:\n${output}`);
  throw error;
} finally {
  child.kill("SIGTERM");
  await closed;
}
