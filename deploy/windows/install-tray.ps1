<#
.SYNOPSIS
    安装 AIReins 托盘脚本并创建或更新快捷方式。
.NOTES
    Windows PowerShell 5.1；本文件必须是 UTF-8 带 BOM。
    编译轻量入口、复制文件及更新快捷方式，不启动托盘、Chrome 或 WSL 服务。
#>
[CmdletBinding()]
param(
    [string]$ShortcutPath,
    [string]$SourceDir,
    [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distro,
    [ValidatePattern('^[~/][A-Za-z0-9_./=+~-]*$')][string]$WbPath,
    [ValidateRange(1, 65535)][int]$Port = 8790,
    # Chrome 给 --app=http://127.0.0.1:<端口>/ 窗口的任务栏 ID（与端口无关）。快捷方式带上同一个 ID，
    # 窗口才会归到固定项那一格，而不是另起一个 Chrome 图标。
    [string]$AppId = 'Chrome.127.0.0.1_/'
)
$ErrorActionPreference = 'Stop'
# 用户可见文案按界面语言输出；快捷方式文件名等稳定标识符保持中文不变。
$script:IsZh = [System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*'
function T([string]$Zh, [string]$En) { if ($script:IsZh) { $Zh } else { $En } }
# 经 WSL 调用时输出走管道，系统代码页（GBK）中文会在 UTF-8 终端里乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WbLink {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    interface IPersistFile {
        void GetClassID(out Guid id); [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file); void GetCurFile(out IntPtr file);
    }
    [StructLayout(LayoutKind.Sequential, Pack=4)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)] struct PropVariant {
        [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr pad;
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
        void GetCount(out uint n); void GetAt(uint i, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value); void Commit();
    }
    static PropertyKey AppIdKey() {
        var k = new PropertyKey(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5; return k;
    }
    public static string GetAppId(string path) {
        var link = new CShellLink();
        try {
            ((IPersistFile)link).Load(path, 0);
            var key = AppIdKey(); PropVariant v;
            ((IPropertyStore)link).GetValue(ref key, out v);
            return v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null; // VT_LPWSTR；只读一次，不回收这点内存
        } finally { Marshal.ReleaseComObject(link); }
    }
    public static void SetAppId(string path, string appId) {
        var link = new CShellLink();
        try {
            ((IPersistFile)link).Load(path, 2); // STGM_READWRITE
            var key = AppIdKey();
            var v = new PropVariant(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(appId);
            try { var store = (IPropertyStore)link; store.SetValue(ref key, ref v); store.Commit(); }
            finally { Marshal.FreeCoTaskMem(v.p); }
            ((IPersistFile)link).Save(null, true);
        } finally { Marshal.ReleaseComObject(link); }
    }
}
'@
$shortcutName = 'AIReins.lnk'
$legacyShortcutNames = @('Workbench 工作台.lnk') # 改名前安装的快捷方式继续原地更新，不另建一份
$installDir = Join-Path $env:LOCALAPPDATA 'AIReins'
# 改名前的安装目录；旧快捷方式与固定项会改指新目录，旧目录不删（远程网关也可能装在里面）。
$legacyInstallDir = Join-Path $env:LOCALAPPDATA 'workbench'

# 与 wb-tray.ps1 的 Resolve-Chrome 使用相同候选；只检查，不启动 Chrome。
$chromeFound = $false
foreach ($candidate in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $chromeFound = $true; break }
}
if (-not $chromeFound) { $chromeFound = $null -ne (Get-Command chrome.exe -ErrorAction SilentlyContinue) }
if (-not $chromeFound) { Write-Warning (T '没有找到 Google Chrome，请安装 Google Chrome（工作台窗口用 chrome --app 打开）。' 'Google Chrome was not found. Install Google Chrome (the AIReins window opens with chrome --app).') }

# 默认仓库布局：脚本在 windows/，图标在它的上一层 deploy/。
# -SourceDir 可指 windows/、deploy/，或把脚本与图标放一起的本地目录。
if (-not $SourceDir) { $SourceDir = $PSScriptRoot }
# 用 ProviderPath：UNC（\\wsl.localhost\...）下 .Path 带 "Microsoft.PowerShell.Core\FileSystem::" 前缀，.NET 文件 API 不认
$sourceRoot = (Resolve-Path -LiteralPath $SourceDir).ProviderPath
$scriptSource = Join-Path $sourceRoot 'wb-tray.ps1'
if (-not (Test-Path -LiteralPath $scriptSource -PathType Leaf)) {
    $scriptSource = Join-Path $sourceRoot 'windows\wb-tray.ps1'
}
$iconSource = Join-Path $sourceRoot 'aireins.ico'
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) {
    $iconSource = Join-Path (Split-Path -Parent $sourceRoot) 'aireins.ico'
}
$launcherSource = Join-Path (Split-Path -Parent $scriptSource) 'launcher.cs'
foreach ($source in @($scriptSource, $iconSource, $launcherSource)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw (T "缺少源文件：$source（用 -SourceDir 指定）" "Missing source file: $source (specify it with -SourceDir)") }
}
# 预先确认运行脚本编码，防止复制了会让 5.1 乱码的副本。
$bytes = [System.IO.File]::ReadAllBytes($scriptSource)
if ($bytes.Length -lt 3 -or $bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) {
    throw (T 'wb-tray.ps1 必须是 UTF-8 带 BOM。' 'wb-tray.ps1 must be UTF-8 with BOM.')
}

