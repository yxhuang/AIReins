#!/usr/bin/env bash
# 新电脑安装；git pull 后重跑即更新。--check 只体检，不安装。
set -uo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)" || exit 1
successes=()
warnings=()
errors=()
windows=false
remote_created=false

ok() { successes+=("$*"); printf '✅ %s\n' "$*"; }
warn() { warnings+=("$*"); printf '⚠ %s\n' "$*"; }
fail() { errors+=("$*"); printf '❌ %s\n' "$*"; }
summary() {
  printf '\n成功 %s 项，⚠ %s 项，❌ %s 项。\n' "${#successes[@]}" "${#warnings[@]}" "${#errors[@]}"
  local item
  for item in "${successes[@]}"; do printf '  ✅ %s\n' "$item"; done
  for item in "${warnings[@]}"; do printf '  ⚠ %s\n' "$item"; done
  for item in "${errors[@]}"; do printf '  ❌ %s\n' "$item"; done
}

case "${1:-}" in
  ''|--check) ;;
  *) printf '用法：bash install.sh [--check]\n' >&2; exit 2 ;;
esac
if (( $# > 1 )); then printf '用法：bash install.sh [--check]\n' >&2; exit 2; fi

printf 'Workbench 安装依赖体检\n'
if [[ "$(uname -s)" == Linux ]]; then
  ok 'Linux'
else
  fail '需要 Linux；请在 WSL Ubuntu 中运行 bash install.sh。'
fi
node_version="$(node --version 2>/dev/null || true)"
node_major="${node_version#v}"
node_minor="${node_version#v*.}"
node_major="${node_major%%.*}"
node_minor="${node_minor%%.*}"
# Vite 要求 22.12 起
if [[ "$node_major" =~ ^[0-9]+$ && "$node_minor" =~ ^[0-9]+$ ]] && (( 10#$node_major > 22 || (10#$node_major == 22 && 10#$node_minor >= 12) )); then
  ok "Node $node_version（≥ 22.12）"
else
  fail "Node 未安装或版本过低（${node_version:-未安装}）；需要 ≥ 22.12。"
  printf '%s\n' '  请自行执行（需要 sudo）：' \
    '  sudo apt-get update && sudo apt-get install -y curl' \
    '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -' \
    '  sudo apt-get install -y nodejs'
fi
for dep in npm ss rg; do
  if command -v "$dep" >/dev/null 2>&1; then
    ok "$dep 已安装"
  elif [[ "$dep" == ss ]]; then
    fail '缺少 ss；修复：sudo apt-get install -y iproute2'
  elif [[ "$dep" == rg ]]; then
    fail '缺少 rg（ripgrep，文件检索需要）；修复：sudo apt-get install -y ripgrep'
  else
    fail '缺少 npm；修复：用 NodeSource 22 安装 nodejs（含 npm）。'
    # Node 已达标但 npm 缺失时，也给出完整修复入口。
    printf '%s\n' '  sudo apt-get update && sudo apt-get install -y curl' \
      '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'
  fi
done
for dep in python3 curl; do
  if command -v "$dep" >/dev/null 2>&1; then
    ok "$dep 已安装"
  else
    warn "$dep 未安装（wb status 使用它）；可执行 sudo apt-get install -y $dep。"
  fi
done
cli_found=false
for cli in claude codex kimi; do
  if command -v "$cli" >/dev/null 2>&1; then
    printf '  ✅ %s：已安装\n' "$cli"
    cli_found=true
  else
    printf '  %s：未安装\n' "$cli"
  fi
done
if "$cli_found"; then
  ok '至少一家 Agent CLI 已安装；请确认已登录。'
else
  warn 'claude / codex / kimi 均未安装；请至少安装并登录一家 CLI。'
fi
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  ok '~/.local/bin 已在 PATH 中'
else
  warn '~/.local/bin 不在 PATH；请把下面一行加入 ~/.bashrc，再 source ~/.bashrc：'
  printf '%s\n' '  export PATH="$HOME/.local/bin:$PATH"'
fi
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    ok "WSL $WSL_DISTRO_NAME：powershell.exe 可用（安装时检查 interop）"
    windows=true
  else
    warn 'WSL 中 powershell.exe 不可用，interop 未开启或 Windows PATH 未导入；跳过托盘安装。'
  fi
else
  printf '非 WSL 环境：跳过 Windows 托盘与快捷方式安装。\n'
fi

if [[ "${1:-}" == --check ]] || (( ${#errors[@]} > 0 )); then
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( 10#$node_major >= 22 )); then
    printf '\n远程入口体检（只读）\n'
    node "$REPO/deploy/windows/install-remote.mjs" --check || warn '远程入口体检未完成，请检查上面的提示。'
  else
    warn 'remote.json / Serve / Workbench Remote Gateway：需要 Node ≥ 22 才能体检。'
  fi
  summary
  (( ${#errors[@]} == 0 ))
  exit $?
fi

printf '\n安装 npm 依赖\n'
if (cd "$REPO" && npm install --no-audit --no-fund); then
  ok 'npm 依赖已安装 / 更新'
else
  fail 'npm install 失败，请修复上面的错误后重跑 bash install.sh。'
  summary
  exit 1
fi

printf '\n构建前端与预压缩静态资源\n'
if (cd "$REPO" && npm run build); then
  ok '前端已构建 / 更新（保留旧静态资源）'
else
  fail 'npm run build 失败，安装未完成；请修复构建错误后重跑 bash install.sh。'
  summary
  exit 1
fi

if ! mkdir -p "$HOME/.local/bin"; then
  fail '无法创建 ~/.local/bin，请检查目录权限。'
  summary
  exit 1
fi
for name in wb workbench; do
  link="$HOME/.local/bin/$name"
  if [[ -L "$link" ]]; then
    old_target="$(readlink "$link")"
    if [[ "$old_target" != "$REPO/bin/workbench" ]]; then
      printf '更新 %s：原指向 %s\n' "$link" "$old_target"
    fi
  elif [[ -e "$link" ]]; then
    printf '更新 %s：原为非软链文件\n' "$link"
  fi
  if [[ -d "$link" && ! -L "$link" ]]; then
    fail "$link 已是目录，请先自行处理该目录，再重跑安装。"
    continue
  fi
  if ln -sfn "$REPO/bin/workbench" "$link"; then
    ok "$name → $REPO/bin/workbench"
  else
    fail "无法安装 $link，请检查路径和权限。"
  fi
done

if "$windows"; then
  printf '\n安装 Windows 托盘与快捷方式\n'
  installer="$(wslpath -w "$REPO/deploy/windows/install-tray.ps1")"
  if [[ -n "$installer" ]] && (cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass \
      -File "$installer" -Distro "$WSL_DISTRO_NAME" -WbPath "$REPO/bin/workbench"); then
    ok 'Windows 托盘与快捷方式已安装 / 更新（未启动）'
  else
    warn 'Windows 安装失败；修复 interop 或上面的错误后，可在 WSL 手动重跑：'
    printf '  cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w %q)" -Distro %q -WbPath %q\n' \
      "$REPO/deploy/windows/install-tray.ps1" "$WSL_DISTRO_NAME" "$REPO/bin/workbench"
  fi
fi

printf '\n配置 Tailscale 远程入口\n'
node "$REPO/deploy/windows/install-remote.mjs"
remote_rc=$?
case "$remote_rc" in
  0) ;;
  10) remote_created=true ;;
  *) warn '远程入口自动配置未完成，继续其余安装。' ;;
esac

printf '\n冒烟测试\n'
# status 的退出码可能受可选 python3/curl 影响；以“运行中”输出识别现有服务。
status_output="$("$REPO/bin/workbench" status 2>&1 || true)"
started_pid=''
smoke_ready=true
if [[ "$status_output" == 运行中（PID\ * ]]; then
  printf '服务已运行，验证 /api/meta、首页与静态资源，保留现有服务。\n'
  if "$remote_created"; then
    warn '运行 wb restart 使远程入口生效（本次不自动重启）。'
  fi
else
  start_output="$(WORKBENCH_NO_OPEN=1 "$REPO/bin/workbench" start 2>&1)"
  start_rc=$?
  printf '%s\n' "$start_output"
  # start 也可能遇到并发启动；仅记录本次明确启动的 PID。
  if [[ "$start_output" =~ 已启动（PID\ ([0-9]+)） ]]; then
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
    ok '冒烟测试：/api/meta 返回 code: 0'
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
    ok "冒烟测试：首页 / 与静态资源 $asset 返回 200"
  else
    fail '冒烟测试：首页或引用的静态资源未返回 200，或首页未引用 assets 资源。'
    smoke_ready=false
  fi
fi
if ! "$smoke_ready"; then
  fail "冒烟测试失败；日志尾部（${WORKBENCH_LOG:-$HOME/.workbench/server.log}）："
  tail -n 10 "${WORKBENCH_LOG:-$HOME/.workbench/server.log}" 2>/dev/null || true
fi
if [[ -n "$started_pid" ]]; then
  current_status="$("$REPO/bin/workbench" status 2>&1 || true)"
  if [[ "$current_status" == "运行中（PID $started_pid）"* ]]; then
    if "$REPO/bin/workbench" stop; then
      ok '已停止本次冒烟启动的服务'
    else
      fail '本次冒烟启动的服务未能停止，请查看上面的提示。'
    fi
  else
    warn '本次启动的 PID 已不在端口上；保留当前服务。'
  fi
fi

summary
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  printf '\n最后一步：开始菜单（或桌面）找到“Workbench 工作台” → 右键 → 固定到任务栏（Windows 不提供程序化固定任务栏的可靠接口）。\n'
  printf '已有同名任务栏固定项时，安装器已一并更新，安装成功后无需重固定。\n'
fi
(( ${#errors[@]} == 0 ))
