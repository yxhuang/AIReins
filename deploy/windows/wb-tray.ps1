<#
.SYNOPSIS
    Workbench 工作台托盘入口（Windows PowerShell 5.1）。
.DESCRIPTION
    Chrome 自绘标题栏无法从外部拦截 ×。看门狗发现窗口消失时视为收到托盘，
    下次点击重开页面；WSL 服务和会话继续运行。保留任务栏及系统最小化行为。
    左键单击切换显隐；被遮挡或最小化时先显示，双击和冷启动期间补点只受理一次。
    使用默认 Chrome 配置，以保留 localStorage 和已登录的外部站点。
.NOTES
    必须使用 UTF-8 带 BOM 保存，由 powershell.exe 5.1 运行，不用 pwsh。
    按 Chrome_WidgetWin_1 类名和标题认窗口，不查进程命令行，不会匹配脚本自身。
    仓库修改后需重跑 install-tray.ps1，退出旧托盘实例再启动。
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8790,
    [ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distro = 'ubuntu'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class WbNative {
    private delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern int GetMessageTime();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
    public static IntPtr[] Windows() {
        var hits = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            var cls = new StringBuilder(256);
            var title = new StringBuilder(1024);
            GetClassName(h, cls, cls.Capacity);
            GetWindowText(h, title, title.Capacity);
            string t = title.ToString();
            if (cls.ToString() == "Chrome_WidgetWin_1" &&
                (t == "workbench" || t.EndsWith(" · workbench", StringComparison.Ordinal))) hits.Add(h);
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
'@

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
    throw '没有找到 Google Chrome，请先安装 Chrome。'
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
        $script:Tray.ShowBalloonTip(8000, 'Workbench 工作台', $Message,
            [System.Windows.Forms.ToolTipIcon]::Error)
    } else {
        [void][System.Windows.Forms.MessageBox]::Show($Message, 'Workbench 工作台')
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
        if (-not $process.Start()) { throw '无法启动 WSL。' }
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # 只终止本次启动的 wsl.exe；wb 服务由 setsid 独立运行。
            $process.Kill()
            [void]$process.WaitForExit(2000)
            throw "WSL 命令超过 $TimeoutSeconds 秒未结束。"
        }
        if ($process.ExitCode -ne 0) { throw "WSL 命令失败，退出码 $($process.ExitCode)。" }
    } finally { $process.Dispose() }
}

function Get-WbApi([string]$Path, [int]$TimeoutSeconds = 2) {
    # 无 Origin；loopback Host 符合 server/access.ts 的本机策略。
    $response = Invoke-RestMethod -Uri "$script:BaseUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
    if ($null -eq $response.code -or $response.code -ne 0) { throw "工作台接口返回错误：$($response.msg)" }
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

function Ensure-Service {
    Write-TrayLog 'ensure service'
    Invoke-Wsl "WORKBENCH_NO_OPEN=1 WORKBENCH_PORT=$Port /home/user/.local/bin/workbench"
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        try { $null = Get-WbApi '/api/meta' 1; return } catch { $lastError = $_.Exception.Message }
        if ($clock.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 250 }
    } while ($clock.Elapsed.TotalSeconds -lt 15)
    throw "15 秒内工作台未就绪：$lastError"
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

function Test-AcceptClick([long]$sent, [long]$actionEnd, [long]$lastClick, [int]$doubleClickTime) {
    if ((Get-TickElapsed $sent $actionEnd) -le 0) { return $false }
    if ((Get-TickElapsed $sent $lastClick) -lt $doubleClickTime) { return $false }
    return $true
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
        "hwnd=$window v=$([int][WbNative]::IsWindowVisible($window)) min=$([int][WbNative]::IsIconic($window)) top=$([int](Test-WindowOnTop $window)) fg=$([int]($window -eq $foreground))"
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
            [void][WbNative]::ShowWindow($window, 0) # SW_HIDE；任务栏按钮随之消失
        } else { Open-Workbench } # 顺带检查服务，wsl --shutdown 后点开会重新拉起
    } catch { Show-Failure $_.Exception.Message }
    finally { $script:LastActionEndTick = [Environment]::TickCount }
}

