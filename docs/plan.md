# AIReins 计划

跨会话仍成立的设计决定、约束与待办。当前进度与续接见根目录 `HANDOFF.md`；接口与界面规则以 `server/README.md`、`frontend/README.md` 为准；单项任务的工单、报告在本地 `.work-orders/<日期-任务>/`（不入库）。

## 已定设计

- **命名**：产品名 AIReins（缰绳意象：由人判断、掌控 AI，让它朝人要的方向工作）。新增的路径、localStorage 键、文案、文件名一律用 AIReins；已有内部名（`~/.workbench`、`WORKBENCH_*`、systemd 单元名、`workbench-*` 存储键、托盘 Mutex/消息窗口名、计划任务名）为新旧互认刻意保留，是否迁移另议、未排期。
- **许可证**：代码 MIT；项目名与 Logo、三家及 VS Code 品牌图标不在 MIT 内（见 `LICENSE`、`NOTICE`）。
- **版本记录**：面向用户的功能与修复持续写入 `CHANGELOG.md` 的 `Unreleased`；发布时归入带日期的版本条目，并保持 `package.json`、`package-lock.json`、Git 标签和 GitHub Release 版本一致，Release 说明取自该版本条目。
- **首发范围**：平台层（原生 Linux 支持、macOS 实验性只靠 CI）与中英双语界面做完才公开，已完成。
- **侧栏**：按工作目录自动分组是唯一视图（不做时间/目录切换），组内最近活动在前，组间顺序可拖动、存服务端；不做手建分组。新建会话必须选目录，不做非项目对话、不建聊天专用目录。近 3 天无活动的目录收进「较早的项目」，与会话窗口同用 3 天线；每目录最多显示 8 个会话，运行/待审批/当前会话豁免。会话保留期仍由 `prefs.json` 的 `retentionDays` 决定。
- **右上角面板顺序**：文件 → 派单 → 终端（手机「⋯」菜单同序）。
- **派单入口**：会话顶栏、手机徽章即使只有一张派单也先进流程图并高亮，详情只从流程图卡片和历史派单进入。
- **机器相关行为**只放 `~/.workbench/prefs.json`（关机命令、Claude 入口身份、目录浏览主目录等），公开默认保持通用。Claude 入口身份公开默认不设（用户 10-17 定），需要会话出现在 VS Code 扩展历史列表的用户自己在 `prefs.json` 设 `claudeCodeEntrypoint`，README 已写明。
- **隐私防线**：`npm run check:privacy` 全树检查；`npm run hooks:install` 安装版本化 `pre-commit` / `commit-msg` 钩子，本地私人清单通过 `git config --local aireins.privatePatterns /absolute/path/to/private-patterns.txt` 配置，未配置或文件不存在时警告并继续通用检查。CI 用 `--range` 检查 push 的 before..sha（新分支、tag 改从默认分支起算）、PR 的 base..head 全部新提交，并保留全树检查；新增夹具用合成 ID，截图输出到临时目录，二进制和图片跳过自动内容检查，须人工核对可见文字与元数据。

## 待开发

1. **额度面板 Node 原生化并入 AIReins**（用户 10-14 定，排在公开发布之后）：公开用户免装 Python/uv、少一个后台服务，并去掉 iframe + 同源反代嵌入外部页（`PageView.tsx` 不加 sandbox 的风险）。数据源：Codex 用 `account/rateLimits/read` 并消费现被静默的 `account/rateLimits/updated`；Claude 复用 `get_usage` 但需无会话时也能查；Kimi 订阅额度需用户配置 API key（密钥不进日志、不写 CLI 全局配置）。保留进度条 + 时间进度刻度、5 小时/周/额外额度、过期标识、失败退避、轮询间隔；参考 ai-usage 仓库 `server/poller.py`、`server/providers/`、`web/`。开工前按 `AGENTS.md` 开 issue 定边界；`install.sh --with-ai-usage` 届时改为迁移提示。
2. **启动提速实测**：重启两次（第一次写缓存），第二次从点任务栏到出窗口应约 3 秒；不达标对照 `tray.log` 与 `server.log`。
3. **远程遗留**：未登录 Windows 或 WSL 停止时无法远程访问/冷启动（Tailscale Serve 不能唤醒 WSL），见 `deploy/windows/REMOTE.md`。
4. **托盘**：① 重开窗口还原最大化——试做后撤回，托盘记下的 placement 从不是最大化，原因未查清；重做前先让用户最大化窗口，看 `tray.log` tick 行 `max=` 是否为 1。② 转交显示请求成功后备用实例仍等 35 秒才退出，可改为转交成功即退出，但要保留 owner 正在退出时的接管路径。
5. **手机→电脑传文件**：倾向做浏览器上传到当前目录（Taildrop 目前只支持电脑发出）。
6. **安全低优先建议**（阶段 3 审计已做、两项发现已修；以下遗留建议尚未落实）：新建 `~/.workbench` 目录与日志用私有权限；manifest 内联 SVG 改图片；HTML 预览解析阶段的外部请求隔离。
7. **i18n 检查补强**（可选）：把“词典片段与变量直接相邻导致丢空格”的检查并入 `check:i18n`。
8. **测试独立性**（低优先）：`scripts/ci-smoke.mjs:38` 依赖已构建的 `frontend/dist`；`frontend/scripts/smoke-ws.mjs` 默认连本机 8790 真实例并用已登录 CLI。

暂不做：全局快捷键扩展、终端搜索/链接识别、pages 模块、跨会话收件箱。

## 已知限制

- 长会话分页：超预算大文件每次分页临时建完整索引，16MiB 缓存预算不是进程内存硬上限。
- Taildrop 发送：30 分钟超时能否可靠终止 Windows CLI 未验；客户端断开不取消服务端发送，重试可能重复。
- 手机/窄屏：英文 320px 手机底栏两行；「英文 + 最小字号 14 + 224px 侧栏」底栏换行；设置面板英文「Default」在分段控件里断两行；手机首页主机名在窄屏被截断。
- iOS 键盘上方 ∧ ∨ ✓ 是系统表单辅助栏，网页无法隐藏。
