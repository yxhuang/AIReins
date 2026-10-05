<#
.SYNOPSIS
    测试 wb 托盘的纯逻辑判据；Windows PowerShell 5.1 / Linux pwsh 均可运行。
.DESCRIPTION
    按 ai-usage 的 tray-click-filter 测试方式，用 AST 提取源函数，不复制实现。
    不加载 WinForms、不运行托盘、不调用 Win32；双击间隔以测试参数传入。
.NOTES
    保存为 UTF-8 带 BOM，供 Windows PowerShell 5.1 正确读取中文。
    powershell -ExecutionPolicy Bypass -File .\deploy\windows\tests\tray-click-filter.ps1
#>
$ErrorActionPreference = 'Stop'
$src = Join-Path (Split-Path $PSScriptRoot -Parent) 'wb-tray.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($src, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
# 自身也解析；只执行提取的函数，源文件的启动代码不会运行。
$selfErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$selfErrors)
if ($selfErrors -and $selfErrors.Count -gt 0) { throw ($selfErrors | Out-String) }
foreach ($name in @('Get-ClickAction', 'Get-ShowAction', 'Get-TickElapsed', 'Get-ClickVerdict', 'Get-PendingAction', 'Test-ShowCovered', 'Complete-Action')) {
    $functions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($functions.Count -ne 1) { throw "源文件应有且只有一个 $name" }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}
$script:failed = 0
$script:checked = 0
function Check([string]$name, $expected, $actual) {
    $script:checked++
    if ($expected -eq $actual) { Write-Host "PASS $name" }
    else {
        Write-Host "FAIL $name (expected=$expected actual=$actual)"
        $script:failed++
    }
}

