import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// 用独立 WORKBENCH_HOME 启动真实路由，验证 /api/uploads 与 /api/uploads/file 的契约。
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const port = await freePort();
const home = await mkdtemp(join(tmpdir(), "workbench-upload-routes-test-"));
const sessionId = "01TESTUPLOAD000000000000001";
await mkdir(join(home, "transcripts"), { recursive: true });
await writeFile(join(home, "sessions.json"), JSON.stringify([{
  id: sessionId,
  agent: "claude",
  agentId: "claude-test",
  cwd: tmpdir(),
  status: "dead",
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  seq: 0,
  transcriptPath: join(home, "transcripts", `${sessionId}.ndjson`),
  config: {},
  riskyMode: false,
}]));

const child = spawnChild(process.execPath, ["--import", "tsx", join(serverDir, "index.ts")], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", () => undefined);

const base = `http://127.0.0.1:${port}`;
async function post(path: string, body: Buffer | string): Promise<{ status: number; data: any }> {
  const response = await fetch(`${base}${path}`, { method: "POST", body: body as BodyInit });
  return { status: response.status, data: await response.json() };
}

try {
  await new Promise<void>((done, fail) => {
    let output = "";
    const timer = setTimeout(() => fail(new Error("测试 server 启动超时")), 15_000);
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`测试 server 提前退出：${code}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes('"message":"workbench server started"')) {
        clearTimeout(timer);
        done();
      }
    });
  });

  // 未知 sessionId 拒绝
  const unknown = await post("/api/uploads?sessionId=nope&name=a.png", "x");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 40401);

  // 缺 name 拒绝
  const noName = await post(`/api/uploads?sessionId=${sessionId}`, "x");
  assert.equal(noName.status, 400);
  assert.equal(noName.data.code, 40070);

  // 正常上传：文件名清洗 + 落盘 + 返回字段
  const payload = Buffer.from("PNG-BYTES-世界");
  const ok = await post(`/api/uploads?sessionId=${sessionId}&name=${encodeURIComponent("../../恶 劣/photo.png")}`, payload);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.data.name, "photo.png");
  assert.equal(ok.data.data.size, payload.length);
  assert.equal(ok.data.data.mimeType, "image/png");
  assert.ok(ok.data.data.path.startsWith(join(home, "uploads", sessionId)));
  assert.deepEqual(await readFile(ok.data.data.path), payload);

  // 超限 413 且不留半截文件
  const big = Buffer.alloc(26 * 1024 * 1024, 0x62);
  const tooBig = await post(`/api/uploads?sessionId=${sessionId}&name=big.bin`, big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.data.code, 41301);
  const leftovers = (await readdir(join(home, "uploads", sessionId))).filter((name) => name.endsWith("big.bin"));
  assert.deepEqual(leftovers, [], "413 后不留半截文件");

  // /api/uploads/file：正常返回与越界/逃逸拒绝
  const file = await fetch(`${base}/api/uploads/file?path=${encodeURIComponent(ok.data.data.path)}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), payload);
  const escaped = await fetch(`${base}/api/uploads/file?path=${encodeURIComponent(join(home, "sessions.json"))}`);
  assert.equal(escaped.status, 404);
  const dotdot = await fetch(`${base}/api/uploads/file?path=${encodeURIComponent(join(home, "uploads", "..", "sessions.json"))}`);
  assert.equal(dotdot.status, 404);
  await symlink(join(home, "sessions.json"), join(home, "uploads", sessionId, "link.json"));
  const viaSymlink = await fetch(`${base}/api/uploads/file?path=${encodeURIComponent(join(home, "uploads", sessionId, "link.json"))}`);
  assert.equal(viaSymlink.status, 404, "指向 uploads 之外的符号链接被拒绝");

  // /api/fs/dirs：默认不带 files；files=1 时同层文件一并列出
  const browseDir = join(home, "browse");
  await mkdir(join(browseDir, "sub"), { recursive: true });
  await writeFile(join(browseDir, "a.txt"), "a");
  const plain = await (await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(browseDir)}`)).json();
  assert.equal(plain.code, 0);
  assert.deepEqual(plain.data.dirs.map((d: any) => d.name), ["sub"]);
  assert.equal("files" in plain.data, false, "默认不列文件");
  const withFiles = await (await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(browseDir)}&files=1`)).json();
  assert.equal(withFiles.code, 0);
  assert.deepEqual(withFiles.data.files.map((f: any) => f.name), ["a.txt"]);
  const badParam = await (await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(browseDir)}&files=yes`)).json();
  assert.equal(badParam.code, 40036);

  assert.ok(existsSync(join(home, "uploads")), "上传目录已创建");
  console.log("✅ uploads HTTP 路由测试全过");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
  await rm(home, { recursive: true, force: true });
}
