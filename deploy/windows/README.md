# AIReins Windows 托盘

通常由仓库根的 `bash install.sh` 调用。也可在 **Windows PowerShell 5.1** 中手动安装（编译轻量入口、复制文件、创建或更新快捷方式，不启动托盘、Chrome 或服务；将示例用户名与路径换成实际值）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\ubuntu\home\<用户名>\workbench\deploy\windows\install-tray.ps1" -Distro ubuntu -WbPath '/home/<用户名>/workbench/bin/aireins'
```

路径包含 `=` 等特殊字符时，直接在 PowerShell 中用引号包住完整路径即可；不要经 `cmd /c start` 转发。如果 UNC 路径无法访问，可把 `deploy/windows/` 中的两个 `.ps1`、`launcher.cs` 和 `deploy/aireins.ico` 复制到同一个 Windows 本地目录，再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\wb-tray\install-tray.ps1" -SourceDir "C:\wb-tray" -Distro ubuntu -WbPath '~/.local/bin/aireins'
```

安装器按当前用户开始菜单、所有用户开始菜单、桌面的顺序寻找 `AIReins.lnk`（也认改名前的 `Workbench 工作台.lnk`，原地更新、不改文件名）；都找不到时，在当前用户开始菜单和桌面各新建一项。找到已有项时只改已有项，不额外建桌面图标。也可加 `-ShortcutPath "C:\完整路径\AIReins.lnk"`，显式指定的文件必须已存在。同名任务栏固定项一并更新；直接把工作台窗口固定到任务栏生成的 Chrome 固定项（如 `Google Chrome (2).lnk`，按任务栏 ID `Chrome.127.0.0.1_/` 识别）也改成走托盘、换成工作台图标。快捷方式都写入同一个任务栏 ID，工作台窗口因此归到固定项那一格，不再另起一个 Chrome 图标。找不到固定项时，从安装后的快捷方式固定。所有用户开始菜单如报权限不足，在管理员 PowerShell 重跑。找不到 Google Chrome 时仅警告，安装后需自行安装 Chrome。

点击快捷方式会创建托盘并打开工作台；托盘已在运行时，快捷方式/任务栏固定项只把「显示主窗口」经纯消息窗口（标题 `Workbench.Tray.Show.<发行版>.<端口>`）转交给托盘执行：隐藏或最小化的窗口被显示、还原并抬到前台，没有窗口时托盘重开。10-03 起备用实例不再自己抬窗——tray.log 证实它对隐藏窗口的 SW_SHOW 从不生效（8 次全败，托盘自己执行同样的调用 6 次全成），且它的补显示看门狗会把用户刚收起的窗口重新放出来。最小化照常缩到任务栏；点 × 会关闭 Chrome 页面，WSL 服务和会话继续运行，第一次会有气泡提示。托盘左键单击切换显隐：窗口露在最上面时收到托盘（任务栏按钮消失），隐藏、最小化或被完全遮挡时显示并抬到前台，没有窗口时重开。双击只执行一次切换；打开/退出等忙段内收到或忙段后迟到的单击只补一次。启动前没有窗口时补点按显示处理，避免把刚打开的窗口收起；其他成功忙段按当时窗口状态补切换。消费挂起请求后，该忙段的迟到点击不再补操作。启动或打开失败后，两类挂起请求（Show / Toggle）和同一失败忙段的迟到请求均不立即重试，用户下一次新操作可重试。右键「打开工作台」始终打开或恢复窗口。启动失败时托盘保留，「打开工作台」会重试启动服务。转交的 Show 只有在成功显示记录已覆盖其投递时刻，且窗口当前仍可见、未最小化时才去重；隐藏、最小化或失败均不算已覆盖。默认 Chrome 配置保留登录状态和页面偏好。

快捷方式优先调用安装时编译的 `aireins-launcher-<hash>.exe`。托盘已运行时直接经 `PostMessage` 转交显示请求，不启动 PowerShell、不编译 C#；无托盘或旧实例退出后才启动系统 PowerShell 5.1，并让托盘从同一 exe 加载预编译的原生类型。入口缺失时 VBS 退回源脚本路径，直接运行源脚本仍可现场编译。