# 两实例同时启动、或双击托盘时，串行执行找窗口/开窗口，避免重复 Chrome 窗口。
$script:OpenMutex = New-Object System.Threading.Mutex($false, "Local\Workbench.Open.$Distro.$Port")
function Open-Workbench([switch]$ServiceReady, [switch]$RetryService) {
    if ($script:Busy -or $script:Exiting) { return }
    $script:Busy = $true
    $locked = $false
    try {
        try { $locked = $script:OpenMutex.WaitOne(60000) }
        catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '另一个实例仍在打开工作台，请稍后重试。' }
        $windows = @([WbNative]::Windows())
        Write-TrayLog "open: windows=$($windows.Length) serviceReady=$ServiceReady retry=$RetryService"
        # 窗口还在但服务已停（wsl --shutdown 后页面一直断线）时不能只抬窗口，要先拉起服务，页面会自己重连。
        if ($windows.Length -gt 0 -and -not $RetryService -and ($ServiceReady -or (Test-Service))) {
            Raise-Window $windows[0]; return
        }
        if (-not $ServiceReady) { Ensure-Service }
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
                $script:HadWindow = $true
                # 兜底：3 秒内每 50ms 采样，窗口被外部隐藏（不可见且未最小化）就补显示一次；再显示后 Chrome 不会再藏。
                # 这段时间 UI 线程被占着，用户的托盘单击不会在此期间执行，不会和「单击收起」打架。
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
        throw '15 秒内未找到工作台窗口，请检查 Chrome 是否正常启动。'
    } catch { Show-Failure $_.Exception.Message }
    finally {
        if ($locked) { $script:OpenMutex.ReleaseMutex() }
        $script:Busy = $false
        $script:LastActionEndTick = [Environment]::TickCount
    }
}

