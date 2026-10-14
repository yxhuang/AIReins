// POSIX installer: enable Serve only when unconfigured; --check is read-only. Never change the user's login.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromStatus, validateConfig } from './windows/install-remote.mjs';

// 输出语言：依次看 LC_ALL → LC_MESSAGES → LANG，zh 开头（大小写不敏感）用中文，否则英文。
const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const T = (z, e) => zh ? z : e;

export function setupPosixRemote({ check = false, home, localPort = 8790, platform = process.platform,
  run = spawnSync, available = existsSync, print = console.log }) {
  const path = join(home, 'remote.json');
  let existing = false; let config;
  try {
    lstatSync(path); existing = true; // Keep invalid files and dangling symlinks too.
    config = validateConfig(JSON.parse(readFileSync(path, 'utf8')), localPort);
    print(T(`✅ remote.json：${config.origin}（已有配置，未覆盖）`, `✅ remote.json: ${config.origin} (existing config, not overwritten)`));
  } catch (error) {
    if (!existing && error.code === 'ENOENT') print(T('⚠ remote.json：不存在', '⚠ remote.json: does not exist'));
    else { existing = true; print(T(`⚠ remote.json：${error.message}（未覆盖）`, `⚠ remote.json: ${error.message} (not overwritten)`)); }
  }
  let tailscale = 'tailscale';
  let result = run(tailscale, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const macTailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (result.error?.code === 'ENOENT' && platform === 'darwin' && available(macTailscale)) {
    tailscale = macTailscale;
    result = run(tailscale, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  }
  let status;
  if (!result.error && result.status === 0) {
    try { status = JSON.parse(result.stdout); }
    catch { print(T('⚠ Tailscale：状态不是有效 JSON，跳过自动配置。', '⚠ Tailscale: status is not valid JSON; skipping automatic configuration.')); }
  }
  if (!check && !existing && status?.BackendState === 'Running') {
    try {
      config = configFromStatus(status, localPort);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
      print(T(`✅ remote.json：已生成 ${config.origin}（权限 600，terminal: false）`, `✅ remote.json: generated ${config.origin} (mode 600, terminal: false)`));
    } catch (error) { print(T(`⚠ remote.json：未生成，保留现有文件（${error.message}）`, `⚠ remote.json: not generated, keeping the existing file (${error.message})`)); config = undefined; }
  }
  if (result.error || result.status !== 0) print(T('⚠ Tailscale：未安装、未运行或读取失败；请安装并登录后重跑。', '⚠ Tailscale: not installed, not running, or unreadable; install it and log in, then rerun.'));
  else if (status && status.BackendState !== 'Running') print(T('⚠ Tailscale：尚未登录或未运行，请登录后重跑。', '⚠ Tailscale: not logged in or not running; log in, then rerun.'));
  if (config) {
    const target = `http://127.0.0.1:${config.port}`;
    const command = `  '${tailscale.replaceAll("'", "'\\''")}' serve --bg ${target}`;
    if (status?.BackendState === 'Running') {
      const invoke = args => {
        const output = run(tailscale, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        if (output.error || output.status !== 0) throw output.error ?? new Error(output.stderr?.trim() || output.stdout?.trim() || `exit ${output.status}`);
        return output.stdout;
      };
      try {
        const serve = JSON.parse(invoke(['serve', 'status', '--json']));
        if (serve !== null && (typeof serve !== 'object' || Array.isArray(serve))) throw new Error(T('Serve 状态格式无效', 'Invalid Serve status format'));
        const empty = serve === null || Object.values(serve).every(value => value == null || (typeof value === 'object' && Object.keys(value).length === 0));
        const hostname = new URL(config.origin).hostname;
        const same = serve?.TCP?.['443']?.HTTPS === true && serve?.Web?.[`${hostname}:443`]?.Handlers?.['/']?.Proxy === target;
        const funnel = Object.values(serve?.AllowFunnel ?? {}).some(Boolean)
          || Object.values(serve?.Foreground ?? {}).some(value => Object.values(value?.AllowFunnel ?? {}).some(Boolean));
        if (same && !funnel) {
          print(T(`✅ Serve：已配置 ${config.origin} → ${target}（未更改）`, `✅ Serve: already configured ${config.origin} → ${target} (unchanged)`));
        } else if (empty) {
          if (check) {
            print(T('⚠ Serve：未配置；--check 只读。运行 bash install.sh 可自动启用：', '⚠ Serve: not configured; --check is read-only. Run bash install.sh to enable it automatically:'));
            print(command);
          } else {
            invoke(['serve', '--bg', target]);
            print(T(`✅ Serve：已启用，远程地址 ${config.origin} → ${target}`, `✅ Serve: enabled; remote address ${config.origin} → ${target}`));
          }
        } else {
          print(T(`⚠ Serve：已有其他配置${funnel ? '（Funnel 已开启）' : ''}，未覆盖；现状：`, `⚠ Serve: other configuration exists${funnel ? ' (Funnel is enabled)' : ''}; not overwritten. Current configuration:`));
          print(JSON.stringify(serve));
          print(T('请先核对现状，再按需手动执行（不得使用 Funnel）：', 'Review the existing configuration, then run manually if needed (do not use Funnel):'));
          print(command);
        }
      } catch (error) {
        print(T(`⚠ Serve：读取或启用失败（${error.message}），未重试。`, `⚠ Serve: could not read or enable it (${error.message}); not retried.`));
        if (/permission|access denied|not permitted|operator|forbidden|must be root|403/i.test(error.message)) {
          print(T('请自行授予当前用户 operator 权限，然后重跑 bash install.sh（安装器不执行 sudo）：', 'Grant operator permission to your user yourself, then rerun bash install.sh (the installer does not run sudo):'));
          print(`  sudo '${tailscale.replaceAll("'", "'\\''")}' set --operator="$USER"`);
        }
        print(command);
      }
    } else {
      print(T('Tailscale 与 AIReins 须在同一台机器；安装并登录后重跑 bash install.sh，或自行执行：', 'Tailscale and AIReins must run on the same machine; install it and log in, then rerun bash install.sh, or run manually:'));
      print(command);
    }
    print(T('远程终端默认关闭；需要时在 remote.json 显式设置 terminal: true，再自行 aireins restart。', 'The remote terminal is off by default; when needed, set terminal: true explicitly in remote.json, then run aireins restart yourself.'));
  } else print(T('参考 server/README.md「远程入口配置」设置 remote.json，再自行执行 tailscale serve。', 'See server/README.md「远程入口配置」to set up remote.json, then run tailscale serve yourself.'));
  return { created: !check && !existing && !!config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = setupPosixRemote({ check: process.argv[2] === '--check',
      home: process.env.WORKBENCH_HOME ?? join(process.env.HOME, '.workbench'),
      localPort: Number(process.env.WORKBENCH_PORT ?? 8790) });
    if (result.created) process.exitCode = 10;
  } catch (error) { console.error(T(`⚠ 远程入口：${error.message}`, `⚠ Remote entry: ${error.message}`)); process.exitCode = 1; }
}
