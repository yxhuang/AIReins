#!/usr/bin/env bash
# 新电脑安装；git pull 后重跑即更新。--check 只体检，不安装。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
source "$REPO/bin/aireins"
# 被 source 的启动器目录仍是同一个仓库。
# 测试桩可能用极简脚本顶替 bin/aireins；缺失语言助手时补一份相同定义。
declare -F wb_is_zh >/dev/null || wb_is_zh() { case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in [zZ][hH]*) return 0;; *) return 1;; esac; }
declare -F say >/dev/null || say() {
  local format="$2"; wb_is_zh && format="$1"; shift 2
  if (( $# )); then printf "$format\n" "$@"; else printf '%s\n' "$format"; fi
}
successes=()
warnings=()
errors=()
windows=false
remote_created=false

ok() { local msg="${2:-$1}"; wb_is_zh && msg="$1"; successes+=("$msg"); printf '✅ %s\n' "$msg"; }
warn() { local msg="${2:-$1}"; wb_is_zh && msg="$1"; warnings+=("$msg"); printf '⚠ %s\n' "$msg"; }
fail() { local msg="${2:-$1}"; wb_is_zh && msg="$1"; errors+=("$msg"); printf '❌ %s\n' "$msg"; }
summary() {
  local format='\n成功 %s 项，⚠ %s 项，❌ %s 项。'
  wb_is_zh || format='\nSucceeded: %s, warnings: %s, errors: %s.'
  printf "$format\n" "${#successes[@]}" "${#warnings[@]}" "${#errors[@]}"
  local item
  for item in "${successes[@]}"; do printf '  ✅ %s\n' "$item"; done
  for item in "${warnings[@]}"; do printf '  ⚠ %s\n' "$item"; done
  for item in "${errors[@]}"; do printf '  ❌ %s\n' "$item"; done
}

case "${1:-}" in
  ''|--check) ;;
  *) say '用法：bash install.sh [--check]' 'Usage: bash install.sh [--check]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then say '用法：bash install.sh [--check]' 'Usage: bash install.sh [--check]' >&2; exit 2; fi

say 'AIReins 安装依赖体检' 'AIReins install dependency check'
case "$PLATFORM" in
  wsl|linux) ok 'Linux' ;;
  darwin) ok 'macOS（实验性）' 'macOS (experimental)' ;;
  *) fail '需要 WSL2、原生 Linux 或 macOS（实验性）。' 'Requires WSL2, native Linux, or macOS (experimental).' ;;
