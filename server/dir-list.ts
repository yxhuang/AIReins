import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadPrefs } from "./prefs.js";

const MAX_DIRS = 1_000;
const MAX_FILES = 1_000;
const GIT_TIMEOUT_MS = 1_500;
/** 非仓库目录里逐个查子仓库的总预算，超出的子仓库不显示标记。 */
const CHILD_REPOS_BUDGET_MS = 2_000;
/** 文件夹取子项里排名最高的状态：未跟踪 < 新增 < 改名 < 删除 < 修改 < 冲突。 */
const GIT_RANK = "UARDM!";
const GIT_MARKS: Record<string, string> = { M: "M", T: "M", A: "A", C: "A", D: "D", R: "R" };
const run = promisify(execFile);

export class DirListError extends Error {}

export interface DirectoryEntry {
  name: string;
  path: string;
  /** files=1 时补充；文件夹大小不累加，读取失败为 null。 */
  size?: number | null;
  modifiedAt?: number | null;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  dirs: DirectoryEntry[];
  truncated: boolean;
  /** 仅在 files=1 时返回：当前目录的普通文件（同样隐藏文件不列出） */
  files?: DirectoryEntry[];
  /** 仅 files=1 且位于 Git 工作区时返回：直接子项名 → 状态字母（文件夹为其下最高状态）；干净仓库为空对象。 */
  git?: Record<string, string>;
}

/** 只读枚举一级子目录；保留逻辑路径，使符号链接中的「上一级」可返回原位置。files=true 时同层普通文件一并列出。 */
export async function listDirectories(rawPath?: string, options: { files?: boolean } = {}): Promise<DirectoryListing> {
  const input = rawPath ?? loadPrefs().directoryBrowserHome ?? process.env.HOME ?? homedir();
  if (!isAbsolute(input) || input.includes("\u0000")) {
    throw new DirListError("path 必须是绝对路径");
  }
  const path = resolve(input);
  // 与读目录并行；慢仓库超时只是不显示标记，不拖住列表。
  const git = options.files === true ? gitStatus(path) : undefined;
  let entries;
  try {
    await access(path, constants.R_OK | constants.X_OK);
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new DirListError("目录不存在、不是目录或无权限读取");
  }

  const dirs: DirectoryListing["dirs"] = [];
  const files: NonNullable<DirectoryListing["files"]> = [];
  let truncated = false;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = join(path, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(child);
        isDir = target.isDirectory();
        isFile = options.files === true && target.isFile();
      } catch {
        continue; // 断链跳过
      }
    }
    if (isDir) {
      try {
        await access(child, constants.R_OK | constants.X_OK);
      } catch {
        continue; // 无权限或枚举后消失的条目均跳过
      }
      if (dirs.length === MAX_DIRS) {
        truncated = true;
        if (!options.files || files.length === MAX_FILES) break;
        continue;
      }
      dirs.push({ name: entry.name, path: child });
    } else if (isFile && options.files === true) {
      if (files.length === MAX_FILES) {
        truncated = true;
        if (dirs.length === MAX_DIRS) break;
        continue;
      }
      files.push({ name: entry.name, path: child });
    }
  }
  if (options.files === true) {
    // 只 stat 已收集的条目；限制并发，避免 Windows/网络盘上同时发起上千次读取。
    const visible = [...dirs, ...files];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, visible.length) }, async () => {
      while (next < visible.length) {
        const index = next++;
        const entry = visible[index]!;
        entry.size = null;
        entry.modifiedAt = null;
        try {
          const info = await stat(entry.path);
          entry.size = index < dirs.length ? null : info.isFile() ? info.size : null;
          entry.modifiedAt = info.mtimeMs;
        } catch { /* 枚举后消失或 stat 不可读时保留名称，不伪造元数据。 */ }
      }
    }));
  }
  // 当前目录不在仓库里时（如 ~/projects），子文件夹若本身是仓库，取其整仓最高状态作文件夹标记。
  const marks = (await git) ?? (options.files === true ? await childRepoMarks(dirs) : undefined);
  return {
    path,
    parent: path === "/" ? null : dirname(path),
    dirs,
    truncated,
    ...(options.files === true ? { files } : {}),
    ...(marks ? { git: marks } : {}),
  };
}

function topMark(marks: Iterable<string>): string | undefined {
  let top: string | undefined;
  for (const mark of marks) if (GIT_RANK.indexOf(mark) > (top ? GIT_RANK.indexOf(top) : -1)) top = mark;
  return top;
}

async function childRepoMarks(dirs: readonly DirectoryEntry[]): Promise<Record<string, string> | undefined> {
  const deadline = Date.now() + CHILD_REPOS_BUDGET_MS;
  const marks: Record<string, string> = {};
  let found = false;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, dirs.length) }, async () => {
    while (next < dirs.length) {
      const dir = dirs[next++]!;
      try { await stat(join(dir.path, ".git")); } catch { continue; } // .git 可为目录或 worktree/submodule 的文件
      const remaining = deadline - Date.now();
      if (remaining < 100) return;
      const status = await gitStatus(dir.path, Math.min(GIT_TIMEOUT_MS, remaining));
      if (!status) continue;
      found = true;
      const top = topMark(Object.values(status));
      if (top) marks[dir.name] = top;
    }
  }));
  return found ? marks : undefined;
}

/** 当前目录一层的 Git 状态；非工作区、git 不可用或超时返回 undefined。--no-optional-locks 避免和 agent 的 git 操作抢 index.lock。 */
export async function gitStatus(path: string, timeout = GIT_TIMEOUT_MS): Promise<Record<string, string> | undefined> {
  const options = { cwd: path, encoding: "utf8" as const, timeout, maxBuffer: 16 << 20 };
  try {
    const prefix = (await run("git", ["--no-optional-locks", "rev-parse", "--show-prefix"], options)).stdout.replace(/\n$/, "");
    // -z 输出的路径相对仓库根且不转义；pathspec 只扫当前子树。
    const tokens = (await run("git", ["--no-optional-locks", "status", "-z", "--untracked-files=normal", "--", "."], options)).stdout.split("\0");
    const marks: Record<string, string> = {};
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const xy = token.slice(0, 2);
      if (/[RC]/.test(xy)) index++; // 改名/复制记录后紧跟旧路径
      if (token.length < 4 || !token.startsWith(prefix, 3)) continue;
      const relative = token.slice(3 + prefix.length);
      const name = relative.split("/", 1)[0]!;
      const mark = xy === "??" ? "U" : /^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy) ? "!" : GIT_MARKS[xy[1] === " " ? xy[0]! : xy[1]!];
      if (name && mark) marks[name] = topMark(marks[name] ? [marks[name], mark] : [mark])!;
    }
    return marks;
  } catch {
    return undefined;
  }
}
