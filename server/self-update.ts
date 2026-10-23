import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyEnvironment } from "./proxy-env.js";
import { prefsPath } from "./prefs.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** 与 scripts/git-hooks/after-pull.sh 的后端判断一致，另加启动脚本 bin/。 */
const NEEDS_RESTART = /^(server|shared|bin)\/|^package(-lock)?\.json$/m;
const NEEDS_INSTALL = /^deploy\/(?!tests\/)(?!.*\/tests\/)(?!.*\.md$)|^bin\/|^install\.sh$|^package(-lock)?\.json$|^scripts\/git-hooks\//m;
const NEEDS_TRAY_RESTART = /^deploy\/windows\/(?:wb-tray\.ps1|install-tray\.ps1|launcher\.cs)$|^deploy\/aireins\.ico$/m;
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
  install: boolean;
  trayRestart: boolean;
  action: "pull" | "push" | "install" | "none" | "diverged";
}

export interface UpdateResult {
  action: "pull" | "push" | "install";
  output: string;
  /** 拉取到后端或依赖改动，需 aireins restart 才生效。 */
  restart: boolean;
  installed: boolean;
  trayRestart: boolean;
}

interface InstallState { pending: boolean; restart: boolean; trayRestart: boolean; branch: string; head: string }
function installStatePath(repo: string, branch: string): string {
  const key = createHash("sha256").update(`${resolve(repo)}\0${branch}`).digest("hex");
  return join(dirname(prefsPath()), "updates", `${key}.json`);
}
function pendingInstall(repo: string, branch: string): InstallState | undefined {
  try {
    const state = JSON.parse(readFileSync(installStatePath(repo, branch), "utf8"));
    if (state?.pending === true && state.branch === branch && typeof state.head === "string"
      && /^[a-f0-9]{40,64}$/.test(state.head) && typeof state.restart === "boolean" && typeof state.trayRestart === "boolean") return state;
  } catch { /* 首次检查没有待安装记录。 */ }
  return undefined;
}
function saveInstallState(repo: string, state: InstallState): void {
  const path = installStatePath(repo, state.branch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

// shortcut: 超时只杀直接子进程，after-pull 里的 npm 可能继续跑；出现卡死再改成按进程组终止。
export function runUpdateCommand(repo: string, command: string, args: string[], timeout = 30_000, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env };
    if (command === "git" && (args[0] === "fetch" || args[0] === "push")) {
      childEnv = proxyEnvironment(childEnv);
    }
    execFile(command, args, { cwd: repo, timeout, maxBuffer: 8 << 20, env: childEnv }, (error, stdout, stderr) => {
      const label = command === "git" ? `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("="))}`
        : args[0]?.endsWith("install.sh") ? "install.sh" : "after-pull.sh";
      if (error?.killed) reject(new SelfUpdateError(500, `${label} 执行超时（${timeout / 1000} 秒），请检查网络或代理后重新检查`));
      else if (error) reject(new SelfUpdateError(500, `${label} 执行失败：${(stderr || stdout || error.message).trim()}`));
      else resolve(stdout + stderr);
    });
  });
}

const run = runUpdateCommand;
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
  const pending = pendingInstall(repo, branch);
  // 重试当前已拉代码的安装不依赖远端网络。
  if (fetch && !pending) await run(repo, "git", ["fetch", "--quiet"], 60_000);
  const head = (await git(repo, "rev-parse", "HEAD")).trim();
  const upstreamHead = (await git(repo, "rev-parse", "@{u}")).trim();
  const [ahead, behind] = (await git(repo, "rev-list", "--left-right", "--count", "HEAD...@{u}")).trim().split(/\s+/).map(Number);
  const aheadLog = lines(await git(repo, "log", `-n${LOG_LIMIT}`, "--format=%h %s", "@{u}..HEAD"));
  const behindLog = lines(await git(repo, "log", `-n${LOG_LIMIT}`, "--format=%h %s", "HEAD..@{u}"));
  const changes = lines(await git(repo, "status", "--porcelain", "-uall"));
  const changed = behind > 0 ? await git(repo, "diff", "--name-only", "--no-renames", head, upstreamHead) : "";
  const install = Boolean(pending) || NEEDS_INSTALL.test(changed);
  const trayRestart = Boolean(pending?.trayRestart) || NEEDS_TRAY_RESTART.test(changed);
  const action = ahead > 0 && behind > 0 ? "diverged" : behind > 0 ? "pull" : pending ? "install" : ahead > 0 || changes.length ? "push" : "none";
  return { branch, upstream, head, upstreamHead, ahead, behind, aheadLog, behindLog, changes, defaultMessage: defaultCommitMessage(changes), action, install, trayRestart };
}

