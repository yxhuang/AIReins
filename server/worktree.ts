import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeInfo {
  /** 主仓库工作区目录 */
  root: string;
  /** 检出的分支；分离 HEAD 时省略 */
  branch?: string;
}

/** 只读 .git 文件识别链接工作树（git worktree add 建的目录），不调用 git；主仓库、子模块、裸仓库、非仓库或读取出错返回 undefined。 */
export function worktreeOf(cwd: string): WorktreeInfo | undefined {
  try {
    let dir = realpathSync(cwd);
    while (!statSync(join(dir, ".git"), { throwIfNoEntry: false })) {
      if (dir === dirname(dir)) return undefined;
      dir = dirname(dir);
    }
    const gitdir = /^gitdir: (.+)$/m.exec(readFile(join(dir, ".git")))?.[1]?.trim();
    if (!gitdir) return undefined;
    const linked = resolve(dir, gitdir);
    // 只有链接工作树的 gitdir 带 commondir；子模块没有，读失败即返回 undefined。
    const common = resolve(linked, readFile(join(linked, "commondir")).trim());
    // 裸仓库或 --separate-git-dir 的元数据目录推不出主工作区，不归组。
    if (basename(common) !== ".git") return undefined;
    const branch = /^ref: refs\/heads\/(.+)$/m.exec(readFile(join(linked, "HEAD")))?.[1]?.trim();
    return { root: dirname(common), ...(branch ? { branch } : {}) };
  } catch {
    return undefined; // .git 是目录、权限不足、循环链接或链接目标缺失：不影响建会话
  }
}

// 建会话路径上同步调用：只读普通文件，FIFO 等特殊文件会阻塞整个进程。
function readFile(path: string): string {
  if (!statSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  return readFileSync(path, "utf8");
}
