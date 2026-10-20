import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeInfo {
  /** 主仓库工作区目录（裸仓库时为仓库目录本身） */
  root: string;
  /** 检出的分支；分离 HEAD 时省略 */
  branch?: string;
}

/** 只读 .git 文件识别链接工作树（git worktree add 建的目录），不调用 git；主仓库、子模块或非仓库返回 undefined。 */
export function worktreeOf(cwd: string): WorktreeInfo | undefined {
  let dir = resolve(cwd);
  let dotGit = join(dir, ".git");
  while (!statSync(dotGit, { throwIfNoEntry: false })) {
    if (dir === dirname(dir)) return undefined;
    dir = dirname(dir);
    dotGit = join(dir, ".git");
  }
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!gitdir) return undefined;
    const linked = resolve(dir, gitdir);
    // 只有链接工作树的 gitdir 带 commondir；子模块没有，读失败即返回 undefined。
    const common = resolve(linked, readFileSync(join(linked, "commondir"), "utf8").trim());
    const branch = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(linked, "HEAD"), "utf8"))?.[1]?.trim();
    return { root: basename(common) === ".git" ? dirname(common) : common, ...(branch ? { branch } : {}) };
  } catch {
    return undefined; // .git 是目录（EISDIR）或链接目标缺失
  }
}
