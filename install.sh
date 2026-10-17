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
  # macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound variable，用 ${a[@]+...} 兜住。
  for item in ${successes[@]+"${successes[@]}"}; do printf '  ✅ %s\n' "$item"; done
  for item in ${warnings[@]+"${warnings[@]}"}; do printf '  ⚠ %s\n' "$item"; done
  for item in ${errors[@]+"${errors[@]}"}; do printf '  ❌ %s\n' "$item"; done
}

check=false
ai_usage_choice=auto
usage() { say '用法：bash install.sh [--check] [--with-ai-usage | --without-ai-usage]' 'Usage: bash install.sh [--check] [--with-ai-usage | --without-ai-usage]' >&2; }
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --with-ai-usage)
      [[ "$ai_usage_choice" != no ]] || { usage; exit 2; }
      ai_usage_choice=yes ;;
    --without-ai-usage)
      [[ "$ai_usage_choice" != yes ]] || { usage; exit 2; }
      ai_usage_choice=no ;;
    *) usage; exit 2 ;;
  esac
done

ai_usage_dir="${AI_USAGE_DIR:-$(dirname "$REPO")/ai-usage}"
ai_usage_manifest="${WORKBENCH_HOME:-$HOME/.workbench}/pages/ai-usage/manifest.json"
ai_usage_port=8788
ai_usage_manifest_created=false

