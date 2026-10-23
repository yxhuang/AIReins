<#
.SYNOPSIS
    AIReins 托盘入口（Windows PowerShell 5.1）。
.DESCRIPTION
    Chrome 自绘标题栏无法从外部拦截 ×。看门狗发现窗口消失时视为收到托盘，
    下次点击重开页面；WSL 服务和会话继续运行。保留任务栏及系统最小化行为。
    左键单击切换显隐；被遮挡或最小化时先显示，双击只受理一次；
    忙段单击只补一次；启动前无窗口时补显示，失败时不在收尾重试。
    快捷方式/任务栏启动的备用实例把「显示主窗口」经消息窗口转交给托盘执行，不自己抬窗。
    使用默认 Chrome 配置，以保留 localStorage 和已登录的外部站点。
.NOTES
    必须使用 UTF-8 带 BOM 保存，由 powershell.exe 5.1 运行，不用 pwsh。
    按 Chrome_WidgetWin_1 类名和标题认窗口，不查进程命令行，不会匹配脚本自身。
    STA 线程上 WaitForExit / WaitOne / Task.Wait 等托管阻塞会泵消息：
    可能阻塞的段先置 $script:Busy，让泵进来的点击走挂起而不是嵌套执行。
    仓库修改后需重跑 install-tray.ps1，退出旧托盘实例再启动。
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8790,
    [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distro = 'ubuntu',
    [ValidatePattern('^[~/][A-Za-z0-9_./=+~-]*$')][string]$WbPath = '~/.local/bin/aireins',
    [ValidatePattern('^aireins-launcher-[a-f0-9]{16}\.exe$')][string]$NativeAssembly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# 安装后的入口复用预编译程序集；直接运行源脚本仍可现场编译。
if ($NativeAssembly) {
    [void][System.Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot $NativeAssembly))
} else {
# 显式指定引用后默认引用集会丢，HashSet 在 System.Core，必须列全。
Add-Type -ReferencedAssemblies @('System', 'System.Core', 'System.Windows.Forms') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class WbNative {
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    public static void EnableDpiAwareness() {
        // PowerShell 5.1 hosts WinForms: configure DPI before creating any tray or form handles.
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }
        catch (EntryPointNotFoundException) { }
        // The host may already have fixed its process mode; override the UI thread in that case.
        try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; }
        catch (EntryPointNotFoundException) { }
        SetProcessDPIAware();
    }
    private delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern int GetMessageTime();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int processId);
    public const uint WM_APP_SHOW = 0x8001; // WM_APP+1：备用实例转交的「显示主窗口」请求
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    private static readonly HashSet<IntPtr> iconWindows = new HashSet<IntPtr>();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l,
        uint flags, uint timeout, out IntPtr result);
    // 页面标题见 frontend/src/host-connections.ts 的 workbenchWindowTitle，按界面语言输出中文或英文；
    // 旧格式（改名前的 Workbench 标题、workbench 整标题、以「 · workbench」结尾）留给未刷新的页面。
    // 整串匹配：普通 Chrome 标签页的窗口标题带「 - Google Chrome」后缀，不会被认成工作台。
    private static readonly System.Text.RegularExpressions.Regex WbTitle = new System.Text.RegularExpressions.Regex(
        @"^(?:\(\d[\d,]*\) (?:个闸门待处理|pending approvals?) · )?(?:AIReins|Workbench) · (?:本机|Local|(?:远程|Remote) \S+)$|^(?:AIReins|workbench)$| · workbench$");
    public static bool IsWbTitle(string t) { return WbTitle.IsMatch(t); }
    public static IntPtr[] Windows() {
        var hits = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            var cls = new StringBuilder(256);
            var title = new StringBuilder(1024);
            GetClassName(h, cls, cls.Capacity);
            GetWindowText(h, title, title.Capacity);
            string t = title.ToString();
            if (cls.ToString() == "Chrome_WidgetWin_1" && IsWbTitle(t)) hits.Add(h);
            return true;
        }, IntPtr.Zero);
        // EnumWindows 包含隐藏窗口；仅忘记已经消失的 hwnd。
        iconWindows.RemoveWhere(delegate(IntPtr h) { return !hits.Contains(h); });
        return hits.ToArray();
    }
    private static bool SetIconIfNeeded(IntPtr h, int kind, IntPtr icon) {
        IntPtr current;
        // WM_GETICON；读取超时则下次重试，避免在未知状态下反复改图标。
        if (SendMessageTimeout(h, 0x7F, new IntPtr(kind), IntPtr.Zero, 2, 200, out current) == IntPtr.Zero)
            return false;
        if (current == icon) return true;
        IntPtr previous;
        return SendMessageTimeout(h, 0x80, new IntPtr(kind), icon, 2, 200, out previous) != IntPtr.Zero;
    }
    public static void SetIcons(IntPtr h, IntPtr small, IntPtr large) {
        if (iconWindows.Contains(h)) return;
        bool smallReady = SetIconIfNeeded(h, 0, small); // ICON_SMALL
        bool largeReady = SetIconIfNeeded(h, 1, large); // ICON_BIG
        if (smallReady && largeReady) iconWindows.Add(h);
    }
}
// 托盘的纯消息窗口（HWND_MESSAGE）：备用实例 PostMessage 显示请求到这里，在 UI 线程触发事件。
public class WbTrayListener : System.Windows.Forms.NativeWindow {
    public event Action ShowRequested;
    public void Create(string title) {
        var cp = new System.Windows.Forms.CreateParams();
        cp.Caption = title;
        cp.Parent = new IntPtr(-3); // HWND_MESSAGE
        CreateHandle(cp);
    }
    protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == (int)WbNative.WM_APP_SHOW) {
            var handler = ShowRequested;
            if (handler != null) handler();
        }
        base.WndProc(ref m);
    }
}
'@
}