轻量入口和源脚本备用实例均检查 `PostMessage` 返回值，投递失败或找不到消息窗口时记日志并等待接管；不推断旧实例处于启动阶段。交接最多等待 35 秒，覆盖停止服务的 30 秒超时和收尾；取得实例锁后按正常启动流程自启。轻量进程的等待不占托盘 UI 线程，也不延迟已投递请求的执行。旧实例的模态提示可能超过期限；未能投递且未能接管时弹出失败提示，需稍后再点快捷方式。投递成功只表示消息入队，不保证旧实例在退出前执行它。

托盘右键「退出」会先检查正在运行的会话，存在时询问确认；确认后关闭工作台窗口（包括已隐藏的窗口）、停止服务并退出托盘。服务已停止时直接退出。接口超时或返回异常时不猜测没有活会话，弹框问是否仍要退出；停止服务失败时照样退出托盘并提示在 WSL 里 `aireins stop`。打开流程（含 WSL 冷启动）进行中、或另一个入口正在打开时点退出，处理到时弹框提示稍后再试，不再静默无反应；打开流程同步阻塞期间积压、打开结束后才处理的退出点击会再确认一次，避免窗口刚出现就被关掉。会话列表契约未提供未决闸门字段，因此统计 `running` 和带后台任务（`backgroundTasks` 非空）的会话。

打开入口（包括首次启动和右键「打开工作台」）先探测 `/api/meta`（1 秒），服务正常就直接显示/重开 Chrome，不再调用 WSL。服务未运行且无 Chrome 窗口时，先显示跟随 Windows 深浅主题的本地 WinForms 启动窗，再启动 WSL/后端；Chrome 窗口出现后关闭启动窗，保留 Chrome 原 URL、登录状态和任务栏分组。启动期间不再发送右下角 Windows 气泡通知；失败通知和首次关窗提示仍保留。托盘在创建窗口前启用 Per-Monitor V2 DPI 感知（宿主已设置进程模式时改设 UI 线程，旧系统回退系统 DPI 感知），启动窗按 96 DPI 基准缩放布局并使用系统界面字体，避免高缩放屏幕上的位图放大模糊。启动或开窗失败也释放启动窗，托盘保留供下次手动重试。

`wsl --shutdown` 后窗口还在但服务已停：显示请求探测不通时重新拉起，页面会自动重连。窗口在最上面时单击托盘仍是隐藏，不探测。窗口处于前台时托盘每秒做一次 TCP 端口探测（不打 HTTP、不写 server.log），Busy 只包探测，保存结果并清 Busy 后再走打开流程拉起服务；只有实际尝试拉起后才更新冷却时间，尝试结束后 30 秒内不再自动拉起；窗口不在前台时不探测，不会在后台立即唤醒刚关掉的 WSL。

托盘与备用实例的每次启动、打开、显隐、退出步骤和失败都追加到 `%LOCALAPPDATA%\AIReins\tray.log`（带进程号，超过 1MB 从头写），单击的受理/挂起/丢弃和备用实例的转交也记在里面；启动路径记录健康服务短路、启动窗的显示/释放；保留通知的 `BalloonTipShown` / `BalloonTipClosed` 事件用于区分提交和 Shell 实际显示，未加 `DoEvents`。出现退不掉、窗口闪退等问题时先看它。托盘在 Chrome 新建窗口约 0.5 秒时对它设图标、显示、抢前台，会让 Chrome 随后把窗口隐藏（10-02 对照实验确认，表现为「闪一下缩回托盘」），所以托盘新开的窗口不再抬起，图标推迟到 1.5 秒再设；另留兜底：新开后 3 秒内窗口被外部隐藏就补显示一次。抬已有窗口也可能被 Chrome 收回（10-03 日志：显示后约 0.2 秒又被藏起），所以托盘抬窗后 0.3 秒再校验一次，被藏就补显示一次。

