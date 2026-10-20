#!/bin/sh
# 拉取/合并后让 frontend/dist 跟上源码；依赖与后端变化只提示（aireins restart 会停掉所有会话）。
old=$(git rev-parse -q --verify ORIG_HEAD) || exit 0
changed=$(git diff --name-only "$old" HEAD --) || exit 0
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in [zZ][hH]*) zh=1 ;; *) zh= ;; esac
say() { if [ -n "$zh" ]; then printf 'AIReins: %s\n' "$1"; else printf 'AIReins: %s\n' "$2"; fi; }
has() { printf '%s\n' "$changed" | grep -Eq "$1"; }
has '^package(-lock)?\.json$' && say '依赖有变化，请运行 npm install。' 'Dependencies changed; run npm install.'
has '^(server|shared)/' && say '后端有变化，择时运行 aireins restart 才生效（会停掉所有会话）。' 'Backend changed; run aireins restart when convenient (it stops every session).'
has '^(frontend|shared)/|^package(-lock)?\.json$' || exit 0
say '前端有变化，正在运行 npm run build……' 'Frontend changed; running npm run build...'
if log=$(npm run build 2>&1); then
  say '前端已构建，刷新页面即可。' 'Frontend built; refresh the page.'
else
  printf '%s\n' "$log" | tail -n 20
  say 'npm run build 失败，修复后请手动重跑。' 'npm run build failed; fix it and rerun it manually.'
fi
exit 0
