import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_DIRS = 1_000;
const MAX_FILES = 1_000;

export class DirListError extends Error {}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  truncated: boolean;
  /** 仅在 files=1 时返回：当前目录的普通文件（同样隐藏文件不列出） */
  files?: { name: string; path: string }[];
}

/** 目录浏览器「主目录」按钮的落点：~/dev（用户的项目根），不存在时退回 $HOME。 */
async function defaultRoot(): Promise<string> {
  const home = process.env.HOME || homedir();
  const dev = join(home, "dev");
  try {
    if ((await stat(dev)).isDirectory()) return dev;
  } catch {
    // 没有 dev 就用 $HOME
  }
  return home;
}

/** 只读枚举一级子目录；保留逻辑路径，使符号链接中的「上一级」可返回原位置。files=true 时同层普通文件一并列出。 */
export async function listDirectories(rawPath?: string, options: { files?: boolean } = {}): Promise<DirectoryListing> {
  const input = rawPath === undefined ? await defaultRoot() : rawPath;
  if (!isAbsolute(input) || input.includes("\u0000")) {
    throw new DirListError("path 必须是绝对路径");
  }
  const path = resolve(input);
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
        continue;
      }
      dirs.push({ name: entry.name, path: child });
    } else if (isFile && options.files === true) {
      if (files.length === MAX_FILES) {
        truncated = true;
        continue;
      }
      files.push({ name: entry.name, path: child });
    }
    if (dirs.length === MAX_DIRS && (!options.files || files.length === MAX_FILES)) break;
  }
  return {
    path,
    parent: path === "/" ? null : dirname(path),
    dirs,
    truncated,
    ...(options.files === true ? { files } : {}),
  };
}
