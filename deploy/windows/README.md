# Workbench Windows 托盘

在 **Windows PowerShell 5.1** 中安装（安装器只复制文件和修改快捷方式，不启动服务）：

```powershell
powershell -ExecutionPolicy Bypass -File "\\wsl.localhost\ubuntu\home\user\dev\workbench\deploy\windows\install-tray.ps1"
```

路径包含 `dev`，直接在 PowerShell 中用引号包住完整路径即可；不要经 `cmd /c start` 转发。如果 UNC 路径无法访问，可把 `deploy/windows/` 中的两个 `.ps1` 和 `deploy/workbench.ico` 复制到同一个 Windows 本地目录，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File "C:\wb-tray\install-tray.ps1" -SourceDir "C:\wb-tray"
```

安装器按当前用户开始菜单、所有用户开始菜单、桌面的顺序寻找 `Workbench 工作台.lnk`；也可加 `-ShortcutPath "C:\完整路径\Workbench 工作台.lnk"`。同名任务栏固定项一并更新，找不到时请从修改后的快捷方式重新固定。所有用户开始菜单如报权限不足，在管理员 PowerShell 重跑。

点击快捷方式会创建托盘并打开工作台，再次点击会恢复或重开窗口。最小化照常缩到任务栏；点 × 会关闭 Chrome 页面，WSL 服务和会话继续运行，第一次会有气泡提示。托盘左键单击、双击或右键「打开工作台」可重开。启动失败时托盘保留，「打开工作台」会重试启动服务。默认 Chrome 配置保留登录状态和页面偏好。

托盘右键「退出」会先检查正在运行的会话，存在时询问确认；确认后关闭工作台窗口、停止服务并退出托盘。服务已停止时直接退出。接口超时或返回异常时保留托盘并报错；不会猜测没有活会话。会话列表契约未提供未决闸门字段，因此统计 `running` 和带后台任务（`backgroundTasks` 非空）的会话。

安装器把脚本及图标复制到 `%LOCALAPPDATA%\workbench\`，生成 ASCII 的隐藏启动器，运行系统 `powershell.exe` 5.1。两个 `.ps1` 必须保存为 UTF-8 **带 BOM**。脚本默认端口 `8790`、发行版 `ubuntu`；需调整时，在该目录的 `launcher.vbs` 中给 `-File` 后的脚本参数追加 `-Port 8791 -Distro ubuntu`，重装会重置这项修改。

还原：安装器修改前会打印每个快捷方式的目标、参数、图标、工作目录和备份路径；将对应 `%LOCALAPPDATA%\workbench\shortcut-backups\<散列>.lnk` 复制回打印的原路径即可（开始菜单和任务栏各自还原），也可在快捷方式属性里填回原值。`bin/workbench-win` 保留作无托盘备用入口。还原快捷方式不会结束已运行的托盘；需要时先用托盘「退出」。

**仓库修改后必须重跑安装器才生效**，并退出旧托盘实例、重新启动。Windows 可能缓存任务栏图标；更新后仍显示旧图标时，取消固定再从新快捷方式固定。Chrome 的标题栏和任务栏图标行为需在 Windows 侧验收。
