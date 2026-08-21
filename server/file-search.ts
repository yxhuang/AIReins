import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

const SEARCH_TIMEOUT_MS = 3_000;
const SEARCH_MAX_BUFFER = 8 * 1024 * 1024;

interface CommandError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  stderr?: string;
  stdout?: string;
}

export function normalizeFileQuery(cwd: string, rawQuery: string): string {
  if (rawQuery.includes("\0")) throw new Error("q 不能包含 NUL 字符");
  if (Buffer.byteLength(rawQuery, "utf8") > 512) throw new Error("q 不能超过 512 字节");

  const root = resolve(cwd);
  if (win32.isAbsolute(rawQuery) && !isAbsolute(rawQuery)) {
    throw new Error("q 不能使用当前 cwd 之外的绝对路径");
  }
  if (isAbsolute(rawQuery)) {
    const absoluteQuery = resolve(rawQuery);
    if (!isWithin(root, absoluteQuery)) throw new Error("q 的绝对路径不能逃出会话 cwd");
    return toPosix(relative(root, absoluteQuery));
  }

  const pathSegments = rawQuery.split(/[\\/]+/u);
  if (pathSegments.includes("..")) throw new Error("q 不能包含 .. 路径段");
  const resolvedQuery = resolve(root, rawQuery);
  if (!isWithin(root, resolvedQuery)) throw new Error("q 不能逃出会话 cwd");
  return rawQuery.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export async function searchFiles(cwd: string, query: string, limit: number): Promise<string[]> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const logicalRoot = resolve(cwd);
  const realRoot = await realpath(logicalRoot);
  const candidates = await listCandidates(logicalRoot);
  const needle = query.toLocaleLowerCase();
  const results: string[] = [];

  for (const relativePath of [...new Set(candidates.map(toPosix))].sort()) {
    if (Date.now() > deadline || results.length >= limit) break;
    if (!relativePath || hasSkippedSegment(relativePath)) continue;
    if (needle && !relativePath.toLocaleLowerCase().includes(needle)) continue;

    const candidate = resolve(logicalRoot, relativePath);
    if (!isWithin(logicalRoot, candidate)) continue;
    try {
      const realCandidate = await realpath(candidate);
      if (!isWithin(realRoot, realCandidate)) continue;
      if (!(await stat(realCandidate)).isFile()) continue;
      results.push(relativePath);
    } catch {
      // 文件在枚举后消失、断链或不可读时跳过；不会把不确定路径暴露给前端。
    }
  }
  return results;
}

async function listCandidates(cwd: string): Promise<string[]> {
  try {
    const output = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"], cwd);
    return splitNull(output);
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError.killed || commandError.signal === "SIGTERM") {
      throw new Error(`文件检索超过 ${SEARCH_TIMEOUT_MS}ms`);
    }
    if (!String(commandError.stderr ?? commandError.message).includes("not a git repository")) {
      throw new Error(`Git 文件枚举失败：${commandError.message}`);
    }
  }

  try {
    const output = await run("rg", [
      "--files", "--hidden", "--null", "--no-messages",
      "--glob", "!.git", "--glob", "!.git/**",
      "--glob", "!node_modules", "--glob", "!node_modules/**",
    ], cwd, true);
    return splitNull(output);
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError.killed || commandError.signal === "SIGTERM") {
      throw new Error(`文件检索超过 ${SEARCH_TIMEOUT_MS}ms`);
    }
    throw new Error(`文件枚举失败：${commandError.message}`);
  }
}

function run(command: string, args: string[], cwd: string, allowNoMatches = false): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: SEARCH_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      if (!error || (allowNoMatches && (error as CommandError).code === 1)) {
        resolveRun(stdout);
        return;
      }
      const commandError = error as CommandError;
      commandError.stdout = stdout;
      commandError.stderr = stderr;
      rejectRun(commandError);
    });
  });
}

function splitNull(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function hasSkippedSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === ".git" || segment === "node_modules");
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