ai_usage_checkout() {
  [[ -f "$ai_usage_dir/deploy/install.sh" && -f "$ai_usage_dir/pyproject.toml" ]] || return 1
  # 只读 [project] 表中的 name；不能把其他表的同名键误认为项目名。
  node -e '
    const fs = require("node:fs");
    try {
      const text = fs.readFileSync(process.argv[1], "utf8");
      const project = text.match(/^\s*\[project\][ \t]*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1];
      process.exitCode = project && /^\s*name\s*=\s*([\x22\x27])ai-usage\1\s*(?:#.*)?$/m.test(project) ? 0 : 1;
    } catch { process.exitCode = 1; }
  ' "$ai_usage_dir/pyproject.toml" >/dev/null 2>&1
}

ai_usage_read_port() {
  local interpreter=python3 value
  [[ ! -x "$ai_usage_dir/.venv/bin/python" ]] || interpreter="$ai_usage_dir/.venv/bin/python"
  # 与 ai-usage 部署脚本一样调用 load_config()；不用 uv run，避免 --check 创建
  # 虚拟环境或下载依赖。-B 禁止在参考检出里生成 __pycache__。
  value="$(cd "$ai_usage_dir" && "$interpreter" -B -c \
    'from server.config import load_config; print(load_config().server.port)' 2>/dev/null)" || value=8788
  if [[ "$value" =~ ^[0-9]{1,5}$ ]] && (( 10#$value > 0 && 10#$value <= 65535 )); then
    ai_usage_port="$((10#$value))"
  else
    ai_usage_port=8788
  fi
}

ai_usage_offline_running() {
  local pid cmd directory expected
  declare -F port_pid >/dev/null && declare -F process_command >/dev/null || return 1
  pid="$(port_pid "$ai_usage_port")" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  cmd="$(process_command "$pid")" || return 1
  [[ "$cmd" =~ (^|[[:space:]])-m[[:space:]]+server\.(main|launch)($|[[:space:]]) ]] || return 1
  if [[ "$PLATFORM" == darwin ]]; then
    directory="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  else
    directory="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  fi
  expected="$(cd -P "$ai_usage_dir" && pwd)" || return 1
  [[ "$directory" == "$expected" ]]
}

ai_usage_check() {
  if ! ai_usage_checkout; then
    say 'ai-usage：未找到（或目录不是 ai-usage）。' 'ai-usage: not found (or directory is not ai-usage).'
  else
    ai_usage_read_port
    if ! ai_usage_offline_running; then
      say 'ai-usage：已找到未运行（未识别到本检出的监听进程）。' 'ai-usage: found, not running (no listening process identified for this checkout).'
    elif [[ -e "$ai_usage_manifest" || -L "$ai_usage_manifest" ]]; then
      say 'ai-usage：已接入。' 'ai-usage: integrated.'
    else
      say 'ai-usage：运行但未接入；用 bash install.sh --with-ai-usage 接入。' 'ai-usage: running, not integrated; use bash install.sh --with-ai-usage.'
    fi
  fi
}

ai_usage_recognized() {
  local response
  if command -v curl >/dev/null 2>&1; then
    response="$(curl --noproxy '*' -fsS --connect-timeout 1 --max-time 3 \
      "http://127.0.0.1:$ai_usage_port/api/summary" 2>/dev/null)" || return 1
  else
    # node:http 不读取代理环境变量，也不跟随重定向。
    response="$(node -e '
      const req = require("node:http").get(process.argv[1], r => {
        if (r.statusCode !== 200) { r.destroy(); process.exitCode = 1; return; }
        let body = "";
        r.setEncoding("utf8");
        r.on("data", chunk => { body += chunk; if (body.length > 1048576) req.destroy(new Error()); });
        r.on("end", () => process.stdout.write(body));
        r.on("error", () => { process.exitCode = 1; });
      });
      const timer = setTimeout(() => req.destroy(new Error()), 3000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => { process.exitCode = 1; });
    ' "http://127.0.0.1:$ai_usage_port/api/summary" 2>/dev/null)" || return 1
  fi
  # main.py summary_payload / ProviderUsage.to_dict / UsageWindow.to_dict。
  # 未登录或全部关闭的 provider 也合法；不凭 HTTP 成功或端口占用认服务。
  printf '%s' "$response" | node -e '
    let body = "";
    const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
    const optionalText = x => x === null || typeof x === "string";
    const date = x => typeof x === "string" && Number.isFinite(Date.parse(x));
    const window = w => object(w) && typeof w.id === "string" && typeof w.label === "string"
      && typeof w.used_pct === "number" && Number.isFinite(w.used_pct)
      && (w.resets_at === null || date(w.resets_at)) && optionalText(w.note);
    const provider = p => object(p) && ["claude", "codex", "kimi"].includes(p.id)
      && typeof p.name === "string" && optionalText(p.plan) && optionalText(p.error)
      && ["ok", "stale", "auth_expired", "error"].includes(p.status) && date(p.fetched_at)
      && Array.isArray(p.windows) && p.windows.every(window);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", s => body += s);
    process.stdin.on("end", () => {
      try {
        const s = JSON.parse(body);
        process.exitCode = object(s) && (s.updated_at === null || date(s.updated_at))
          && Array.isArray(s.providers) && s.providers.every(provider)
          && new Set(s.providers.map(p => p.id)).size === s.providers.length ? 0 : 1;
      } catch { process.exitCode = 1; }
    });
  ' >/dev/null 2>&1
}

ai_usage_integrate() {
  local answer uv_bin name description
  [[ "$ai_usage_choice" != no ]] || { say '已跳过 ai-usage（--without-ai-usage）。' 'Skipped ai-usage (--without-ai-usage).'; return 0; }
  if ai_usage_checkout; then
    ai_usage_read_port
    if [[ -e "$ai_usage_manifest" || -L "$ai_usage_manifest" ]] && ai_usage_recognized; then
      ok 'ai-usage 已接入；保留已有 manifest，不重装服务。' 'ai-usage is integrated; keeping the existing manifest and service.'
      return 0
    fi
  fi
  if [[ "$ai_usage_choice" == auto ]]; then
    if [[ -t 0 && -t 1 ]]; then
      say '是否安装并接入 ai-usage（强烈推荐）[Y/n]' 'Install and integrate ai-usage (strongly recommended)? [Y/n]'
      IFS= read -r answer || answer=n
      case "$answer" in ''|[yY]|[yY][eE][sS]) ;; *) say '已跳过 ai-usage。' 'Skipped ai-usage.'; return 0 ;; esac
    else
      say '非交互安装：跳过 ai-usage；用 bash install.sh --with-ai-usage 安装并接入（强烈推荐）。' 'Non-interactive install: skipping ai-usage; use bash install.sh --with-ai-usage to install and integrate it (strongly recommended).'
      return 0
    fi
  fi
  if [[ -e "$ai_usage_dir" || -L "$ai_usage_dir" ]]; then
    if ! ai_usage_checkout; then
      warn '目标目录不是 ai-usage 检出；跳过，不覆盖。请检查 AI_USAGE_DIR。' 'Target directory is not an ai-usage checkout; skipping without overwriting. Check AI_USAGE_DIR.'
      return 0
    fi
  else
    if ! command -v git >/dev/null 2>&1; then
      warn '缺少 git，无法获取 ai-usage；请安装 git 后重跑 --with-ai-usage。' 'Missing git; cannot fetch ai-usage. Install git and rerun --with-ai-usage.'
      return 0
    fi
    if ! git clone https://github.com/yxhuang/ai-usage.git "$ai_usage_dir" >/dev/null 2>&1; then
      warn 'ai-usage clone 失败；检查网络及目标目录后重跑 --with-ai-usage。' 'ai-usage clone failed; check the network and target directory, then rerun --with-ai-usage.'
      return 0
    fi
    if ! git -C "$ai_usage_dir" checkout --detach "${AI_USAGE_REF:-e67d06b}" >/dev/null 2>&1; then
      warn 'ai-usage 固定版本 checkout 失败；保留检出，请手动检查 AI_USAGE_REF 后再接入。' 'ai-usage pinned checkout failed; keeping the checkout. Check AI_USAGE_REF manually before integrating.'
      return 0
    fi
    if ! ai_usage_checkout; then
      warn '获取的目录不是 ai-usage；跳过接入，请手动检查检出。' 'Fetched directory is not ai-usage; skipping integration. Check the checkout manually.'
      return 0
    fi
  fi
  ai_usage_read_port
  if ! ai_usage_recognized; then
    if [[ "$PLATFORM" == darwin ]]; then
      warn 'macOS 不自动部署 ai-usage；请手工启动后重跑 --with-ai-usage：' 'ai-usage is not deployed automatically on macOS; start it manually, then rerun --with-ai-usage:'
      printf '  cd %q && uv sync && uv run python -m server.launch\n' "$ai_usage_dir"
      return 0
    fi
    uv_bin="$(command -v uv || true)"
    [[ -n "$uv_bin" || ! -x "$HOME/.local/bin/uv" ]] || uv_bin="$HOME/.local/bin/uv"
    if [[ -z "$uv_bin" ]]; then
      warn '缺少 uv，跳过 ai-usage 部署；请自行安装后重跑 --with-ai-usage：' 'Missing uv; skipping ai-usage deployment. Install it yourself, then rerun --with-ai-usage:'
      printf '%s\n' '  curl -LsSf https://astral.sh/uv/install.sh | sh'
      return 0
    fi
    if ! systemctl --user is-system-running >/dev/null 2>&1; then
      warn '用户级 systemd 不可用，跳过 ai-usage 部署；启用后重跑 --with-ai-usage。' 'User systemd is unavailable; skipping ai-usage deployment. Enable it, then rerun --with-ai-usage.'
      if [[ "$PLATFORM" == wsl ]]; then
        say '  在 /etc/wsl.conf 添加 [boot] 下的 systemd=true，然后重启 WSL 发行版。' '  Add systemd=true under [boot] in /etc/wsl.conf, then restart the WSL distro.'
        say '  编辑命令：sudoedit /etc/wsl.conf；保存后在 Windows 终端执行 wsl --shutdown，再打开 WSL。' '  Edit with: sudoedit /etc/wsl.conf; after saving, run wsl --shutdown in a Windows terminal and reopen WSL.'
      else
        say '  请在正常的 systemd 用户登录会话中运行；若用户管理器未启动，可自行执行后重新登录：' '  Run in a regular systemd user login session; if the user manager is stopped, run this yourself and log in again:'
        printf '%s\n' '  sudo systemctl start "user@$(id -u).service"' '  systemctl --user status'
      fi
      return 0
    fi
    # 运行中的 unit 不重装/重启，即使 API 暂不可识别；避免碰现有服务。
    if ! systemctl --user is-active --quiet ai-usage.service >/dev/null 2>&1; then
      if ! bash "$ai_usage_dir/deploy/install.sh" >/dev/null 2>&1; then
        warn 'ai-usage 部署失败；请检查 journalctl --user -u ai-usage -n 50 --no-pager 后重跑 --with-ai-usage。' 'ai-usage deployment failed; check journalctl --user -u ai-usage -n 50 --no-pager, then rerun --with-ai-usage.'
        return 0
      fi
      ai_usage_read_port
    fi
    if ! ai_usage_recognized; then
      warn 'ai-usage /api/summary 未通过识别校验；不写 manifest，请检查服务后重跑 --with-ai-usage。' 'ai-usage /api/summary failed identity validation; no manifest written. Check the service and rerun --with-ai-usage.'
      return 0
    fi
  fi
  if [[ -e "$ai_usage_manifest" || -L "$ai_usage_manifest" ]]; then
    ok 'ai-usage 已运行；保留已有 manifest，不覆盖。' 'ai-usage is running; keeping the existing manifest without overwriting.'
    return 0
  fi
  name='AI usage'; description='Local Claude, Codex and Kimi subscription usage dashboard.'
  if wb_is_zh; then name='AI 用量'; description='本地 Claude、Codex 与 Kimi 订阅额度面板。'; fi
  if node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [file, port, name, description] = process.argv.slice(1);
    const url = `http://127.0.0.1:${port}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id: "ai-usage", name, icon: "📊", type: "iframe",
        url, healthCheck: `${url}/api/summary`, maxWidth: "33%", proxy: true, description }, null, 2) + "\n", { flag: "wx" });
    } catch { process.exitCode = 1; }
  ' "$ai_usage_manifest" "$ai_usage_port" "$name" "$description" >/dev/null 2>&1; then
    ai_usage_manifest_created=true
    ok 'ai-usage 已识别并接入侧栏（已生成 manifest）。' 'ai-usage identified and integrated into the sidebar (manifest created).'
  else
    warn 'ai-usage manifest 未写入（已存在或目录不可写）；保留现有内容，请检查 pages/ai-usage。' 'ai-usage manifest was not written (already exists or directory is not writable); keeping existing content. Check pages/ai-usage.'
  fi
  return 0
}

say 'AIReins 安装依赖体检' 'AIReins install dependency check'
case "$PLATFORM" in
  wsl|linux) ok 'Linux' ;;
  darwin) ok 'macOS（实验性）' 'macOS (experimental)' ;;
  *) fail '需要 WSL2、原生 Linux 或 macOS（实验性）。' 'Requires WSL2, native Linux, or macOS (experimental).' ;;
esac
detect_node() {
  node_version="$(node --version 2>/dev/null || true)"
  node_major="${node_version#v}"
  node_minor="${node_version#v*.}"
  node_major="${node_major%%.*}"
  node_minor="${node_minor%%.*}"
}
# Vite 要求 22.12 起
node_supported() {
  [[ "$node_major" =~ ^[0-9]+$ && "$node_minor" =~ ^[0-9]+$ ]] && (( 10#$node_major > 22 || (10#$node_major == 22 && 10#$node_minor >= 12) ))
}
detect_node
if [[ "$PLATFORM" == darwin && "${1:-}" != --check && -t 0 && -t 1 ]] && command -v brew >/dev/null 2>&1; then
  brew_packages=()
  node_supported || brew_packages+=(node)
  command -v rg >/dev/null 2>&1 || brew_packages+=(ripgrep)
  if (( ${#brew_packages[@]} )); then
    say '通过 Homebrew 安装缺失或版本不足的依赖（%s）？[Y/n]' 'Install missing or outdated dependencies via Homebrew (%s)? [Y/n]' "${brew_packages[*]}"
    brew_answer=''
    if IFS= read -r brew_answer && [[ "$brew_answer" == '' || "$brew_answer" == y || "$brew_answer" == Y ]]; then
      if brew install "${brew_packages[@]}"; then
        ok 'Homebrew 安装完成，重新检查依赖。' 'Homebrew install finished; checking dependencies again.'
      else
        warn 'Homebrew 安装失败，下面给出仍缺依赖的修复提示。' 'Homebrew install failed; fixes for dependencies still missing are shown below.'
      fi
      detect_node
    fi
  fi
fi
if node_supported; then
  ok "Node ${node_version}（≥ 22.12）" "Node $node_version (≥ 22.12)"
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
    else warn "$dep 未安装（aireins status 使用它）；可执行 sudo apt-get install -y ${dep}。" "$dep is not installed (aireins status uses it); you can run sudo apt-get install -y $dep."; fi
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

if "$check" || (( ${#errors[@]} > 0 )); then
  ai_usage_check
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
  fail "无法安装 ${link}，请检查路径和权限。" "Cannot install $link; check the path and permissions."
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
        ok "已移除本仓库旧命令链接 ${link}；请使用 aireins。" "Removed this repository's old command link $link; use aireins."
      else
        fail "无法移除旧命令链接 ${link}，请检查路径和权限。" "Cannot remove the old command link $link; check the path and permissions."
      fi
    else
      warn "保留 ${link}：不是本仓库的命令链接。" "Keeping $link: it is not this repository's command link."
    fi
  elif [[ -e "$link" ]]; then
    warn "保留 ${link}：不是本仓库的命令链接。" "Keeping $link: it is not this repository's command link."
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

# 在任何新 AIReins 进程启动前创建扩展页，使启动扫描能发现它。
ai_usage_integrate

say $'\n冒烟测试' $'\nSmoke test'
# status 的退出码可能受可选 python3/curl 影响；以“运行中 / Running”输出识别现有服务。
status_output="$("$REPO/bin/aireins" status 2>&1 || true)"
started_pid=''
smoke_ready=true
if [[ "$status_output" == 运行中（PID\ * || "$status_output" == "Running (PID "* ]]; then
  say '服务已运行，验证 /api/meta、首页与静态资源，保留现有服务。' 'The service is already running; verifying /api/meta, the homepage and static assets, and keeping the existing service.'
  if "$ai_usage_manifest_created"; then
    warn 'aireins restart 后侧栏出现 ai-usage（会中断所有会话）；本次不自动重启。' 'ai-usage will appear in the sidebar after aireins restart (interrupts all sessions); not restarting automatically this time.'
  fi
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
  if [[ "$current_status" == "运行中（PID ${started_pid}）"* || "$current_status" == "Running (PID $started_pid)"* ]]; then
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
