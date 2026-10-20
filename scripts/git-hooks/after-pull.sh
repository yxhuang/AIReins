#!/bin/sh
# 拉取/合并后让依赖与 frontend/dist 跟上源码；后端变化只提示（aireins restart 会停掉所有会话）。
old=$(git rev-parse -q --verify ORIG_HEAD) || exit 0
changed=$(git diff --name-only "$old" HEAD --) || exit 0
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in [zZ][hH]*) zh=1 ;; *) zh= ;; esac
say() { if [ -n "$zh" ]; then printf 'AIReins: %s\n' "$1"; else printf 'AIReins: %s\n' "$2"; fi; }
failed=0
has() { printf '%s\n' "$changed" | grep -Eq "$1"; }
if has '^package(-lock)?\.json$'; then
  say '依赖有变化，正在运行 npm install……' 'Dependencies changed; running npm install...'
  if log=$(npm install --no-audit --no-fund 2>&1); then
    say '依赖已安装。' 'Dependencies installed.'
  else
    printf '%s\n' "$log" | tail -n 20
    say 'npm install 失败，修复后请手动重跑。' 'npm install failed; fix it and rerun it manually.'
    failed=1
  fi
fi
has '^(server|shared)/' && say '后端有变化，择时运行 aireins restart 才生效（会停掉所有会话）。' 'Backend changed; run aireins restart when convenient (it stops every session).'
has '^(frontend|shared)/|^package(-lock)?\.json$' || exit "$failed"
say '前端有变化，正在运行 npm run build……' 'Frontend changed; running npm run build...'
if log=$(npm run build 2>&1); then
  say '前端已构建，刷新页面即可。' 'Frontend built; refresh the page.'
else
  printf '%s\n' "$log" | tail -n 20
  say 'npm run build 失败，修复后请手动重跑。' 'npm run build failed; fix it and rerun it manually.'
  failed=1
fi
# git 忽略 post-merge 的退出码；设置里的「更新」靠它把失败报给界面。
exit "$failed"
