import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** 与 scripts/git-hooks/after-pull.sh 的后端判断一致，另加启动脚本 bin/。 */
const NEEDS_RESTART = /^(server|shared|bin)\/|^package(-lock)?\.json$/m;
const LOG_LIMIT = 20;

export class SelfUpdateError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface UpdateStatus {
  branch: string;
  upstream: string;
  head: string;
  upstreamHead: string;
  ahead: number;
  behind: number;
  /** 各自最近 20 条提交摘要（%h %s）。 */
  aheadLog: string[];
  behindLog: string[];
  /** git status --porcelain 的行：推送时会被 git add -A 一并提交。 */
  changes: string[];
  /** 不填提交说明时使用，按改动的顶层目录生成。 */
  defaultMessage: string;
  action: "pull" | "push" | "none" | "diverged";
}

export interface UpdateResult {
  action: "pull" | "push";
  output: string;
  /** 拉取到后端或依赖改动，需 aireins restart 才生效。 */
  restart: boolean;
}

// shortcut: 超时只杀直接子进程，after-pull 里的 npm 可能继续跑；出现卡死再改成按进程组终止。
function run(repo: string, command: string, args: string[], timeout = 30_000, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repo, timeout, maxBuffer: 8 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } }, (error, stdout, stderr) => {
      const label = command === "git" ? `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("="))}` : "after-pull.sh";
      if (error) reject(new SelfUpdateError(500, `${label} 执行失败：${(stderr || stdout || error.message).trim()}`));
      else resolve(stdout + stderr);
    });
  });
}

const git = (repo: string, ...args: string[]) => run(repo, "git", args);
const lines = (text: string) => text.split("\n").filter(Boolean);

/** 如 `chore: update frontend, server and scripts`；改名取新路径，带引号的路径去掉引号。 */
export function defaultCommitMessage(changes: string[]): string {
  const areas = [...new Set(changes.map((line) => line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "").split("/")[0]))];
  const shown = areas.length > 4 ? [...areas.slice(0, 3), `${areas.length - 3} more`] : areas;
  return `chore: update ${shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "files"}`;
}

/** fetch=false 只读本地已有的远端引用，用于执行前核对状态。 */
export async function updateStatus(repo = REPO, fetch = true): Promise<UpdateStatus> {
  const branch = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (branch === "HEAD") throw new SelfUpdateError(409, "当前不在任何分支上，无法与远端对比");
  const upstream = (await git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").catch(() => "")).trim();
  if (!upstream) throw new SelfUpdateError(409, `分支 ${branch} 没有设置上游，无法与远端对比`);
  if (fetch) await run(repo, "git", ["fetch", "--quiet"], 60_000);
  const head = (await git(repo, "rev-parse", "HEAD")).trim();
  const upstreamHead = (await git(repo, "rev-parse", "@{u}")).trim();
  const [ahead, behind] = (await git(repo, "rev-list", "--left-right", "--count", "HEAD...@{u}")).trim().split(/\s+/).map(Number);
  const aheadLog = lines(await git(repo, "log", `-n${LOG_LIMIT}`, "--format=%h %s", "@{u}..HEAD"));
  const behindLog = lines(await git(repo, "log", `-n${LOG_LIMIT}`, "--format=%h %s", "HEAD..@{u}"));
  const changes = lines(await git(repo, "status", "--porcelain", "-uall"));
  const action = ahead > 0 && behind > 0 ? "diverged" : behind > 0 ? "pull" : ahead > 0 || changes.length ? "push" : "none";
  return { branch, upstream, head, upstreamHead, ahead, behind, aheadLog, behindLog, changes, defaultMessage: defaultCommitMessage(changes), action };
}

let applying = false;

/**
 * 执行用户在弹窗里确认过的那一步：先核对 HEAD、远端引用和改动列表与弹窗一致，避免推送没看过的内容。
 * 拉取只快进到弹窗里的远端提交，再跑一次 after-pull.sh（依赖变化时 npm install，前端变化时 npm run build）。
 */
export async function applyUpdate(input: unknown, repo = REPO): Promise<UpdateResult> {
  const body = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const { action, head, upstreamHead, changes, message, lang } = body;
  if ((action !== "pull" && action !== "push") || typeof head !== "string" || typeof upstreamHead !== "string"
    || !Array.isArray(changes) || !changes.every((line) => typeof line === "string")) {
    throw new SelfUpdateError(400, "请求必须包含 action、head、upstreamHead 和 changes");
  }
  const commitMessage = (typeof message === "string" ? message.trim() : "") || defaultCommitMessage(changes as string[]);
  if (applying) throw new SelfUpdateError(409, "更新正在进行，请稍候");
  applying = true;
  try {
    const current = await updateStatus(repo, false);
    if (current.action !== action || current.branch !== body.branch || current.upstream !== body.upstream || current.head !== head || current.upstreamHead !== upstreamHead
      || current.changes.join("\n") !== changes.join("\n")) {
      throw new SelfUpdateError(409, "仓库状态已变化，请重新检查");
    }
    if (action === "pull") {
      const changed = await git(repo, "diff", "--name-only", head, upstreamHead);
      // 关掉已装的钩子，避免 post-merge 与下面重复构建；未装钩子的克隆也照样构建。
      await git(repo, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--quiet", upstreamHead);
      const locale = lang === "en" ? "C.UTF-8" : "zh_CN.UTF-8";
      const output = await run(repo, "sh", [join(repo, "scripts/git-hooks/after-pull.sh")], 15 * 60_000, { LC_ALL: locale, LANG: locale });
      return { action, output: output.trim(), restart: NEEDS_RESTART.test(changed) };
    }
    let output = "";
    if (changes.length) {
      await git(repo, "add", "-A");
      output += await run(repo, "git", ["commit", "-q", "-m", commitMessage], 120_000);
    }
    // 显式推到被比较的上游（与 @{u} 同源解析），不受 push.default、pushRemote、followTags 等配置影响而多推或推错地方。
    const [remote, merge] = (await git(repo, "for-each-ref", "--format=%(upstream:remotename) %(upstream:remoteref)", `refs/heads/${current.branch}`)).trim().split(" ");
    output += await run(repo, "git", ["push", "--no-follow-tags", remote, `HEAD:${merge}`], 120_000);
    return { action, output: output.trim(), restart: false };
  } finally {
    applying = false;
  }
}