esac
node_version="$(node --version 2>/dev/null || true)"
node_major="${node_version#v}"
node_minor="${node_version#v*.}"
node_major="${node_major%%.*}"
node_minor="${node_minor%%.*}"
# Vite 要求 22.12 起
if [[ "$node_major" =~ ^[0-9]+$ && "$node_minor" =~ ^[0-9]+$ ]] && (( 10#$node_major > 22 || (10#$node_major == 22 && 10#$node_minor >= 12) )); then
  ok "Node $node_version（≥ 22.12）" "Node $node_version (≥ 22.12)"
else
  fail "Node 未安装或版本过低（${node_version:-未安装}）；需要 ≥ 22.12。" "Node is missing or too old (${node_version:-not installed}); need ≥ 22.12."
  if [[ "$PLATFORM" == darwin ]]; then
    say '  请安装 Node ≥ 22.12（https://nodejs.org/），或自行执行 brew install node。' '  Install Node ≥ 22.12 (https://nodejs.org/), or run brew install node yourself.'
  else
    say '  请自行执行（需要 sudo）：' '  Run these yourself (sudo required):'
    printf '%s\n' '  sudo apt-get update && sudo apt-get install -y curl' \
      '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -' \
      '  sudo apt-get install -y nodejs'
  fi
fi
port_tool=ss
[[ "$PLATFORM" == darwin ]] && port_tool=lsof
for dep in npm "$port_tool" rg; do
  if command -v "$dep" >/dev/null 2>&1; then
    ok "$dep 已安装" "$dep installed"
  elif [[ "$dep" == ss ]]; then
    fail '缺少 ss；修复：sudo apt-get install -y iproute2' 'Missing ss; fix: sudo apt-get install -y iproute2'
  elif [[ "$dep" == lsof ]]; then
    fail '缺少 lsof（macOS 端口检测需要）。' 'Missing lsof (needed for port detection on macOS).'
  elif [[ "$dep" == rg ]]; then
    if [[ "$PLATFORM" == darwin ]]; then fail '缺少 rg（ripgrep，文件检索需要）；修复：brew install ripgrep' 'Missing rg (ripgrep, needed for file search); fix: brew install ripgrep'
    else fail '缺少 rg（ripgrep，文件检索需要）；修复：sudo apt-get install -y ripgrep' 'Missing rg (ripgrep, needed for file search); fix: sudo apt-get install -y ripgrep'; fi
  else
    if [[ "$PLATFORM" == darwin ]]; then
      fail '缺少 npm；请重新安装 Node ≥ 22.12（含 npm）。' 'Missing npm; reinstall Node ≥ 22.12 (npm included).'
      continue
    fi
    fail '缺少 npm；修复：用 NodeSource 22 安装 nodejs（含 npm）。' 'Missing npm; fix: install nodejs via NodeSource 22 (npm included).'
    # Node 已达标但 npm 缺失时，也给出完整修复入口。
    printf '%s\n' '  sudo apt-get update && sudo apt-get install -y curl' \
        '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'
  fi
done
for dep in python3 curl; do
  if command -v "$dep" >/dev/null 2>&1; then
    ok "$dep 已安装" "$dep installed"
  else
    if [[ "$PLATFORM" == darwin ]]; then warn "$dep 未安装（aireins status 使用它）；可自行安装。" "$dep is not installed (aireins status uses it); you may install it yourself."
    else warn "$dep 未安装（aireins status 使用它）；可执行 sudo apt-get install -y $dep。" "$dep is not installed (aireins status uses it); you can run sudo apt-get install -y $dep."; fi
  fi
done
cli_found=false
for cli in claude codex kimi; do
  if command -v "$cli" >/dev/null 2>&1; then
    say '  ✅ %s：已安装' '  ✅ %s: installed' "$cli"
    cli_found=true
  else
    say '  %s：未安装' '  %s: not installed' "$cli"
  fi
done
if "$cli_found"; then
  ok '至少一家 Agent CLI 已安装；请确认已登录。' 'At least one Agent CLI is installed; make sure you are logged in.'
else
  warn 'claude / codex / kimi 均未安装；请至少安装并登录一家 CLI。' 'None of claude / codex / kimi is installed; install and log in to at least one CLI.'
fi
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  ok '~/.local/bin 已在 PATH 中' '~/.local/bin is already in PATH'
else
  if [[ "$PLATFORM" == darwin ]]; then warn '~/.local/bin 不在 PATH；请把下面一行加入当前 shell 的配置（通常 ~/.zshrc），重新打开终端：' '~/.local/bin is not in PATH; add the line below to your current shell config (usually ~/.zshrc), then reopen the terminal:'
  else warn '~/.local/bin 不在 PATH；请把下面一行加入 ~/.bashrc，再 source ~/.bashrc：' '~/.local/bin is not in PATH; add the line below to ~/.bashrc, then run source ~/.bashrc:'; fi
  printf '%s\n' '  export PATH="$HOME/.local/bin:$PATH"'
fi
if [[ "$PLATFORM" == wsl ]]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    ok "WSL ${WSL_DISTRO_NAME:-未知发行版}：powershell.exe 可用（安装时检查 interop）" "WSL ${WSL_DISTRO_NAME:-unknown distro}: powershell.exe is available (interop is checked during install)"
    if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then windows=true
    else warn '缺少 WSL_DISTRO_NAME；跳过依赖发行版名称的 Windows 安装。' 'WSL_DISTRO_NAME is missing; skipping the Windows install steps that depend on the distro name.'; fi
  else
    warn 'WSL 中 powershell.exe 不可用，interop 未开启或 Windows PATH 未导入；跳过托盘安装。' 'powershell.exe is not available in WSL; interop is off or the Windows PATH is not imported. Skipping tray install.'
  fi
else
  say '非 WSL 环境：跳过 Windows 托盘与快捷方式安装。' 'Not a WSL environment: skipping Windows tray and shortcut install.'
fi

if [[ "${1:-}" == --check ]] || (( ${#errors[@]} > 0 )); then
  if [[ -x "$HOME/.local/bin/aireins" ]]; then
    ok '~/.local/bin/aireins 已安装' '~/.local/bin/aireins installed'
  else
    warn '~/.local/bin/aireins 未安装；运行 bash install.sh 安装。' '~/.local/bin/aireins is not installed; run bash install.sh to install it.'
  fi
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( 10#$node_major >= 22 )); then
    say $'\n远程入口体检（只读）' $'\nRemote entry check (read-only)'
    if [[ "$PLATFORM" == wsl ]]; then remote_installer="$REPO/deploy/windows/install-remote.mjs"
    else remote_installer="$REPO/deploy/install-posix-remote.mjs"; fi
    node "$remote_installer" --check || warn '远程入口体检未完成，请检查上面的提示。' 'Remote entry check did not complete; see the messages above.'
  else
    warn 'remote.json / Serve / Workbench Remote Gateway：需要 Node ≥ 22 才能体检。' 'remote.json / Serve / Workbench Remote Gateway: Node ≥ 22 is required for this check.'
  fi
  summary
  (( ${#errors[@]} == 0 ))
  exit $?
fi

say $'\n安装 npm 依赖' $'\nInstalling npm dependencies'
if (cd "$REPO" && npm install --no-audit --no-fund); then
  ok 'npm 依赖已安装 / 更新' 'npm dependencies installed / updated'
else
  fail 'npm install 失败，请修复上面的错误后重跑 bash install.sh。' 'npm install failed; fix the errors above and rerun bash install.sh.'
  summary
  exit 1
fi

say $'\n构建前端与预压缩静态资源' $'\nBuilding frontend and precompressing static assets'
if (cd "$REPO" && npm run build); then
  ok '前端已构建 / 更新（保留旧静态资源）' 'Frontend built / updated (old static assets kept)'
else
  fail 'npm run build 失败，安装未完成；请修复构建错误后重跑 bash install.sh。' 'npm run build failed; the install is incomplete. Fix the build errors and rerun bash install.sh.'
  summary
  exit 1
fi

if ! mkdir -p "$HOME/.local/bin"; then
  fail '无法创建 ~/.local/bin，请检查目录权限。' 'Cannot create ~/.local/bin; check the directory permissions.'
  summary
  exit 1
fi
link="$HOME/.local/bin/aireins"
if [[ -d "$link" && ! -L "$link" ]]; then
  fail "$link 已是目录，请先自行处理该目录，再重跑安装。" "$link is already a directory; handle it yourself, then rerun the install."
elif ln -sfn "$REPO/bin/aireins" "$link"; then
  ok "aireins → $REPO/bin/aireins"
else
  fail "无法安装 $link，请检查路径和权限。" "Cannot install $link; check the path and permissions."
fi
for name in wb workbench; do
  link="$HOME/.local/bin/$name"
  if [[ -L "$link" ]]; then
    old_target="$(readlink "$link")"
    [[ "$old_target" == /* ]] || old_target="$(dirname "$link")/$old_target"
    # 只解析现存父目录，旧入口改名后目标文件可能已经不存在；兼容 BSD readlink。
    old_directory="$(cd -P -- "$(dirname "$old_target")" 2>/dev/null && pwd)"
    old_target="$old_directory/${old_target##*/}"
    repo_bin="$(cd -P -- "$REPO/bin" && pwd)"
    if [[ "$old_target" == "$repo_bin/workbench" || "$old_target" == "$repo_bin/aireins" ]]; then
      if unlink "$link"; then
        ok "已移除本仓库旧命令链接 $link；请使用 aireins。" "Removed this repository's old command link $link; use aireins."
      else
        fail "无法移除旧命令链接 $link，请检查路径和权限。" "Cannot remove the old command link $link; check the path and permissions."
      fi
    else
      warn "保留 $link：不是本仓库的命令链接。" "Keeping $link: it is not this repository's command link."
    fi
  elif [[ -e "$link" ]]; then
    warn "保留 $link：不是本仓库的命令链接。" "Keeping $link: it is not this repository's command link."
  fi
done

if "$windows"; then
  say $'\n安装 Windows 托盘与快捷方式' $'\nInstalling Windows tray and shortcuts'
  installer="$(wslpath -w "$REPO/deploy/windows/install-tray.ps1")"
  if [[ -n "$installer" ]] && (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass \
      -File "$installer" -Distro "$WSL_DISTRO_NAME" -WbPath "$REPO/bin/aireins"); then
    ok 'Windows 托盘与快捷方式已安装 / 更新（未启动）' 'Windows tray and shortcuts installed / updated (not started)'
  else
    warn 'Windows 安装失败；修复 interop 或上面的错误后，可在 WSL 手动重跑：' 'Windows install failed; after fixing interop or the errors above, rerun manually in WSL:'
    printf '  cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w %q)" -Distro %q -WbPath %q\n' \
      "$REPO/deploy/windows/install-tray.ps1" "$WSL_DISTRO_NAME" "$REPO/bin/aireins"
  fi
fi

say $'\n配置 Tailscale 远程入口' $'\nConfiguring the Tailscale remote entry'
if [[ "$PLATFORM" == wsl ]]; then remote_installer="$REPO/deploy/windows/install-remote.mjs"
else remote_installer="$REPO/deploy/install-posix-remote.mjs"; fi
node "$remote_installer"
remote_rc=$?
case "$remote_rc" in
  0) ;;
  10) remote_created=true ;;
  *) warn '远程入口自动配置未完成，继续其余安装。' 'Remote entry auto-configuration did not complete; continuing with the rest of the install.' ;;
esac

say $'\n冒烟测试' $'\nSmoke test'
# status 的退出码可能受可选 python3/curl 影响；以“运行中 / Running”输出识别现有服务。
status_output="$("$REPO/bin/aireins" status 2>&1 || true)"
started_pid=''
smoke_ready=true
if [[ "$status_output" == 运行中（PID\ * || "$status_output" == "Running (PID "* ]]; then
  say '服务已运行，验证 /api/meta、首页与静态资源，保留现有服务。' 'The service is already running; verifying /api/meta, the homepage and static assets, and keeping the existing service.'
  if "$remote_created"; then
    warn '运行 aireins restart 使远程入口生效（本次不自动重启）。' 'Run aireins restart for the remote entry to take effect (not restarting automatically this time).'
  fi
else
  start_output="$(WORKBENCH_NO_OPEN=1 "$REPO/bin/aireins" start 2>&1)"
  start_rc=$?
  printf '%s\n' "$start_output"
  # start 也可能遇到并发启动；仅记录本次明确启动的 PID。
  if [[ "$start_output" =~ 已启动（PID\ ([0-9]+)） || "$start_output" =~ Started\ \(PID\ ([0-9]+)\) ]]; then
    started_pid="${BASH_REMATCH[1]}"
  fi
  if (( start_rc != 0 )); then smoke_ready=false; fi
fi
smoke_get() {
  local response
  if command -v curl >/dev/null 2>&1; then
    response="$(curl --noproxy '*' -sS --max-time 3 -w '\n%{http_code}' "$1")" || return 1
    [[ "${response##*$'\n'}" == 200 ]] || return 1
    printf '%s' "${response%$'\n'*}"
  else
    node -e 'fetch(process.argv[1], {signal: AbortSignal.timeout(3000)}).then(r => {
      if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${process.argv[1]}`);
      return r.text();
    }).then(t => process.stdout.write(t)).catch(e => {console.error(e.message); process.exitCode = 1})' "$1"
  fi
}
url="http://127.0.0.1:${WORKBENCH_PORT:-8790}"
if "$smoke_ready"; then
  response="$(smoke_get "$url/api/meta")" || smoke_ready=false
  if "$smoke_ready" && printf '%s' "$response" | node -e '
    let body = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", s => body += s);
    process.stdin.on("end", () => {try {process.exitCode = JSON.parse(body).code === 0 ? 0 : 1} catch {process.exitCode = 1}});
  '; then
    ok '冒烟测试：/api/meta 返回 code: 0' 'Smoke test: /api/meta returned code: 0'
  else
    smoke_ready=false
  fi
fi
if "$smoke_ready"; then
  if homepage="$(smoke_get "$url/")" && asset="$(printf '%s' "$homepage" | node -e '
    let body = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", s => body += s);
    process.stdin.on("end", () => {
      const asset = body.match(/(?:src|href)=[\x22\x27](\/assets\/[^\x22\x27]+)[\x22\x27]/);
      if (asset) process.stdout.write(asset[1]); else process.exitCode = 1;
    });
  ')" && smoke_get "$url$asset" >/dev/null; then
    ok "冒烟测试：首页 / 与静态资源 $asset 返回 200" "Smoke test: the homepage / and the static asset $asset returned 200"
  else
    fail '冒烟测试：首页或引用的静态资源未返回 200，或首页未引用 assets 资源。' 'Smoke test: the homepage or a referenced static asset did not return 200, or the homepage references no assets resource.'
    smoke_ready=false
  fi
fi
if ! "$smoke_ready"; then
  fail "冒烟测试失败；日志尾部（${WORKBENCH_LOG:-$HOME/.workbench/server.log}）：" "Smoke test failed; log tail (${WORKBENCH_LOG:-$HOME/.workbench/server.log}):"
  tail -n 10 "${WORKBENCH_LOG:-$HOME/.workbench/server.log}" 2>/dev/null || true
fi
if [[ -n "$started_pid" ]]; then
  current_status="$("$REPO/bin/aireins" status 2>&1 || true)"
  if [[ "$current_status" == "运行中（PID $started_pid）"* || "$current_status" == "Running (PID $started_pid)"* ]]; then
    if "$REPO/bin/aireins" stop; then
      ok '已停止本次冒烟启动的服务' 'Stopped the service started by this smoke test'
    else
      fail '本次冒烟启动的服务未能停止，请查看上面的提示。' 'Could not stop the service started by this smoke test; see the messages above.'
    fi
  else
    warn '本次启动的 PID 已不在端口上；保留当前服务。' 'The PID started this time is no longer on the port; keeping the current service.'
  fi
fi

summary
if [[ "$PLATFORM" == wsl ]]; then
  say $'\n最后一步：开始菜单（或桌面）找到“AIReins”（改名前安装的为“Workbench 工作台”）→ 右键 → 固定到任务栏（Windows 不提供程序化固定任务栏的可靠接口）。' $'\nFinal step: find “AIReins” (or “Workbench 工作台” if installed before the rename) in the Start menu (or on the desktop) → right-click → Pin to taskbar (Windows has no reliable programmatic way to pin to the taskbar).'
  say '已有同名任务栏固定项时，安装器已一并更新，安装成功后无需重固定。' 'If a taskbar pin with the same name already exists, the installer has updated it; no need to re-pin after a successful install.'
fi
(( ${#errors[@]} == 0 ))
