# 界面术语对照

中文词典是 `ui.zh-CN.ts`，英文词典是 `ui.en.ts`。两套词典使用相同的 `ui.<组件>.<语义>` 键，共用文案使用 `ui.common.*`；前端其他模块使用 `core.*`，服务端提示使用 `server.*`。英文使用 sentence case，产品与 CLI 名称保留官方拼写。

| 中文 | English | 用法 |
| --- | --- | --- |
| 会话 | Session | 对话运行及其记录；复数 Sessions |
| 历史会话 | Session history | 列表入口；紧凑标签可用 History |
| 原生会话 | Native session | CLI 自己保存的会话 |
| 续接 | Resume | 继续同一个原生会话 |
| 工作台 | Workspace / {product} | 通用区域用 Workspace；产品名称用 `{product}` |
| 工作目录 | Working directory | cwd 的面向用户名称 |
| 派单 | Dispatch | 独立执行的任务；列表 Dispatches |
| 派单人 | Dispatcher | 派出任务的会话或执行方 |
| 派单原文 | Dispatch prompt | 发给执行端的任务全文 |
| 执行端 | Executor | Codex、Claude、Kimi 等任务执行端 |
| 子代理 | Subagent | 任务的内部子代理 |
| 执行过程 | Execution | 任务执行记录 |
| 交付摘要 | Delivery summary | 完成后的任务交付摘要 |
| 置顶 | Pin | 操作；分区标题 Pinned |
| 取消置顶 | Unpin | 取消操作 |
| 分组 | Group | 用户整理会话的分组 |
| 主机 | Host | 本机或远程电脑 |
| 本机 | Local | 当前电脑的本地入口 |
| 远程入口 | Remote access | Tailscale 访问入口 |
| 主机与连接 | Hosts and connections | 浏览器保存的主机列表 |
| 移除 | Remove | 从工作台移除；保留原生历史 |
| 彻底删除 | Permanently delete | 删除原生记录，不可恢复 |
| 闸门／审批 | Approval | 工具执行前的用户批准；最终闸门 Final approval |
| 允许／拒绝 | Allow / Deny | 审批操作；结果 Allowed / Denied |
| 提问 | Question / Ask | 名词 Question，操作 Ask |
| 插话 | Steering / Steer | 在执行中追加输入；不打断工具 |
| 中断 | Interrupt | 停止当前执行 |
| 思考 | Reasoning | 模型思考内容；Claude Thinking 开关保留功能名称 |
| 附件 | Attachment | 用户上传或电脑文件 |
| 文件引用 | File reference | `@` 形式的引用 |
| 引用 | Reference | 把文件插入消息 |
| 源码／预览 | Source / Preview | 文件显示方式 |
| 外部打开 | Open externally | 用浏览器或系统查看文件 |
| 直达 | Quick links | 用户配置的外部链接 |
| 外观 | Appearance | 语言、主题、字体设置 |
| 跟随系统 | System | 使用浏览器语言或系统主题 |
| 释放 | Release | 停 worker，保留会话用于续接 |
| 后台任务 | Background task | 回合之外的执行任务 |
| 关机 | Shut down / Shutdown | 操作用 Shut down，名词用 Shutdown |
| 快照 | Snapshot | 工作目录创建前的备份 |
| 驱动 | Driver | CLI 协议适配层；仅必要技术提示使用 |

产品名集中在 仓库 `shared/product-name.ts` 的 `PRODUCT_NAME`（前端 `../i18n.ts` 重导出）。词典通过 `{product}` 引用，禁止在译文重复写 `Workbench`。`wb` 图标字标遵循既有品牌；窗口标题随界面语言输出（`core.131`–`core.133`），Windows 托盘的 `IsWbTitle` 同时识别中英文标题与旧格式。

英文数量文案使用最简 ICU 复数语法：`{name, plural, one {…#…} other {…#…}}`，`#` 替换为按当前语言格式化的数量；同一参数可出现多个复数块（如单复数不同的动词）。`Intl.PluralRules` 按当前语言选择 `one`/`other`；中文无需复数，保持 `{p0} 个文件` 写法。参数不是有限数字时该块原样保留。`check:i18n` 要求英文里「数字占位符 + 可数名词」必须走复数语法，个别占位符不是数量的（如 `core.026` 的派单人名）在 `check-i18n.mjs` 的 `pluralExceptions` 逐条登记。

新增文案时同时补充两套词典；参数使用 `{name}` 占位符并在 `t(key, { name })` 传入。完整句子应作为一个键，不把数量、日期或消息拆成零碎文案拼接。数量参数交给 `t()` 自动按当前语言格式化；独立日期、数量和相对时间使用 `formatDate`、`formatNumber`、`formatRelativeTime`。不要翻译用户内容、模型输出、文件路径、代码、日志或 CLI 协议标识。提交前运行 `npm run check:i18n`。