[WbNative]::EnableDpiAwareness()
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:BaseUrl = "http://127.0.0.1:$Port"
$script:Tray = $null
$script:Busy = $false
$script:Exiting = $false
$script:HadWindow = $false
$script:NotifiedClose = $false
$script:Icon = $null
$script:LargeIcon = $null
$script:LastClickTick = [long][Environment]::TickCount - 10000
$script:LastActionEndTick = $script:LastClickTick
$script:LastReviveTick = $script:LastClickTick
$script:LastWindowState = ''
$script:PendingToggle = $false
$script:PendingShow = $false
$script:PendingShowTick = $script:LastClickTick
$script:StaleEpisodeEnd = $script:LastClickTick
$script:LastActionFailed = $false
$script:ShowOnlyPending = $false
$script:LastActionShowOnly = $false
$script:LastShowSucceeded = $false
$script:LastShowEndTick = $script:LastClickTick
$script:ShowListener = $null
$script:StartupWindow = $null
$script:StartupTitleFont = $null

# 用户可见文案按界面语言输出；日志保持原文，不走 T。
$script:IsZh = [System.Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*'
function T([string]$Zh, [string]$En) { if ($script:IsZh) { $Zh } else { $En } }
$script:AppTitle = T 'AIReins' 'AIReins'

function Resolve-Chrome {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw (T '没有找到 Google Chrome，请先安装 Chrome。' 'Google Chrome was not found. Install Chrome first.')
}

function New-FallbackIcon {
    $bitmap = New-Object System.Drawing.Bitmap 64, 64
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1F1E1D'))
    try {
        $path.AddArc(0, 0, 28, 28, 180, 90)
        $path.AddArc(35, 0, 28, 28, 270, 90)
        $path.AddArc(35, 35, 28, 28, 0, 90)
        $path.AddArc(0, 35, 28, 28, 90, 90)
        $path.CloseFigure()
        $graphics.FillPath($brush, $path)
        $colors = @('#D97757', '#10A37F', '#1A73E8')
        for ($i = 0; $i -lt 3; $i++) {
            $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($colors[$i])), 10
            try {
                $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
                $graphics.DrawLine($pen, (17 + 15 * $i), 21, (17 + 15 * $i), 43)
            } finally { $pen.Dispose() }
        }
        $handle = $bitmap.GetHicon()
        try { return [System.Drawing.Icon]::FromHandle($handle).Clone() }
        finally { [void][WbNative]::DestroyIcon($handle) }
    } finally {
        $brush.Dispose(); $path.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}

# 托盘行为日志：排查多实例、退出、显隐问题用；超过 1MB 从头写。
$script:LogPath = Join-Path $PSScriptRoot 'tray.log'
function Write-TrayLog([string]$Message) {
    try {
        $mode = 'Append'
        if ((Test-Path -LiteralPath $script:LogPath) -and (Get-Item -LiteralPath $script:LogPath).Length -gt 1MB) { $mode = 'Create' }
        $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') [$PID] $Message`r`n"
        $stream = New-Object System.IO.FileStream($script:LogPath, [System.IO.FileMode]::$mode,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try { $bytes = [System.Text.Encoding]::UTF8.GetBytes($line); $stream.Write($bytes, 0, $bytes.Length) }
        finally { $stream.Dispose() }
    } catch { }
}

function Show-Failure([string]$Message) {
    Write-TrayLog "failure: $Message"
    if ($script:Tray) {
        $script:Tray.ShowBalloonTip(8000, $script:AppTitle, $Message,
            [System.Windows.Forms.ToolTipIcon]::Error)
    } else {
        [void][System.Windows.Forms.MessageBox]::Show($Message, $script:AppTitle)
    }
}

function Invoke-Wsl([string]$Command, [int]$TimeoutSeconds = 30) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = "$env:SystemRoot\System32\wsl.exe"
    $info.Arguments = "-d $Distro -e bash -lc `"$Command`""
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw (T '无法启动 WSL。' 'Failed to start WSL.') }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # 只终止本次启动的 wsl.exe；AIReins 服务由 setsid 独立运行。
            $process.Kill()
            [void]$process.WaitForExit(2000)
            throw (T "WSL 命令超过 $TimeoutSeconds 秒未结束。" "The WSL command did not finish within $TimeoutSeconds seconds.")
        }
        if ($process.ExitCode -ne 0) { throw (T "WSL 命令失败，退出码 $($process.ExitCode)。" "The WSL command failed with exit code $($process.ExitCode).") }
    } finally { $process.Dispose() }
}

function Get-WbApi([string]$Path, [int]$TimeoutSeconds = 2) {
    # 无 Origin；loopback Host 符合 server/access.ts 的本机策略。
    $response = Invoke-RestMethod -Uri "$script:BaseUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
    if ($null -eq $response.code -or $response.code -ne 0) { throw (T "工作台接口返回错误：$($response.msg)" "The AIReins API returned an error: $($response.msg)") }
    return $response
}

# 只做 TCP 连接，不打 HTTP，定时器高频探测不刷 server.log。
function Test-Port {
    $client = New-Object System.Net.Sockets.TcpClient
    try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $client.Connected }
    catch { return $false }
    finally { $client.Close() }
}

function Test-Service {
    try { $null = Get-WbApi '/api/meta' 1; return $true } catch { return $false }
}

function Show-StartupWindow {
    if ($script:StartupWindow -or @([WbNative]::Windows()).Count -gt 0) { return }
    $light = $true
    try {
        $light = [Microsoft.Win32.Registry]::GetValue(
            'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize', 'AppsUseLightTheme', 1) -ne 0
    } catch { }
    $script:StartupWindow = New-Object System.Windows.Forms.Form
    $script:StartupWindow.SuspendLayout()
    $script:StartupWindow.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
    $script:StartupWindow.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    $script:StartupWindow.Font = [System.Drawing.SystemFonts]::MessageBoxFont
    $script:StartupWindow.Text = $script:AppTitle
    $script:StartupWindow.ClientSize = New-Object System.Drawing.Size(480, 200)
    $script:StartupWindow.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $script:StartupWindow.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $script:StartupWindow.ControlBox = $false
    $script:StartupWindow.ShowInTaskbar = $false
    $script:StartupWindow.BackColor = [System.Drawing.ColorTranslator]::FromHtml($(if ($light) { '#FAF8F2' } else { '#1F1E1D' }))
    $script:StartupWindow.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($(if ($light) { '#292724' } else { '#EEEAE3' }))
    if ($script:Icon) { $script:StartupWindow.Icon = $script:Icon }
    $title = New-Object System.Windows.Forms.Label
    $title.Text = $script:AppTitle
    $title.AutoSize = $false
    $title.SetBounds(32, 36, 416, 44)
    $script:StartupTitleFont = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
    $title.Font = $script:StartupTitleFont
    $status = New-Object System.Windows.Forms.Label
    $status.Text = T '正在启动，准备好后自动进入工作台…' 'Starting. AIReins will open when ready…'
    $status.SetBounds(34, 100, 414, 56)
    $script:StartupWindow.Controls.Add($title)
    $script:StartupWindow.Controls.Add($status)
    $script:StartupWindow.ResumeLayout($true)
    $script:StartupWindow.Show()
    $script:StartupWindow.Refresh()
    Write-TrayLog 'startup window: shown'
}

function Close-StartupWindow {
    if ($script:StartupWindow) {
        $script:StartupWindow.Dispose()
        $script:StartupWindow = $null
        Write-TrayLog 'startup window: closed'
    }
    if ($script:StartupTitleFont) {
        $script:StartupTitleFont.Dispose()
        $script:StartupTitleFont = $null
    }
}

function Ensure-Service {
    Write-TrayLog 'ensure service'
    # 已运行时不启动 WSL；首次与关闭 Chrome 后重开都走相同捷径。
    if (Test-Service) { Write-TrayLog 'ensure service: already ready'; return }
    Show-StartupWindow
    Invoke-Wsl "WORKBENCH_NO_OPEN=1 WORKBENCH_PORT=$Port $WbPath"
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        try { $null = Get-WbApi '/api/meta' 1; return } catch { $lastError = $_.Exception.Message }
        if ($clock.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 250 }
    } while ($clock.Elapsed.TotalSeconds -lt 15)
    throw (T "15 秒内工作台未就绪：$lastError" "AIReins was not ready within 15 seconds: $lastError")
}

# 以下判据只用参数，不调 Win32；测试从 AST 提取源函数运行。
function Get-ClickAction([bool]$alive, [bool]$visible, [bool]$iconic, [bool]$onTop) {
    if ($alive -and $visible -and (-not $iconic) -and $onTop) { return 'Hide' }
    return 'Show'
}

function Get-ShowAction([bool]$visible, [bool]$iconic, [bool]$onTop) {
    if ($iconic) { return 'Restore' }
    if ($visible -and (-not $onTop)) { return 'Reshow' }
    return 'Show'
}

# GetMessageTime / TickCount 同为有符号 32 位毫秒计数，差值需处理回绕。
function Get-TickElapsed([long]$now, [long]$then) {
    $elapsed = $now - $then
    if ($elapsed -lt -2147483648L) { $elapsed += 4294967296L }
    if ($elapsed -gt 2147483647L) { $elapsed -= 4294967296L }
    return $elapsed
}

# 单击裁决。Toggle=立即切换；StaleToggle=忙段（打开/启动段等）期间投递、泵恢复后补一次切换，
# 同一忙段只补一次（staleEpisodeEnd 记下该忙段结束时刻，其前投递的点击不再补）；
# Defer=正忙（含模态框泵消息），挂起到忙段结束；Drop*=丢弃。双击去重基于上一次受理的点击。
function Get-ClickVerdict([long]$sent, [long]$lastClick, [long]$actionEnd, [long]$staleEpisodeEnd,
        [bool]$busy, [bool]$exiting, [int]$doubleClickTime) {
    if ($exiting) { return 'DropExiting' }
    if ((Get-TickElapsed $sent $lastClick) -lt $doubleClickTime) { return 'DropDoubleClick' }
    if ($busy) {
        if ((Get-TickElapsed $sent $staleEpisodeEnd) -le 0) { return 'DropStale' }
        return 'Defer'
    }
    if ((Get-TickElapsed $sent $actionEnd) -le 0) {
        if ((Get-TickElapsed $sent $staleEpisodeEnd) -le 0) { return 'DropStale' }
        return 'StaleToggle'
    }
    return 'Toggle'
}

# 挂起与迟到请求共享裁决；失败后等用户下一次新操作，不在同一收尾重试。
function Get-PendingAction([bool]$failed, [bool]$exiting, [bool]$pendingShow,
        [bool]$pendingToggle, [bool]$showOnly, [bool]$showCovered) {
    if (-not ($pendingShow -or $pendingToggle)) { return 'None' }
    if ($exiting) { return 'DropExiting' }
    if ($failed) { return 'DropFailed' }
    if ($pendingShow -or $showOnly) {
        if ($showCovered) { return 'Covered' }
        return 'Show'
    }
    return 'Toggle'
}

# 只有成功显示记录覆盖投递时刻，且窗口现在仍可见、未最小化，才能省掉重复 Show。
function Test-ShowCovered([long]$sent, [long]$showEnd, [bool]$succeeded,
        [bool]$alive, [bool]$visible, [bool]$iconic) {
    return $succeeded -and $alive -and $visible -and (-not $iconic) -and
        ((Get-TickElapsed $sent $showEnd) -le 0)
}

function Test-CurrentShowCovered([long]$sent) {
    $windows = @([WbNative]::Windows())
    if ($windows.Length -eq 0) { return $false }
    $window = $windows[0]
    return Test-ShowCovered $sent $script:LastShowEndTick $script:LastShowSucceeded `
        ([WbNative]::IsWindow($window)) ([WbNative]::IsWindowVisible($window)) ([WbNative]::IsIconic($window))
}

function Test-WindowOnTop([IntPtr]$Window) {
    if (-not [WbNative]::IsWindowVisible($Window) -or [WbNative]::IsIconic($Window)) { return $false }
    $rect = New-Object WbNative+RECT
    if (-not [WbNative]::GetWindowRect($Window, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    # 与 ai-usage 相同：任一采样点属于本窗口即可；不用点托盘后已变成任务栏的前台句柄。
    foreach ($fraction in @(0.25, 0.5, 0.75)) {
        $point = New-Object WbNative+POINT
        $point.X = $rect.Left + [int]($width * $fraction)
        $point.Y = $rect.Top + [int]($height * $fraction)
        $top = [WbNative]::GetAncestor([WbNative]::WindowFromPoint($point), 2) # GA_ROOT
        if ($top -eq $Window) { return $true }
    }
    return $false
}

# 诊断用：窗口句柄与可见/最小化/露在最上/前台状态，定时器只在变化时记一行。
function Get-WindowState([IntPtr[]]$Windows) {
    $foreground = [WbNative]::GetForegroundWindow()
    $parts = foreach ($window in $Windows) {
        "hwnd=$window v=$([int][WbNative]::IsWindowVisible($window)) min=$([int][WbNative]::IsIconic($window)) max=$([int][WbNative]::IsZoomed($window)) top=$([int](Test-WindowOnTop $window)) fg=$([int]($window -eq $foreground))"
    }
    if (-not $parts) { return 'no window' }
    return ($parts -join '; ')
}

function Raise-Window([IntPtr]$Window) {
    if ($script:Icon) { [WbNative]::SetIcons($Window, $script:Icon.Handle, $script:LargeIcon.Handle) }
    $visible = [WbNative]::IsWindowVisible($Window)
    $iconic = [WbNative]::IsIconic($Window)
    $action = Get-ShowAction $visible $iconic (Test-WindowOnTop $Window)
    Write-TrayLog "raise $action $(Get-WindowState @($Window))"
    switch ($action) {
        'Restore' { [void][WbNative]::ShowWindow($Window, 9) } # SW_RESTORE
        'Reshow' {
            # 不学 ai-usage「先收再放」：本窗口在任务栏且与固定项同组，SW_HIDE 会让它像被收进托盘。
            # 改用置顶再取消置顶抬 Z 序，窗口全程不隐藏；焦点仍靠下面的 SetForegroundWindow，可能被前台锁拦下。
            [void][WbNative]::SetWindowPos($Window, [IntPtr](-1), 0, 0, 0, 0, 0x13) # HWND_TOPMOST, NOMOVE|NOSIZE|NOACTIVATE
            [void][WbNative]::SetWindowPos($Window, [IntPtr](-2), 0, 0, 0, 0, 0x13) # HWND_NOTOPMOST
        }
        'Show' { [void][WbNative]::ShowWindow($Window, 5) }
    }
    [void][WbNative]::SetForegroundWindow($Window)
}

function Switch-Workbench {
    if ($script:Busy -or $script:Exiting) { return }
    $script:LastActionFailed = $false
    $script:LastActionShowOnly = $false
    try {
        $windows = @([WbNative]::Windows())
        if ($windows.Length -eq 0) { Open-Workbench; return }
        $window = $windows[0]
        $alive = [WbNative]::IsWindow($window)
        $visible = $alive -and [WbNative]::IsWindowVisible($window)
        $iconic = $alive -and [WbNative]::IsIconic($window)
        $onTop = $alive -and (Test-WindowOnTop $window)
        if ((Get-ClickAction $alive $visible $iconic $onTop) -eq 'Hide') {
            Write-TrayLog 'click: hide'
            $script:LastShowSucceeded = $false
            [void][WbNative]::ShowWindow($window, 0) # SW_HIDE；任务栏按钮随之消失
        } else { Open-Workbench } # 顺带检查服务，wsl --shutdown 后点开会重新拉起
    } catch { $script:LastActionFailed = $true; Show-Failure $_.Exception.Message }
    finally { $script:LastActionEndTick = [Environment]::TickCount }
}

# 先记结束时刻并消费挂起状态；消费时标记该忙段，防止队列中迟到的点击再补一次。
function Complete-Action([bool]$Failed) {
    $script:LastActionEndTick = [Environment]::TickCount
    $script:LastActionFailed = $Failed
    $showOnly = $script:ShowOnlyPending
    $script:ShowOnlyPending = $false
    $script:LastActionShowOnly = $showOnly
    $sent = $script:LastClickTick
    if ($script:PendingShow) { $sent = $script:PendingShowTick }
    $action = Get-PendingAction $Failed $script:Exiting $script:PendingShow $script:PendingToggle `
        $showOnly (Test-CurrentShowCovered $sent)
    $script:PendingShow = $false
    $script:PendingToggle = $false
    if ($action -eq 'None') { return }
    $script:StaleEpisodeEnd = $script:LastActionEndTick
    Write-TrayLog "deferred request after busy: $action"
    switch ($action) {
        'Show' { Open-Workbench }
        'Toggle' { Switch-Workbench }
    }
    # 补操作可能也有同步等待；其结束前的迟到点击仍属于已消费的这一段。
    $script:LastActionEndTick = [Environment]::TickCount
    $script:StaleEpisodeEnd = $script:LastActionEndTick
    $script:LastActionShowOnly = $showOnly
}

# 备用实例（任务栏/快捷方式）经消息窗口转交的显示请求；成功显示和当前窗口状态共同决定覆盖。
function Invoke-ForwardedShow {
    $sent = [WbNative]::GetMessageTime()
    if ($script:Exiting) { Write-TrayLog 'forward: dropped (exiting)'; return }
    if ($script:Busy) {
        $script:PendingShow = $true
        $script:PendingShowTick = $sent
        Write-TrayLog 'forward: deferred (busy)'
        return
    }
    $stale = (Get-TickElapsed $sent $script:LastActionEndTick) -le 0
    $action = Get-PendingAction ($stale -and $script:LastActionFailed) $false $true $false `
        $false (Test-CurrentShowCovered $sent)
    Write-TrayLog "forward: $action"
    if ($action -eq 'Show') { Open-Workbench }
}

# 两实例同时启动、或双击托盘时，串行执行找窗口/开窗口，避免重复 Chrome 窗口。
$script:OpenMutex = New-Object System.Threading.Mutex($false, "Local\Workbench.Open.$Distro.$Port")
function Open-Workbench {
    if ($script:Busy -or $script:Exiting) { return }
    $script:Busy = $true
    $script:LastActionFailed = $false
    $script:LastShowSucceeded = $false
    $locked = $false
    try {
        try { $locked = $script:OpenMutex.WaitOne(60000) }
        catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw (T '另一个实例仍在打开工作台，请稍后重试。' 'Another instance is still opening AIReins. Try again later.') }
        $windows = @([WbNative]::Windows())
        Write-TrayLog "open: windows=$($windows.Length)"
        # 窗口还在但服务已停（wsl --shutdown 后页面一直断线）时不能只抬窗口，要先拉起服务，页面会自己重连。
        Ensure-Service
        if ($windows.Length -gt 0) {
            Raise-Window $windows[0]
            # 外部 SW_SHOW 可能被 Chrome 收回（tray.log 10-03：抬完约 0.2 秒又被藏起）；补显示一次，再显示后 Chrome 不会再藏。
            Start-Sleep -Milliseconds 300
            if ([WbNative]::IsWindow($windows[0]) -and -not [WbNative]::IsWindowVisible($windows[0]) -and
                    -not [WbNative]::IsIconic($windows[0])) {
                Write-TrayLog 'raise: hidden again, re-show once'
                [void][WbNative]::ShowWindow($windows[0], 5) # SW_SHOW
                [void][WbNative]::SetForegroundWindow($windows[0])
            }
            return
        }
        # 获取锁后再次枚举，避免启动期间用户从备用入口开了窗口。
        $windows = @([WbNative]::Windows())
        $launched = $false
        if ($windows.Length -eq 0) {
            $launched = $true
            $chrome = Resolve-Chrome
            Write-TrayLog 'open: launch chrome'
            $null = Start-Process -FilePath $chrome -ArgumentList "--app=$script:BaseUrl/"
        }
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        do {
            $windows = @([WbNative]::Windows())
            if ($windows.Length -gt 0) {
                # 刚由本次启动的 Chrome 窗口不抬起：10-02 对照实验，新建约 0.5 秒时对它 WM_SETICON + SW_SHOW + SetForegroundWindow，
                # Chrome 约 0.2 秒后会把窗口 SW_HIDE（「闪一下缩回托盘」）；不碰它则两次都不再隐藏。它启动时已拿到前台，无需抬。
                # 图标推迟到 1.5 秒再设，实测不触发隐藏。
                if ($launched) { Write-TrayLog "fresh window, skip raise $(Get-WindowState @($windows[0]))" }
                else { Raise-Window $windows[0] }
                Close-StartupWindow
                $script:HadWindow = $true
                # 兜底：3 秒内每 50ms 采样，窗口被外部隐藏（不可见且未最小化）就补显示一次；再显示后 Chrome 不会再藏。
                # 期间泵进来的托盘单击走挂起；启动前无窗口时只补显示，其余忙段按当时状态补一次切换。
                $last = ''
                $reshown = $false
                for ($i = 0; $i -lt 60; $i++) {
                    Start-Sleep -Milliseconds 50 # 采样越密，被藏到补显示之间的闪烁越短
                    if ($launched -and $i -eq 30 -and $script:Icon) {
                        Write-TrayLog 'after open: set icons'
                        [WbNative]::SetIcons($windows[0], $script:Icon.Handle, $script:LargeIcon.Handle)
                    }
                    $current = @([WbNative]::Windows())
                    $state = Get-WindowState $current
                    if ($state -ne $last) { Write-TrayLog "after open: $state"; $last = $state }
                    if (-not $reshown -and $current.Length -gt 0 -and
                            -not [WbNative]::IsWindowVisible($current[0]) -and -not [WbNative]::IsIconic($current[0])) {
                        $reshown = $true
                        Write-TrayLog 'after open: hidden externally, re-show'
                        [void][WbNative]::ShowWindow($current[0], 5) # SW_SHOW
                        [void][WbNative]::SetForegroundWindow($current[0])
                    }
                }
                return
            }
            Start-Sleep -Milliseconds 200
        } while ($clock.Elapsed.TotalSeconds -lt 15)
        throw (T '15 秒内未找到工作台窗口，请检查 Chrome 是否正常启动。' 'The AIReins window was not found within 15 seconds. Check whether Chrome started normally.')
    } catch { $script:LastActionFailed = $true; Close-StartupWindow; Show-Failure $_.Exception.Message }
    finally {
        Close-StartupWindow
        if ($locked) { $script:OpenMutex.ReleaseMutex() }
        $windows = @([WbNative]::Windows())
        $script:LastShowSucceeded = -not $script:LastActionFailed -and $windows.Length -gt 0 -and
            [WbNative]::IsWindowVisible($windows[0]) -and -not [WbNative]::IsIconic($windows[0])
        if ($script:LastShowSucceeded) { $script:LastShowEndTick = [Environment]::TickCount }
        $script:Busy = $false
        Complete-Action $script:LastActionFailed
    }
}

function Show-ExitPrompt([string]$Message) {
    return [System.Windows.Forms.MessageBox]::Show($Message, $script:AppTitle,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2) -eq [System.Windows.Forms.DialogResult]::Yes
}

function Exit-Workbench {
    $sent = [WbNative]::GetMessageTime()
    Write-TrayLog "exit: busy=$script:Busy exiting=$script:Exiting sentBeforeLastAction=$((Get-TickElapsed $sent $script:LastActionEndTick) -le 0)"
    if ($script:Exiting) { return }
    if ($script:Busy) {
        # 打开流程（启动 WSL 时可达几十秒）阻塞期间菜单仍可能弹出；不能静默吞掉退出。气泡可能被系统通知设置屏蔽，用对话框。
        [void][System.Windows.Forms.MessageBox]::Show(
            (T '正在打开工作台（WSL 冷启动可能要几十秒），完成后再点退出。' 'AIReins is being opened (a WSL cold start can take tens of seconds). Click Exit again after it finishes.'),
            $script:AppTitle)
        return
    }
    # 打开流程同步阻塞时，菜单点击可能被积压到打开结束后才处理，表现为窗口刚出现就被退出关掉；这种迟到的退出要再确认。
    if ((Get-TickElapsed $sent $script:LastActionEndTick) -le 0 -and
            -not (Show-ExitPrompt (T '这次「退出」是在打开工作台的过程中点的，刚才被延后处理了。仍要退出？' 'This Exit was clicked while AIReins was opening and was deferred until now. Exit anyway?'))) { return }
    $script:Busy = $true
    $locked = $false
    try {
        # 与备用实例的打开流程互斥，避免一边关窗停服务、一边又拉起服务开窗口。
        try { $locked = $script:OpenMutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) {
            [void][System.Windows.Forms.MessageBox]::Show(
                (T '另一个入口正在打开工作台，完成后再点退出。' 'Another entry point is opening AIReins. Click Exit again after it finishes.'),
                $script:AppTitle)
            return
        }
        $servicePresent = $true
        try {
            $response = Get-WbApi '/api/sessions'
            # 契约没有会话列表中的未决闸门字段；统计 running，以及主回合已结束但仍有后台任务（委派中的 codex 等）的会话。
            $sessions = $response.data
            if ($sessions -isnot [System.Array]) { $sessions = $response.data.sessions }
            if ($sessions -isnot [System.Array]) { throw (T '会话列表格式无法识别，暂不停止服务。' 'Unrecognized session list format; the service was not stopped.') }
            foreach ($session in $sessions) {
                if ($null -eq $session.status) { throw (T '会话状态字段缺失，暂不停止服务。' 'The session status field is missing; the service was not stopped.') }
            }
            # 先判非空：PowerShell 5.1 里 @($null).Count 是 1，缺字段（旧服务）会被误算成有后台任务
            $running = @($sessions | Where-Object { $_.status -eq 'running' -or ($_.backgroundTasks -and @($_.backgroundTasks).Count -gt 0) }).Count
        } catch {
            # 仅连接拒绝视为服务不在；超时、HTTP/格式错误交给下面的确认框。
            $cause = $_.Exception
            while ($cause.InnerException -and $cause -isnot [System.Net.WebException]) { $cause = $cause.InnerException }
            if ($cause -is [System.Net.WebException] -and $cause.Status -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
                $servicePresent = $false
                $running = 0
            } else {
                # 超时、HTTP/格式错误：不猜没有活会话，但交给用户决定，不能让托盘退不掉。
                Write-TrayLog "exit: session check failed: $($_.Exception.Message)"
                if (-not (Show-ExitPrompt (T "无法确认是否有会话在运行（$($_.Exception.Message)）。`n仍要退出？会尝试停止服务，可能中断正在运行的会话。" "Could not confirm whether sessions are running ($($_.Exception.Message)).`nExit anyway? The service will be stopped, which may interrupt running sessions."))) { return }
                $running = 0
            }
        }
        Write-TrayLog "exit: servicePresent=$servicePresent running=$running"
        if ($running -gt 0) {
            if (-not (Show-ExitPrompt (T "有 $running 个会话正在运行，退出会中断它们。仍要退出？" "$running session(s) are running and exiting will interrupt them. Exit anyway?"))) { return }
        }
        $script:Exiting = $true
        foreach ($window in [WbNative]::Windows()) {
            [void][WbNative]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
        }
        # 先收图标再停服务：aireins stop 要等各 CLI worker 优雅退出（每个最多约 2 秒）加 wsl.exe 往返，图标别跟着卡几秒。
        # 窗口已关，停服务失败也照样退出托盘，否则托盘留着、窗口没了，像「退出没反应」。
        $script:Tray.Visible = $false
        $stopError = $null
        if ($servicePresent) {
            try { Invoke-Wsl "WORKBENCH_PORT=$Port $WbPath stop" }
            catch { $stopError = $_.Exception.Message; Write-TrayLog "exit: stop failed: $stopError" }
        }
        Write-TrayLog 'exit: done'
        if ($stopError) {
            # 弹框前先放开 OpenMutex，用户没及时关框时备用入口不至于干等超时。
            if ($locked) { $script:OpenMutex.ReleaseMutex(); $locked = $false }
            [void][System.Windows.Forms.MessageBox]::Show(
                (T "托盘已退出，但停止服务失败：$stopError`n可在 WSL 里运行 aireins stop。" "The tray has exited, but stopping the service failed: $stopError`nYou can run aireins stop inside WSL."),
                $script:AppTitle)
        }
        $script:Context.ExitThread()
    } catch {
        $script:Exiting = $false
        Show-Failure $_.Exception.Message
    } finally {
        if ($locked) { $script:OpenMutex.ReleaseMutex() }
        $script:Busy = $false
        Complete-Action $false
    }
}

$instance = New-Object System.Threading.Mutex($false, "Local\Workbench.Tray.$Distro.$Port")
$ownsInstance = $false
$timer = $null
$menu = $null
try {
    try { $ownsInstance = $instance.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsInstance = $true }
    Write-TrayLog "start: owner=$ownsInstance"
    if (-not $ownsInstance) {
        # 转交而非自己抬窗：tray.log 10-03 证实备用实例对隐藏窗口的 SW_SHOW + SetForegroundWindow
        # 从未生效（8 次全败，窗口保持 v=0；owner 同样的调用 6 次全成），且它的补显示看门狗
        # 会把用户刚收进托盘的窗口重新放出来。显示、还原、抬前台、无窗口时重开全由 owner 执行。
        # 类名必须传 [NullString]::Value：PowerShell 把 $null 转成 "" 传给 string 参数，按空类名永远找不到。
        $target = [WbNative]::FindWindowEx([IntPtr](-3), [IntPtr]::Zero, [NullString]::Value, "Workbench.Tray.Show.$Distro.$Port")
        $forwarded = $false
        if ($target -ne [IntPtr]::Zero) {
            # 本进程因任务栏/快捷方式点击拿到前台权限；放行给 owner，它抬窗时才能抢到前台。
            [void][WbNative]::AllowSetForegroundWindow(-1) # ASFW_ANY
            $forwarded = [WbNative]::PostMessage($target, [WbNative]::WM_APP_SHOW, [IntPtr]::Zero, [IntPtr]::Zero)
            if ($forwarded) { Write-TrayLog 'start: forwarded show to owner' }
            else { Write-TrayLog 'start: PostMessage show failed, waiting for takeover' }
        } else {
            Write-TrayLog 'start: owner message window not found, waiting for takeover'
        }
        # 退出时图标先收、服务后停，用户这时点任务栏会进到这里；旧托盘走完收尾才放实例互斥量，
        # 等待最多 35 秒，覆盖 Invoke-Wsl 停服务的 30 秒超时和收尾；旧 owner 的模态提示仍可能超过此期限。
        try { $ownsInstance = $instance.WaitOne(35000) }
        catch [System.Threading.AbandonedMutexException] { $ownsInstance = $true }
        Write-TrayLog "start: takeover owner=$ownsInstance"
        if (-not $ownsInstance) {
            Write-TrayLog "start: takeover timed out (35s), forwarded=$forwarded; owner lock still held"
            if (-not $forwarded) { Show-Failure (T '未能转交显示请求或接管托盘，请稍后再点快捷方式。' 'Could not forward the show request or take over the tray. Click the shortcut again later.') }
            return
        }
    }

    # 先建消息窗口再走启动段：备用实例在启动期间也能把显示请求投进队列。
    $script:ShowListener = New-Object WbTrayListener
    $script:ShowListener.add_ShowRequested({ Invoke-ForwardedShow })
    $script:ShowListener.Create("Workbench.Tray.Show.$Distro.$Port")

    $iconPath = Join-Path $PSScriptRoot 'aireins.ico'
    try {
        $script:Icon = New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
        $script:LargeIcon = New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::IconSize)
    } catch {
        if ($script:Icon) { $script:Icon.Dispose() }
        $script:Icon = New-FallbackIcon
        $script:LargeIcon = $script:Icon.Clone()
    }
    $script:Context = New-Object System.Windows.Forms.ApplicationContext
    $script:Tray = New-Object System.Windows.Forms.NotifyIcon
    $script:Tray.Icon = $script:Icon
    $script:Tray.Text = $script:AppTitle
    $script:Tray.add_BalloonTipShown({ Write-TrayLog 'balloon: shown' })
    $script:Tray.add_BalloonTipClosed({ Write-TrayLog 'balloon: closed' })
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $openItem = $menu.Items.Add((T '打开工作台' 'Open AIReins'))
    $exitItem = $menu.Items.Add((T '退出' 'Exit'))
    $openItem.add_Click({ Open-Workbench })
    $exitItem.add_Click({ Exit-Workbench })
    $script:Tray.ContextMenuStrip = $menu
    $script:Tray.add_MouseClick({ param($sender, $eventArgs)
        if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
        $sent = [WbNative]::GetMessageTime()
        $verdict = Get-ClickVerdict $sent $script:LastClickTick $script:LastActionEndTick `
            $script:StaleEpisodeEnd $script:Busy $script:Exiting `
            ([System.Windows.Forms.SystemInformation]::DoubleClickTime)
        switch ($verdict) {
            'Toggle' { $script:LastClickTick = $sent; Switch-Workbench }
            'StaleToggle' {
                $script:LastClickTick = $sent
                $script:StaleEpisodeEnd = $script:LastActionEndTick
                $action = Get-PendingAction $script:LastActionFailed $false $false $true `
                    $script:LastActionShowOnly (Test-CurrentShowCovered $sent)
                Write-TrayLog "click: queued during busy, $action once"
                switch ($action) {
                    'Show' { Open-Workbench }
                    'Toggle' { Switch-Workbench }
                }
                $script:StaleEpisodeEnd = $script:LastActionEndTick
            }
            'Defer' {
                $script:LastClickTick = $sent
                $script:PendingToggle = $true
                Write-TrayLog 'click: deferred (busy)'
            }
            default { Write-TrayLog "click: dropped ($verdict)" }
        }
    })
    # 不挂 MouseDoubleClick：双击的第二次 MouseClick 由投递时间过滤。
    $script:Tray.Visible = $true

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.add_Tick({
        if ($script:Busy -or $script:Exiting) { return }
        $windows = @([WbNative]::Windows())
        $hasWindow = $windows.Length -gt 0
        if ($script:HadWindow -and -not $hasWindow -and -not $script:NotifiedClose) {
            $script:NotifiedClose = $true
            $script:Tray.ShowBalloonTip(8000, $script:AppTitle,
                (T '工作台已收到托盘，会话照常运行。右键图标选「退出」可彻底退出' 'AIReins is now in the tray; sessions keep running. Right-click the icon and choose Exit to quit completely'),
                [System.Windows.Forms.ToolTipIcon]::Info)
        }
        $script:HadWindow = $hasWindow
        $state = Get-WindowState $windows
        if ($state -ne $script:LastWindowState) { Write-TrayLog "tick: $state"; $script:LastWindowState = $state }
        foreach ($window in $windows) {
            [WbNative]::SetIcons($window, $script:Icon.Handle, $script:LargeIcon.Handle)
        }
        # wsl --shutdown 后窗口还在、经任务栏激活不走本脚本：用户正看着工作台而端口不通时拉起服务，页面自己重连。
        # 只在窗口处于前台时探测，不会在后台把刚关掉的 WSL 唤醒；失败后 30 秒内不重试，免得反复弹错。
        # Busy 只包 TCP 探测；Task.Wait 会泵消息，探测结束先清 Busy，再由 Open 管理拉起和收尾。
        $now = [Environment]::TickCount
        if ($hasWindow -and ($windows -contains [WbNative]::GetForegroundWindow()) -and
                (Get-TickElapsed $now $script:LastReviveTick) -gt 30000) {
            $script:Busy = $true
            $portReady = $false
            try { $portReady = Test-Port }
            finally { $script:Busy = $false }
            if (-not $portReady -and -not $script:Exiting) {
                Write-TrayLog 'tick: service down while window in foreground'
                try { Open-Workbench }
                finally { $script:LastReviveTick = [Environment]::TickCount } # 真正尝试启动后才进入冷却
            } else { Complete-Action $false }
        }
    })
    # 首次启动与后续重开共用健康检查、启动窗和失败清理；Open 自己管理 Busy。
    $script:ShowOnlyPending = @([WbNative]::Windows()).Count -eq 0
    Open-Workbench
    $script:HadWindow = @([WbNative]::Windows()).Count -gt 0
    $timer.Start()
    [System.Windows.Forms.Application]::Run($script:Context)
} finally {
    Close-StartupWindow
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($script:Tray) { $script:Tray.Visible = $false; $script:Tray.Dispose() }
    if ($menu) { $menu.Dispose() }
    if ($script:Context) { $script:Context.Dispose() }
    if ($script:ShowListener) { $script:ShowListener.DestroyHandle() }
    if ($script:Icon) { $script:Icon.Dispose() }
    if ($script:LargeIcon) { $script:LargeIcon.Dispose() }
    $script:OpenMutex.Dispose()
    if ($ownsInstance) { $instance.ReleaseMutex() }
    $instance.Dispose()
}
