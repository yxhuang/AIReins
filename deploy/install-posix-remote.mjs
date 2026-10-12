// POSIX installer: read Tailscale state, never change Serve or the user's login.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromStatus, validateConfig } from './windows/install-remote.mjs';

export function setupPosixRemote({ check = false, home, localPort = 8790, platform = process.platform,
  run = spawnSync, available = existsSync, print = console.log }) {
  const path = join(home, 'remote.json');
  let existing = false; let config;
  try {
    lstatSync(path); existing = true; // Keep invalid files and dangling symlinks too.
    config = validateConfig(JSON.parse(readFileSync(path, 'utf8')), localPort);
    print(`✅ remote.json：${config.origin}（已有配置，未覆盖）`);
  } catch (error) {
    if (!existing && error.code === 'ENOENT') print('⚠ remote.json：不存在');
    else { existing = true; print(`⚠ remote.json：${error.message}（未覆盖）`); }
  }
  let tailscale = 'tailscale';
  let result = run(tailscale, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const macTailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (result.error?.code === 'ENOENT' && platform === 'darwin' && available(macTailscale)) {
    tailscale = macTailscale;
    result = run(tailscale, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  }
  if (!check && !existing && !result.error && result.status === 0) {
    try {
      config = configFromStatus(JSON.parse(result.stdout), localPort);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
      print(`✅ remote.json：已生成 ${config.origin}（权限 600，terminal: false）`);
    } catch (error) { print(`⚠ remote.json：未生成，保留现有文件（${error.message}）`); config = undefined; }
  }
  if (result.error || result.status !== 0) print('⚠ Tailscale：未安装、未运行或读取失败；请安装并登录后重跑。');
  if (config) {
    print('Tailscale 与 Workbench 须运行在同一台机器；请自行执行（安装器不会更改 Serve）：');
    print(`  ${JSON.stringify(tailscale)} serve --bg http://127.0.0.1:${config.port}`);
    print('远程终端默认关闭；需要时在 remote.json 显式设置 terminal: true，再自行 wb restart。');
  } else print('参考 server/README.md「远程入口配置」设置 remote.json，再自行执行 tailscale serve。');
  return { created: !check && !existing && !!config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = setupPosixRemote({ check: process.argv[2] === '--check',
      home: process.env.WORKBENCH_HOME ?? join(process.env.HOME, '.workbench'),
      localPort: Number(process.env.WORKBENCH_PORT ?? 8790) });
    if (result.created) process.exitCode = 10;
  } catch (error) { console.error(`⚠ 远程入口：${error.message}`); process.exitCode = 1; }
}
