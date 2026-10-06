// No npm dependencies: install.sh --check must work before npm install.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tailscale = '/mnt/c/Program Files/Tailscale/tailscale.exe';
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const taskName = 'Workbench Remote Gateway';

// Keep in step with server/access.ts loadRemoteConfig; terminal defaults to disabled.
export function validateConfig(value, localPort = 8790) {
  const { port, origin, allowedLogins, terminal } = value ?? {};
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === localPort) {
    throw new Error(`port 必须是 1–65535 的整数且不等于本机端口 ${localPort}`);
  }
  let url;
  try { url = new URL(origin); } catch { /* diagnosed below */ }
  if (typeof origin !== 'string' || !url || url.protocol !== 'https:' || url.origin !== origin || !url.hostname.endsWith('.ts.net')) {
    throw new Error('origin 必须是完整、小写的 HTTPS *.ts.net 地址，不带路径或结尾斜杠');
  }
  if (!Array.isArray(allowedLogins) || !allowedLogins.length || !allowedLogins.every(s => typeof s === 'string' && s !== '')) {
    throw new Error('allowedLogins 必须是非空的字符串数组');
  }
  return { port, origin, allowedLogins, ...(terminal !== undefined ? { terminal: terminal === true } : {}) };
}

export function configFromStatus(status, localPort = 8790) {
  if (status?.BackendState !== 'Running') throw new Error(`Tailscale BackendState 为 ${status?.BackendState ?? '未知'}，需要 Running`);
  const dns = status.Self?.DNSName;
  if (typeof dns !== 'string' || !dns) throw new Error('Self 缺 DNSName');
  const key = String(status.Self?.UserID);
  const login = Object.hasOwn(status.User ?? {}, key) ? status.User[key]?.LoginName : undefined;
  if (typeof login !== 'string' || !login) throw new Error('User 映射缺少 Self.UserID 的 LoginName');
  return validateConfig({ port: 8793, origin: `https://${dns.replace(/\.$/, '')}`, allowedLogins: [login], terminal: false }, localPort);
}

const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
function execute(file, args, timeout = 10000) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