function Find-Shortcut {
    if ($ShortcutPath) {
        if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) -or
            [System.IO.Path]::GetExtension($ShortcutPath) -ne '.lnk') { throw (T "找不到 .lnk 快捷方式：$ShortcutPath" "Cannot find .lnk shortcut: $ShortcutPath") }
        return (Resolve-Path -LiteralPath $ShortcutPath).ProviderPath
    }
    $roots = @(
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
        "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
        [Environment]::GetFolderPath('Desktop')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($name in @($shortcutName) + $legacyShortcutNames) {
            $hit = Get-ChildItem -LiteralPath $root -Filter $name -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    return $null
}
$mainShortcut = Find-Shortcut
$newShortcuts = @()
if ($mainShortcut) {
    $targets = @($mainShortcut)
} else {
    foreach ($root in @(
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
        [Environment]::GetFolderPath('Desktop')
    )) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $newShortcuts += Join-Path $root $shortcutName
    }
    $targets = @($newShortcuts)
}
$pinnedDir = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
$pinned = @()
if (Test-Path -LiteralPath $pinnedDir -PathType Container) {
    foreach ($name in @($shortcutName) + $legacyShortcutNames) { $pinned += @(Get-ChildItem -LiteralPath $pinnedDir -Filter $name -File) }
}
# 直接把 Chrome 工作台窗口固定到任务栏时，Windows 生成的是「Google Chrome (2).lnk」这类只指向 chrome.exe 的固定项：
# 图标是 Chrome 的，窗口关掉后再点只会开一个普通 Chrome 窗口。按任务栏 ID 认出这类固定项，一并改成走托盘。
if (Test-Path -LiteralPath $pinnedDir -PathType Container) {
    foreach ($item in Get-ChildItem -LiteralPath $pinnedDir -Filter '*.lnk' -File) {
        if ($pinned.FullName -contains $item.FullName) { continue }
        try { $id = [WbLink]::GetAppId($item.FullName) } catch { continue }
        if ($id -eq $AppId) { $pinned += $item }
    }
}
foreach ($item in $pinned) { if ($targets -notcontains $item.FullName) { $targets += $item.FullName } }
# 改名前装的其他副本（如桌面那份）仍指向旧目录的启动器；一并改指新目录，旧目录才能删。
if (-not $ShortcutPath) {
    $legacyLauncher = Join-Path $legacyInstallDir 'launcher.vbs'
    $probe = New-Object -ComObject WScript.Shell
    foreach ($root in @(
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
        "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
        [Environment]::GetFolderPath('Desktop')
    )) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($name in @($shortcutName) + $legacyShortcutNames) {
            foreach ($item in @(Get-ChildItem -LiteralPath $root -Filter $name -File -Recurse -ErrorAction SilentlyContinue)) {
                if ($targets -contains $item.FullName) { continue }
                $linkArgs = [string]($probe.CreateShortcut($item.FullName).Arguments)
                if ($linkArgs.IndexOf($legacyLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $targets += $item.FullName }
            }
        }
    }
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
# 在覆盖入口之前完成编译；版本化文件名避免替换正在加载的 exe。
$native = [regex]::Match([Text.Encoding]::UTF8.GetString($bytes), "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $native.Success) { throw 'Could not locate the tray native type definitions.' }
$effectiveDistro = if ($Distro) { $Distro } else { 'ubuntu' }
$effectiveWbPath = if ($WbPath) { $WbPath } else { '~/.local/bin/aireins' }
$compiledSource = $native.Groups[1].Value + "`n" + [IO.File]::ReadAllText($launcherSource)
$compiledSource = $compiledSource.Replace('__AIREINS_DISTRO__', $effectiveDistro).Replace('__AIREINS_WB_PATH__', $effectiveWbPath).Replace('__AIREINS_PORT__', [string]$Port)
$digest = [Security.Cryptography.SHA256]::Create()
try { $assemblyKey = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($compiledSource))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
finally { $digest.Dispose() }
$assemblyName = "aireins-launcher-$assemblyKey.exe"
$assemblyPath = Join-Path $installDir $assemblyName
if (-not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)) {
    Add-Type -TypeDefinition $compiledSource -ReferencedAssemblies @('System', 'System.Core', 'System.Windows.Forms') -OutputAssembly $assemblyPath -OutputType WindowsApplication
}
$null = [Reflection.AssemblyName]::GetAssemblyName($assemblyPath)
# 入口文件留本次升级前快照；旧 exe 和原有快捷方式备份继续保留。
$entryBackup = Join-Path $installDir ("entry-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $entryBackup | Out-Null
foreach ($name in @('wb-tray.ps1', 'launcher.vbs', 'aireins.ico')) {
    $previous = Join-Path $installDir $name
    if (Test-Path -LiteralPath $previous -PathType Leaf) { Copy-Item -LiteralPath $previous -Destination (Join-Path $entryBackup $name) }
}
Write-Host "Entry backup: $entryBackup"
Copy-Item -LiteralPath $scriptSource -Destination (Join-Path $installDir 'wb-tray.ps1') -Force
Copy-Item -LiteralPath $iconSource -Destination (Join-Path $installDir 'aireins.ico') -Force
# 路径从 VBS 自身推导，用户名含中文时仍能保持脚本内容为纯 ASCII。
# 显式选 System32\WindowsPowerShell，保证用系统 5.1，不被 PATH 中的 pwsh 替换。
$trayArguments = " -Port $Port"
if ($PSBoundParameters.ContainsKey('Distro')) { $trayArguments += " -Distro $Distro" }
if ($PSBoundParameters.ContainsKey('WbPath')) { $trayArguments += " -WbPath $WbPath" }
$vbs = @'
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If fso.FileExists(here & "\__WB_EXE__") Then
  sh.Run """" & here & "\__WB_EXE__""", 0, False
Else
  sh.Run """" & ps & """ -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File """ & here & "\wb-tray.ps1""__WB_ARGS__", 0, False
End If
'@
# VBS 字符串中的双引号必须写成两个；参数校验保证生成内容仍为 ASCII。
$vbs = $vbs.Replace('__WB_ARGS__', $trayArguments.Replace('"', '""'))
$vbs = $vbs.Replace('__WB_EXE__', $assemblyName)
$launcher = Join-Path $installDir 'launcher.vbs'
Set-Content -LiteralPath $launcher -Value $vbs -Encoding ASCII
$shell = New-Object -ComObject WScript.Shell
$backupDir = Join-Path $installDir 'shortcut-backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

foreach ($target in $targets) {
    $shortcut = $shell.CreateShortcut($target)
    Write-Host (T "快捷方式：$target" "Shortcut: $target")
    if ($newShortcuts -contains $target) {
        Write-Host (T '  新建' '  created')
    } else {
        Write-Host (T "  原目标：$($shortcut.TargetPath)" "  original target: $($shortcut.TargetPath)")
        Write-Host (T "  原参数：$($shortcut.Arguments)" "  original arguments: $($shortcut.Arguments)")
        Write-Host (T "  原图标：$($shortcut.IconLocation)" "  original icon: $($shortcut.IconLocation)")
        Write-Host (T "  原工作目录：$($shortcut.WorkingDirectory)" "  original working directory: $($shortcut.WorkingDirectory)")
        # 按完整路径区分开始菜单 / 固定项；重跑时保留首次安装前的备份。
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($target))).Replace('-', '') }
        finally { $hash.Dispose() }
        $backup = Join-Path $backupDir "$key.lnk"
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $target -Destination $backup }
        Write-Host (T "  还原备份：$backup（复制回上面的快捷方式路径）" "  restore backup: $backup (copy it back to the shortcut path above)")
    }
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = "`"$launcher`""
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = "$(Join-Path $installDir 'aireins.ico'),0"
    $shortcut.Description = 'AIReins'
    try { $shortcut.Save() }
    catch {
        throw (T "无法修改 $target ：$($_.Exception.Message)。若位于所有用户开始菜单，请用管理员 PowerShell 重跑。已完成的其他项和备份保留。" "Cannot modify ${target}: $($_.Exception.Message). If it is in the all-users Start Menu, rerun in an elevated PowerShell. Completed items and backups are kept.")
    }
    # 重新创建 COM 对象读回持久化结果。
    $saved = $shell.CreateShortcut($target)
    if ($saved.TargetPath -ne $shortcut.TargetPath -or $saved.Arguments -ne $shortcut.Arguments -or
        $saved.IconLocation -ne $shortcut.IconLocation -or $saved.WorkingDirectory -ne $shortcut.WorkingDirectory) {
        throw (T "快捷方式读回不一致：$target" "Shortcut read-back mismatch: $target")
    }
    [WbLink]::SetAppId($target, $AppId)
    if ([WbLink]::GetAppId($target) -ne $AppId) { throw (T "任务栏 ID 读回不一致：$target" "Taskbar ID read-back mismatch: $target") }
    Write-Host (T "  已改为：$($saved.TargetPath) $($saved.Arguments)" "  changed to: $($saved.TargetPath) $($saved.Arguments)")
    Write-Host (T "  任务栏 ID：$AppId" "  taskbar ID: $AppId")
    Write-Host (T "  新图标：$($saved.IconLocation)" "  new icon: $($saved.IconLocation)")
}
if ($pinned.Count -eq 0) { Write-Host (T '未找到同名任务栏固定项：请从安装后的快捷方式固定到任务栏。' 'No matching pinned taskbar shortcut found; pin the installed shortcut to the taskbar yourself.') }
else { Write-Host (T '已有任务栏固定项已更新，无需重新固定。' 'Existing pinned taskbar shortcuts were updated; no need to re-pin.') }
Write-Host (T "已安装到 $installDir。请点「AIReins」（改名前安装的为「Workbench 工作台」）启动。" "Installed to $installDir. Launch it from the AIReins shortcut (named 'Workbench 工作台' if installed before the rename).")
if (Test-Path -LiteralPath (Join-Path $legacyInstallDir 'launcher.vbs') -PathType Leaf) {
    Write-Host (T "旧安装目录 $legacyInstallDir 里的托盘文件已不再使用（上面列出的快捷方式已改指新目录）；退出旧托盘、确认没有自建的快捷方式还指向它后可自行删除，remote-gateway 子目录若存在仍在使用，保留。" "The tray files in the old install directory $legacyInstallDir are no longer used (the shortcuts listed above now point to the new directory); after exiting the old tray and checking that no shortcut you made yourself still points there, you may delete them. Keep its remote-gateway subfolder if present; it is still in use.")
}
Write-Host (T '仓库修改不会自动更新安装副本；以后需重跑此安装器，再退出旧托盘实例并重新启动。' 'Repository changes do not update the installed copy; rerun this installer, then exit the old tray instance and start it again.')
