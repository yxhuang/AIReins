<#
.SYNOPSIS
    安装 Workbench 工作台托盘脚本并更新已有快捷方式。
.NOTES
    Windows PowerShell 5.1；本文件必须是 UTF-8 带 BOM。
    只复制文件及更新快捷方式，不启动托盘、Chrome 或 WSL 服务。
#>
[CmdletBinding()]
param(
    [string]$ShortcutPath,
    [string]$SourceDir
)
$ErrorActionPreference = 'Stop'
$shortcutName = 'Workbench 工作台.lnk'
$installDir = Join-Path $env:LOCALAPPDATA 'workbench'

# 默认仓库布局：脚本在 windows/，图标在它的上一层 deploy/。
# -SourceDir 可指 windows/、deploy/，或把脚本与图标放一起的本地目录。
if (-not $SourceDir) { $SourceDir = $PSScriptRoot }
# 用 ProviderPath：UNC（\\wsl.localhost\...）下 .Path 带 "Microsoft.PowerShell.Core\FileSystem::" 前缀，.NET 文件 API 不认
$sourceRoot = (Resolve-Path -LiteralPath $SourceDir).ProviderPath
$scriptSource = Join-Path $sourceRoot 'wb-tray.ps1'
if (-not (Test-Path -LiteralPath $scriptSource -PathType Leaf)) {
    $scriptSource = Join-Path $sourceRoot 'windows\wb-tray.ps1'
}
$iconSource = Join-Path $sourceRoot 'workbench.ico'
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) {
    $iconSource = Join-Path (Split-Path -Parent $sourceRoot) 'workbench.ico'
}
foreach ($source in @($scriptSource, $iconSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少源文件：$source（用 -SourceDir 指定）" }
}
# 预先确认运行脚本编码，防止复制了会让 5.1 乱码的副本。
$bytes = [System.IO.File]::ReadAllBytes($scriptSource)
if ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) {
    throw 'wb-tray.ps1 必须是 UTF-8 带 BOM。'
}

function Find-Shortcut {
    if ($ShortcutPath) {
        if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) -or
            [System.IO.Path]::GetExtension($ShortcutPath) -ne '.lnk') { throw "找不到 .lnk 快捷方式：$ShortcutPath" }
        return (Resolve-Path -LiteralPath $ShortcutPath).ProviderPath
    }
    $roots = @(
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
        "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
        [Environment]::GetFolderPath('Desktop')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $hit = Get-ChildItem -LiteralPath $root -Filter $shortcutName -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    throw "开始菜单和桌面都没找到「$shortcutName」，请用 -ShortcutPath 指定。"
}
$mainShortcut = Find-Shortcut
$targets = @($mainShortcut)
$pinnedDir = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
$pinned = @()
if (Test-Path -LiteralPath $pinnedDir -PathType Container) {
    $pinned = @(Get-ChildItem -LiteralPath $pinnedDir -Filter $shortcutName -File)
}
foreach ($item in $pinned) { if ($targets -notcontains $item.FullName) { $targets += $item.FullName } }

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $scriptSource -Destination (Join-Path $installDir 'wb-tray.ps1') -Force
Copy-Item -LiteralPath $iconSource -Destination (Join-Path $installDir 'workbench.ico') -Force
# 路径从 VBS 自身推导，用户名含中文时仍能保持脚本内容为纯 ASCII。
# 显式选 System32\WindowsPowerShell，保证用系统 5.1，不被 PATH 中的 pwsh 替换。
$vbs = @'
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
sh.Run """" & ps & """ -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File """ & here & "\wb-tray.ps1""", 0, False
'@
$launcher = Join-Path $installDir 'launcher.vbs'
Set-Content -LiteralPath $launcher -Value $vbs -Encoding ASCII
$shell = New-Object -ComObject WScript.Shell
$backupDir = Join-Path $installDir 'shortcut-backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

foreach ($target in $targets) {
    $shortcut = $shell.CreateShortcut($target)
    Write-Host "快捷方式：$target"
    Write-Host "  原目标：$($shortcut.TargetPath)"
    Write-Host "  原参数：$($shortcut.Arguments)"
    Write-Host "  原图标：$($shortcut.IconLocation)"
    Write-Host "  原工作目录：$($shortcut.WorkingDirectory)"
    # 按完整路径区分开始菜单 / 固定项；重跑时保留首次安装前的备份。
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($target))).Replace('-', '') }
    finally { $hash.Dispose() }
    $backup = Join-Path $backupDir "$key.lnk"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $target -Destination $backup }
    Write-Host "  还原备份：$backup（复制回上面的快捷方式路径）"
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = "`"$launcher`""
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = "$(Join-Path $installDir 'workbench.ico'),0"
    try { $shortcut.Save() }
    catch {
        throw "无法修改 $target ：$($_.Exception.Message)。若位于所有用户开始菜单，请用管理员 PowerShell 重跑。已完成的其他项和备份保留。"
    }
    # 重新创建 COM 对象读回持久化结果。
    $saved = $shell.CreateShortcut($target)
    if ($saved.TargetPath -ne $shortcut.TargetPath -or $saved.Arguments -ne $shortcut.Arguments -or
        $saved.IconLocation -ne $shortcut.IconLocation -or $saved.WorkingDirectory -ne $shortcut.WorkingDirectory) {
        throw "快捷方式读回不一致：$target"
    }
    Write-Host "  已改为：$($saved.TargetPath) $($saved.Arguments)"
    Write-Host "  新图标：$($saved.IconLocation)"
}
if ($pinned.Count -eq 0) { Write-Host '未找到同名任务栏固定项：请从修改后的快捷方式重新固定到任务栏。' }
Write-Host "已安装到 $installDir。请点「Workbench 工作台」启动。"
Write-Host '仓库修改不会自动更新安装副本；以后需重跑此安装器，再退出旧托盘实例并重新启动。'