export function setupRemote({ check = false, home, repo, distro, user, localPort = 8790, run = execute, available = existsSync, print = console.log }) {
  const result = { created: false };
  const invoke = (file, args, timeout) => {
    const output = run(file, args, timeout);
    if (output.status !== 0) throw new Error(output.stderr?.trim() || `命令退出 ${output.status}`);
    return output.stdout;
  };
  const path = join(home, '.workbench/remote.json');
  let config; let existing = false;
  try {
    lstatSync(path); existing = true; // Includes dangling symlinks: never replace them.
    const value = JSON.parse(readFileSync(path, 'utf8'));
    config = validateConfig(value, localPort);
    print(`✅ remote.json：${config.origin}（已有配置，未覆盖）`);
    if (value.terminal !== undefined && typeof value.terminal !== 'boolean') print('⚠ remote.json：terminal 类型无效，终端保持关闭');
  } catch (error) {
    if (!existing && error.code === 'ENOENT') print('⚠ remote.json：不存在');
    else { existing = true; print(`⚠ remote.json：${error.message}（未覆盖）`); }
  }
  if (!distro) {
    print('⚠ Serve：非 WSL 环境，跳过 Windows Tailscale 远程入口');
    print(`⚠ ${taskName}：非 WSL 环境，跳过`);
    return result;
  }
  let status; let task; let taskKnown = false;
  if (available(tailscale)) {
    try {
      status = JSON.parse(invoke(tailscale, ['status', '--json']));
      if (status?.BackendState !== 'Running') print(`⚠ Tailscale：BackendState 为 ${status?.BackendState ?? '未知'}，跳过自动配置`);
    } catch (error) { print(`⚠ Tailscale：读取失败，跳过自动配置（${error.message}）`); }
  } else print('⚠ Tailscale：Windows 未安装，跳过自动配置');

  if (!check && !existing && status?.BackendState === 'Running') {
    try {
      const generated = configFromStatus(status, localPort);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(generated) + '\n', { flag: 'wx', mode: 0o600 });
      config = generated;
      result.created = true;
      print(`✅ remote.json：已生成 ${config.origin}（权限 600，terminal: false）`);
      print('如需远程终端改为 true 后 wb restart');
    } catch (error) { print(`⚠ remote.json：未生成，保留现有文件（${error.message}）`); }
  }
  if (available(tailscale)) {
    try {
      const serve = JSON.parse(invoke(tailscale, ['serve', 'status', '--json']));
      const target = config ? serve?.Web?.[`${new URL(config.origin).hostname}:443`]?.Handlers?.['/']?.Proxy : undefined;
      if (Object.values(serve?.AllowFunnel ?? {}).some(Boolean)) print('⚠ Serve：Funnel 已开启，需检查公开访问配置');
      else if (!config) print('⚠ Serve：已读取，缺少有效 remote.json，无法核对 HTTPS 根路径');
      else if (target === 'http://127.0.0.1:8794') print(`✅ Serve：${config.origin} → ${target}`);
      else print(`⚠ Serve：HTTPS / 目标为 ${target ?? '未配置'}，期望 http://127.0.0.1:8794`);
    } catch (error) { print(`⚠ Serve：读取失败（${error.message}）`); }
  } else print('⚠ Serve：Windows 未安装 Tailscale，跳过');

  if (available(powershell)) {
    try {
      // Query errors must not masquerade as a missing task and trigger UAC.
      const query = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $task = Get-ScheduledTask | Where-Object { $_.TaskName -eq '${taskName}' -and $_.TaskPath -eq '\\' }; if ($task) { @{ State = [string]$task.State } | ConvertTo-Json -Compress } else { 'null' }`;
      task = JSON.parse(invoke(powershell, psArgs(query)).trim().replace(/^\uFEFF/, ''));
      taskKnown = true;
      print(task ? `✅ ${taskName}：已存在，状态 ${task.State}（跳过安装）` : `⚠ ${taskName}：不存在`);
    } catch (error) { print(`⚠ ${taskName}：读取失败，跳过安装（${error.message}）`); }
  } else print(`⚠ ${taskName}：Windows PowerShell 5.1 不可用，跳过安装`);

  if (check || task || !config || status?.BackendState !== 'Running') return result;
  if (!/^[a-zA-Z0-9_.-]+$/.test(distro) || !/^[a-zA-Z0-9_.-]+$/.test(user) || !/^\/[a-zA-Z0-9_./=-]+$/.test(home) || /["\r\n]/.test(repo)) {
    print('⚠ 远程网关：发行版、Linux 用户、HOME 或仓库路径不受安装器支持，跳过安装');
    return result;
  }
  const unc = `\\\\wsl.localhost\\${distro}${repo.replaceAll('/', '\\')}\\deploy\\windows\\install-remote-gateway.ps1`;
  const argumentsText = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${unc}" -Distro "${distro}" -LinuxUser "${user}" -LinuxHome "${home}"`;
  const manual = () => {
    print('请在拥有该 WSL 发行版的 Windows 账户下，打开管理员 Windows PowerShell 5.1 执行：');
    print(`& "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ${argumentsText}`);
  };
  if (!taskKnown) { manual(); return result; }
  print('远程网关：将弹出一次 UAC，请以拥有该 WSL 发行版的 Windows 账户允许安装');
  try {
    const script = `$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath ${psLiteral(windowsPowerShell)} -ArgumentList ${psLiteral(argumentsText)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const output = invoke(powershell, psArgs(script), 180000);
    if (output?.trim()) print(output.trim());
    print(`✅ ${taskName}：安装器成功，已核对任务及 Serve 目标`);
  } catch (error) {
    print(`⚠ 远程网关：UAC 被拒绝或安装失败，继续其余安装（${error.message}）`);
    manual();
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = setupRemote({ check: process.argv[2] === '--check', home: process.env.HOME, repo: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), distro: process.env.WSL_DISTRO_NAME ?? '', user: process.env.USER ?? '', localPort: Number(process.env.WORKBENCH_PORT ?? 8790) });
    // install.sh uses 10 solely to remember that the live backend needs a restart.
    if (result.created) process.exitCode = 10;
  } catch (error) { console.error(`⚠ 远程入口：${error.message}`); process.exitCode = 1; }
}