let applying = false;

/**
 * 执行用户在弹窗里确认过的那一步：先核对 HEAD、远端引用和改动列表与弹窗一致，避免推送没看过的内容。
 * 拉取只快进到弹窗里的远端提交；安装相关变动运行 install.sh --update，普通变动运行 after-pull。
 * 安装失败保留本机待办，下一次检查可重试，无需重复拉取。
 */
export async function applyUpdate(input: unknown, repo = REPO): Promise<UpdateResult> {
  const body = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const { action, head, upstreamHead, changes, message, lang } = body;
  if ((action !== "pull" && action !== "push" && action !== "install") || typeof head !== "string" || typeof upstreamHead !== "string"
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
    if (action === "pull" || action === "install") {
      const pending = pendingInstall(repo, current.branch);
      const changed = action === "pull" ? await git(repo, "diff", "--name-only", "--no-renames", head, upstreamHead) : "";
      const restart = Boolean(pending?.restart) || NEEDS_RESTART.test(changed);
      // 关掉已装的钩子，避免 post-merge 与下面重复构建；未装钩子的克隆也照样构建。
      if (action === "pull") await git(repo, "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--quiet", upstreamHead);
      const locale = lang === "en" ? "C.UTF-8" : "zh_CN.UTF-8";
      const env = proxyEnvironment({ ...process.env, LC_ALL: locale, LANG: locale });
      if (current.install) {
        const state = { pending: true, restart, trayRestart: current.trayRestart, branch: current.branch, head: action === "pull" ? upstreamHead : head };
        saveInstallState(repo, state);
        let output: string;
        try {
          output = await run(repo, "bash", [join(repo, "install.sh"), "--update"], 15 * 60_000, env);
        } catch (error) {
          if (error instanceof SelfUpdateError) throw new SelfUpdateError(error.status, `安装未完成；代码已保留。重新检查后可重试安装。${error.message}`);
          throw error;
        }
        saveInstallState(repo, { ...state, pending: false });
        return { action, output: output.trim(), restart, installed: true, trayRestart: state.trayRestart };
      }
      const output = await run(repo, "sh", [join(repo, "scripts/git-hooks/after-pull.sh")], 15 * 60_000, env);
      return { action, output: output.trim(), restart, installed: false, trayRestart: false };
    }
    let output = "";
    if (changes.length) {
      await git(repo, "add", "-A");
      output += await run(repo, "git", ["commit", "-q", "-m", commitMessage], 120_000);
    }
    // 显式推到被比较的上游（与 @{u} 同源解析），不受 push.default、pushRemote、followTags 等配置影响而多推或推错地方。
    const [remote, merge] = (await git(repo, "for-each-ref", "--format=%(upstream:remotename) %(upstream:remoteref)", `refs/heads/${current.branch}`)).trim().split(" ");
    try {
      output += await run(repo, "git", ["push", "--no-follow-tags", remote, `HEAD:${merge}`], 120_000);
    } catch (error) {
      if (!(error instanceof SelfUpdateError)) throw error;
      throw new SelfUpdateError(error.status, `本地提交已保留；推送未完成。重新检查后可再次推送，无需重复提交。${error.message}`);
    }
    return { action, output: output.trim(), restart: false, installed: false, trayRestart: false };
  } finally {
    applying = false;
  }
}