function Show-ExitPrompt([string]$Message) {
    return [System.Windows.Forms.MessageBox]::Show($Message, 'Workbench 工作台',
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
        [void][System.Windows.Forms.MessageBox]::Show('正在打开工作台（WSL 冷启动可能要几十秒），完成后再点退出。', 'Workbench 工作台')
        return
    }
    # 打开流程同步阻塞时，菜单点击可能被积压到打开结束后才处理，表现为窗口刚出现就被退出关掉；这种迟到的退出要再确认。
    if ((Get-TickElapsed $sent $script:LastActionEndTick) -le 0 -and
            -not (Show-ExitPrompt '这次「退出」是在打开工作台的过程中点的，刚才被延后处理了。仍要退出？')) { return }
    $script:Busy = $true
    $locked = $false
    try {
        # 与备用实例的打开流程互斥，避免一边关窗停服务、一边又拉起服务开窗口。
        try { $locked = $script:OpenMutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) {
            [void][System.Windows.Forms.MessageBox]::Show('另一个入口正在打开工作台，完成后再点退出。', 'Workbench 工作台')
            return
        }
        $servicePresent = $true
        try {
            $response = Get-WbApi '/api/sessions'
            # 契约没有会话列表中的未决闸门字段；统计 running，以及主回合已结束但仍有后台任务（委派中的 codex 等）的会话。
            $sessions = $response.data
            if ($sessions -isnot [System.Array]) { $sessions = $response.data.sessions }
            if ($sessions -isnot [System.Array]) { throw '会话列表格式无法识别，暂不停止服务。' }
            foreach ($session in $sessions) {
                if ($null -eq $session.status) { throw '会话状态字段缺失，暂不停止服务。' }
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
                if (-not (Show-ExitPrompt "无法确认是否有会话在运行（$($_.Exception.Message)）。`n仍要退出？会尝试停止服务，可能中断正在运行的会话。")) { return }
                $running = 0
            }
        }
        Write-TrayLog "exit: servicePresent=$servicePresent running=$running"
        if ($running -gt 0) {
            if (-not (Show-ExitPrompt "有 $running 个会话正在运行，退出会中断它们。仍要退出？")) { return }
        }
        $script:Exiting = $true
        foreach ($window in [WbNative]::Windows()) {
            [void][WbNative]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) # WM_CLOSE
        }
        # 先收图标再停服务：wb stop 要等各 CLI worker 优雅退出（每个最多约 2 秒）加 wsl.exe 往返，图标别跟着卡几秒。
        # 窗口已关，停服务失败也照样退出托盘，否则托盘留着、窗口没了，像「退出没反应」。
        $script:Tray.Visible = $false
        $stopError = $null
        if ($servicePresent) {
            try { Invoke-Wsl "WORKBENCH_PORT=$Port /home/user/.local/bin/workbench stop" }
            catch { $stopError = $_.Exception.Message; Write-TrayLog "exit: stop failed: $stopError" }
        }
        Write-TrayLog 'exit: done'
        if ($stopError) {
            # 弹框前先放开 OpenMutex，用户没及时关框时备用入口不至于干等超时。
            if ($locked) { $script:OpenMutex.ReleaseMutex(); $locked = $false }
            [void][System.Windows.Forms.MessageBox]::Show(
                "托盘已退出，但停止服务失败：$stopError`n可在 WSL 里运行 wb stop。", 'Workbench 工作台')
        }
        $script:Context.ExitThread()
    } catch {
        $script:Exiting = $false
        Show-Failure $_.Exception.Message
    } finally {
        if ($locked) { $script:OpenMutex.ReleaseMutex() }
        $script:Busy = $false
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
        Open-Workbench
        # 退出时图标先收、服务后停，用户这时点任务栏会进到这里；打开流程等退出放开 OpenMutex 后才继续，
        # 旧托盘放开 OpenMutex 后还要走完收尾才放实例互斥量，等 3 秒再接手，免得只剩窗口没有托盘。
        # 旧托盘正常在跑时这里白等 3 秒，窗口已抬起，用户无感。
        try { $ownsInstance = $instance.WaitOne(3000) }
        catch [System.Threading.AbandonedMutexException] { $ownsInstance = $true }
        Write-TrayLog "start: takeover owner=$ownsInstance"
        if (-not $ownsInstance) { return }
    }

    $iconPath = Join-Path $PSScriptRoot 'workbench.ico'
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
    $script:Tray.Text = 'Workbench 工作台'
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $openItem = $menu.Items.Add('打开工作台')
    $exitItem = $menu.Items.Add('退出')
    $openItem.add_Click({ Open-Workbench -RetryService })
    $exitItem.add_Click({ Exit-Workbench })
    $script:Tray.ContextMenuStrip = $menu
    $script:Tray.add_MouseClick({ param($sender, $eventArgs)
        if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
        $sent = [WbNative]::GetMessageTime()
        if (Test-AcceptClick $sent $script:LastActionEndTick $script:LastClickTick `
                ([System.Windows.Forms.SystemInformation]::DoubleClickTime)) {
            $script:LastClickTick = $sent
            Switch-Workbench
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
            $script:Tray.ShowBalloonTip(8000, 'Workbench 工作台',
                '工作台已收到托盘，会话照常运行。右键图标选「退出」可彻底退出',
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
        $now = [Environment]::TickCount
        if ($hasWindow -and ($windows -contains [WbNative]::GetForegroundWindow()) -and
                (Get-TickElapsed $now $script:LastReviveTick) -gt 30000 -and -not (Test-Port)) {
            Write-TrayLog 'tick: service down while window in foreground'
            Open-Workbench
            $script:LastReviveTick = [Environment]::TickCount # 冷却从这次尝试结束算起
        }
    })
    # 无论是否已有窗口，首次启动均确保服务就绪；失败后保留托盘供重试。
    try { Ensure-Service; Open-Workbench -ServiceReady } catch { Show-Failure $_.Exception.Message }
    $script:HadWindow = @([WbNative]::Windows()).Count -gt 0
    $timer.Start()
    [System.Windows.Forms.Application]::Run($script:Context)
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($script:Tray) { $script:Tray.Visible = $false; $script:Tray.Dispose() }
    if ($menu) { $menu.Dispose() }
    if ($script:Context) { $script:Context.Dispose() }
    if ($script:Icon) { $script:Icon.Dispose() }
    if ($script:LargeIcon) { $script:LargeIcon.Dispose() }
    $script:OpenMutex.Dispose()
    if ($ownsInstance) { $instance.ReleaseMutex() }
    $instance.Dispose()
}