安装器把脚本、图标（`aireins.ico`）和预编译入口放到 `%LOCALAPPDATA%\AIReins\`（改名前装在 `%LOCALAPPDATA%\workbench\`；重装时旧快捷方式一并改指新目录，旧目录不自动删除，其中的 `remote-gateway` 仍在使用）。编译成功并检查程序集后才覆盖入口，原脚本、VBS 和图标备份到 `entry-backup-<时间>/`，原有快捷方式备份继续保留。exe 文件名按源码及启动参数生成 hash，升级不覆盖正在加载的 exe，也不自动清理旧版本。使用系统 PowerShell 5.1 / .NET Framework，不增加运行时依赖；两个 `.ps1` 必须保存为 UTF-8 **带 BOM**。安装器的 `-Distro`、`-WbPath`、`-Port` 写入入口；默认 `ubuntu`、`~/.local/bin/aireins`、`8790`，自定义端口用 `-Port 8791` 重装。发行版仅接受字母、数字、`_ . -`；WSL 路径须以 `/` 或 `~` 开头，且仅含字母、数字、`_ . / = + ~ -`。

还原：已有快捷方式修改前会打印目标、参数、图标、工作目录和备份路径；将对应 `%LOCALAPPDATA%\AIReins\shortcut-backups\<散列>.lnk`（改名前的备份在 `%LOCALAPPDATA%\workbench\shortcut-backups\`） 复制回打印的原路径即可（开始菜单和任务栏各自还原），也可在快捷方式属性里填回原值。新建项会打印「新建」，不做备份。`bin/aireins-win` 保留作无托盘备用入口。还原快捷方式不会结束已运行的托盘；需要时先用托盘「退出」。

**仓库修改后必须重跑安装器才生效**，并退出旧托盘实例、重新启动。Windows 可能缓存任务栏图标；更新后仍显示旧图标时，取消固定再从新快捷方式固定。Chrome 的标题栏和任务栏图标行为需在 Windows 侧验收。

设置里的更新按钮会在拉到安装/部署相关改动时自动执行 `bash install.sh --update`，完成后提示托盘文件已更新、需择时退出并重开。安装过程保留正在运行的托盘和后端；退出托盘会停止所有会话。安装失败会保留待办，重新检查后可点「重试安装」。普通终端 `git pull` 不自动更新 Windows 安装副本，仍需手动运行安装器。

窗口标题由 `frontend/src/host-connections.ts` 的 `workbenchWindowTitle` 按界面语言输出：中文为 `AIReins · 本机` / `AIReins · 远程 <机器名>`（可带 `(n) 个闸门待处理 · ` 前缀），英文为 `AIReins · Local` / `AIReins · Remote <机器名>`（可带 `(n) pending approval(s) · ` 前缀）。托盘按 `Chrome_WidgetWin_1` 类名加整标题正则认窗口，同时识别中文、英文新格式与旧格式（`workbench` 整标题、`… · workbench` 结尾）；普通 Chrome 标签页带「 - Google Chrome」后缀，不会被误认。托盘的菜单、气泡和对话框按 Windows 界面语言（`CurrentUICulture`）显示中文或英文，日志内容不随语言变化。

窗口图标仅在首次发现该窗口句柄时处理：先用 `WM_GETICON` 比较大小图标，句柄不同才发 `WM_SETICON`；两项成功后记住该窗口，定时器不再每秒重设。窗口消失后清除记录，新窗口重新检查；读取或设置超时会保留重试。此改动减少 Chrome 非客户区重绘，Ctrl+` 打开终端时的黑屏是否改善需在 Windows 实测。

纯逻辑测试不启动托盘、不调用 Win32，可在 Windows PowerShell 5.1 或 Linux `pwsh` 运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\windows\tests\tray-click-filter.ps1
powershell -ExecutionPolicy Bypass -File .\deploy\windows\tests\tray-startup.ps1
powershell -ExecutionPolicy Bypass -File .\deploy\windows\tests\launcher.test.ps1
```

测试用 AST 提取托盘源函数，覆盖显隐真值表、显示方式、单击裁决（双击去重、忙中挂起、忙段补切换、退出中丢弃）、计时回绕、冷启动补显示、失败后挂起处理、消费挂起后同忙段只补一次及 Show 覆盖判据；也提取真实 `Complete-Action` 检查挂起消费与接线，开窗边界用测试函数替换。`tray-startup.ps1` 另测真实启动函数的健康服务短路、先显示启动窗再启动 WSL、失败通知前释放启动窗、锁与 Busy 释放，以及重复清理。原有 56 项用例语义保持不变。遮挡判断沿用 ai-usage 的三个采样点：任一点命中 AIReins 就认为可见；三个点均被常驻置顶窗口覆盖时会持续走显示路径，实际显隐与任务栏行为仍需真机验收。

窗口标题识别正则另有 Node 测试（WSL 内运行，不依赖 Windows）：

```bash
node deploy/windows/tests/tray-title.test.mjs
```

它从 `wb-tray.ps1` 源码提取 `WbTitle` 正则，断言中文、英文新标题及旧格式样例的匹配与拒绝。