# 穷举显隐状态，只有这一个组合允许隐藏。
foreach ($alive in @($false, $true)) {
    foreach ($visible in @($false, $true)) {
        foreach ($iconic in @($false, $true)) {
            foreach ($onTop in @($false, $true)) {
                $expected = 'Show'
                if ((@($alive, $visible, $iconic, $onTop) -join ',') -eq 'True,True,False,True') { $expected = 'Hide' }
                Check "toggle alive=$alive visible=$visible iconic=$iconic onTop=$onTop" `
                    $expected (Get-ClickAction $alive $visible $iconic $onTop)
            }
        }
    }
}
Check '窗口在最上面时隐藏' 'Hide' (Get-ClickAction $true $true $false $true)
Check '被完全遮挡时显示' 'Show' (Get-ClickAction $true $true $false $false)
Check '隐藏窗口显示' 'Show' (Get-ClickAction $true $false $false $false)
Check '最小化窗口显示' 'Show' (Get-ClickAction $true $true $true $false)
Check '窗口不存在时打开' 'Show' (Get-ClickAction $false $false $false $false)

# 显示路径：最小化优先恢复；已显示但被遮挡才抬 Z 序（置顶再取消置顶）。
$showCases = @(
    @($false, $false, $false, 'Show'),
    @($false, $false, $true,  'Show'),
    @($false, $true,  $false, 'Restore'),
    @($false, $true,  $true,  'Restore'),
    @($true,  $false, $false, 'Reshow'),
    @($true,  $false, $true,  'Show'),
    @($true,  $true,  $false, 'Restore'),
    @($true,  $true,  $true,  'Restore')
)
foreach ($case in $showCases) {
    Check "show visible=$($case[0]) iconic=$($case[1]) onTop=$($case[2])" `
        $case[3] (Get-ShowAction $case[0] $case[1] $case[2])
}

# 单击裁决。投递时刻而非处理时刻；纯函数不修改上一点击的时间。
# 参数序：sent, lastClick, actionEnd, staleEpisodeEnd, busy, exiting, doubleClickTime。
foreach ($doubleClickTime in @(200, 500, 900)) {
    Check "闲时单击 ($doubleClickTime ms)" 'Toggle' (Get-ClickVerdict 20000 0 10000 -1 $false $false $doubleClickTime)
    Check "双击第二下 ($doubleClickTime ms)" 'DropDoubleClick' `
        (Get-ClickVerdict (20000 + [int]($doubleClickTime / 2)) 20000 10000 -1 $false $false $doubleClickTime)
    Check "间隔前一毫秒 ($doubleClickTime ms)" 'DropDoubleClick' `
        (Get-ClickVerdict (20000 + $doubleClickTime - 1) 20000 10000 -1 $false $false $doubleClickTime)
    Check "间隔恰好达到阈值 ($doubleClickTime ms)" 'Toggle' `
        (Get-ClickVerdict (20000 + $doubleClickTime) 20000 10000 -1 $false $false $doubleClickTime)
}
Check '忙时挂起' 'Defer' (Get-ClickVerdict 21000 20000 10000 -1 $true $false 500)
Check '忙时双击第二下仍去重' 'DropDoubleClick' (Get-ClickVerdict 20100 20000 10000 -1 $true $false 500)
Check '忙段期间投递的点击补一次切换' 'StaleToggle' (Get-ClickVerdict 21000 20000 23000 -1 $false $false 500)
Check '挂起后又一个忙段点击也补' 'StaleToggle' (Get-ClickVerdict 22000 21000 23000 -1 $false $false 500)
Check '同一忙段只补一次' 'DropStale' (Get-ClickVerdict 22000 21000 23000 23000 $false $false 500)
Check '补切换后动作结束时刻前移仍算同段' 'DropStale' (Get-ClickVerdict 22000 21000 23500 23000 $false $false 500)
Check '新忙段再补一次' 'StaleToggle' (Get-ClickVerdict 24000 23000 25000 23000 $false $false 500)
Check '动作结束同刻算忙段投递' 'StaleToggle' (Get-ClickVerdict 23000 20000 23000 -1 $false $false 500)
Check '动作结束后的新单击' 'Toggle' (Get-ClickVerdict 23001 20000 23000 23000 $false $false 500)
Check '退出中丢弃' 'DropExiting' (Get-ClickVerdict 23001 20000 23000 -1 $false $true 500)
Check '退出中双击也丢弃' 'DropExiting' (Get-ClickVerdict 20100 20000 10000 -1 $false $true 500)
Check '签名回绕后的新单击' 'Toggle' (Get-ClickVerdict -2147483000 2147483000 2147483500 -1 $false $false 500)
Check '签名回绕后的双击第二下' 'DropDoubleClick' (Get-ClickVerdict -2147483600 2147483500 2147483500 -1 $false $false 500)
Check '回绕前投递但回绕后才处理' 'StaleToggle' (Get-ClickVerdict 2147483600 2147483000 -2147483000 -1 $false $false 500)
Check '跨零的新单击' 'Toggle' (Get-ClickVerdict 600 -100 -1 -1 $false $false 500)

# 忙段收尾与迟到请求共享裁决；Show 的覆盖必须有成功显示记录和当前窗口状态。
# 参数序：failed, exiting, pendingShow, pendingToggle, showOnly, showCovered。
Check '冷启动无窗口挂起 toggle 按 Show' 'Show' (Get-PendingAction $false $false $false $true $true $false)
Check '冷启动迟到 toggle 按 Show' 'Show' (Get-PendingAction $false $false $false $true $true $false)
Check '冷启动已显示不再补 toggle' 'Covered' (Get-PendingAction $false $false $false $true $true $true)
Check '普通忙段挂起 toggle 保持切换' 'Toggle' (Get-PendingAction $false $false $false $true $false $true)
Check '挂起 Show 优先于 toggle' 'Show' (Get-PendingAction $false $false $true $true $false $false)
Check '挂起 Show 已成功覆盖' 'Covered' (Get-PendingAction $false $false $true $true $false $true)
Check '失败后挂起 Show 不重试' 'DropFailed' (Get-PendingAction $true $false $true $false $false $false)
Check '失败后挂起 toggle 不重试' 'DropFailed' (Get-PendingAction $true $false $false $true $false $false)
Check '失败后两类挂起都不重试' 'DropFailed' (Get-PendingAction $true $false $true $true $true $true)
Check '失败后迟到 Show 不重试' 'DropFailed' (Get-PendingAction $true $false $true $false $true $false)
Check '失败后迟到 toggle 不重试' 'DropFailed' (Get-PendingAction $true $false $false $true $true $false)
Check '退出中挂起丢弃' 'DropExiting' (Get-PendingAction $false $true $true $true $true $false)
Check '无挂起请求无需补操作' 'None' (Get-PendingAction $false $false $false $false $true $false)
Check '消费挂起后同一忙段迟到点击丢弃' 'DropStale' (Get-ClickVerdict 22000 21000 23000 23000 $false $false 500)
Check '失败忙段已消费后迟到点击丢弃' 'DropStale' (Get-ClickVerdict 22000 21000 23000 23000 $false $false 500)
Check '失败后新点击仍可操作' 'Toggle' (Get-ClickVerdict 24000 21000 23000 23000 $false $false 500)

# 参数序：sent, showEnd, succeeded, alive, visible, iconic。
Check '成功显示且当前可见覆盖旧 Show' $true (Test-ShowCovered 21000 23000 $true $true $true $false)
Check '显示结束同刻的 Show 已覆盖' $true (Test-ShowCovered 23000 23000 $true $true $true $false)
Check '仅动作结束没有成功显示不能覆盖 Show' $false (Test-ShowCovered 21000 23000 $false $true $true $false)
Check '失败后窗口可见也不能覆盖 Show' $false (Test-ShowCovered 21000 23000 $false $true $true $false)
Check '成功显示后被隐藏不能覆盖 Show' $false (Test-ShowCovered 21000 23000 $true $true $false $false)
Check '成功显示后最小化不能覆盖 Show' $false (Test-ShowCovered 21000 23000 $true $true $true $true)
Check '成功显示后窗口消失不能覆盖 Show' $false (Test-ShowCovered 21000 23000 $true $false $true $false)
Check '显示结束后的新 Show 不去重' $false (Test-ShowCovered 23001 23000 $true $true $true $false)
Check '计时回绕旧 Show 已覆盖' $true (Test-ShowCovered 2147483600 -2147483000 $true $true $true $false)
Check '计时回绕新 Show 不去重' $false (Test-ShowCovered -2147483000 2147483500 $true $true $true $false)

Check '补操作忙中同一已消费忙段点击丢弃' 'DropStale' (Get-ClickVerdict 22000 21000 23000 23000 $true $false 500)
Check '补操作忙中新投递点击仍挂起' 'Defer' (Get-ClickVerdict 24000 21000 23000 23000 $true $false 500)

# 对真实收尾函数做最小接线检查：替换 Win32/开窗边界，不启动任何程序。
function Write-TrayLog([string]$Message) { }
function Test-CurrentShowCovered([long]$sent) { return $script:TestCovered }
function Open-Workbench { $script:TestOpenCount++ }
function Switch-Workbench { $script:TestToggleCount++ }
$script:Exiting = $false
$script:TestCovered = $false
$script:TestOpenCount = 0
$script:TestToggleCount = 0
$script:PendingShow = $false
$script:PendingToggle = $true
$script:ShowOnlyPending = $true
$script:LastClickTick = [long][Environment]::TickCount - 1000
Complete-Action $false
Check '收尾实际将冷启动 toggle 接到 Open' 1 $script:TestOpenCount
Check '收尾冷启动不调用 Switch' 0 $script:TestToggleCount
Check '收尾消费挂起时记录忙段' $script:LastActionEndTick $script:StaleEpisodeEnd
Check '收尾保存冷启动迟到裁决' $true $script:LastActionShowOnly
Check '收尾清空两类挂起' $false ($script:PendingShow -or $script:PendingToggle)
Check '收尾已消费忙段实际迟到点击丢弃' 'DropStale' `
    (Get-ClickVerdict $script:LastClickTick ($script:LastClickTick - 1000) `
        $script:LastActionEndTick $script:StaleEpisodeEnd $false $false 500)
$script:PendingShow = $true
$script:PendingShowTick = $script:LastClickTick
$script:PendingToggle = $true
$script:ShowOnlyPending = $false
Complete-Action $true
Check '失败收尾不再次调用 Open' 1 $script:TestOpenCount
Check '失败收尾不调用 Switch' 0 $script:TestToggleCount
Check '失败收尾清空两类挂起' $false ($script:PendingShow -or $script:PendingToggle)
Check '失败收尾保存失败状态供迟到请求裁决' $true $script:LastActionFailed
Check '失败收尾也记录已消费忙段' $script:LastActionEndTick $script:StaleEpisodeEnd
$script:PendingShow = $true
$script:ShowOnlyPending = $false
$script:TestCovered = $true
Complete-Action $false
Check '已覆盖的挂起 Show 不再次调用 Open' 1 $script:TestOpenCount
Check '已覆盖的挂起 Show 也消费忙段' $script:LastActionEndTick $script:StaleEpisodeEnd

if ($script:failed -gt 0) { throw "$script:failed / $script:checked 项未通过" }
Write-Host "全部通过：$script:checked 项；源文件和测试脚本解析无错误。"
