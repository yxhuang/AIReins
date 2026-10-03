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
foreach ($name in @('Get-ClickAction', 'Get-ShowAction', 'Get-TickElapsed', 'Get-ClickVerdict')) {
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

if ($script:failed -gt 0) { throw "$script:failed / $script:checked 项未通过" }
Write-Host "全部通过：$script:checked 项；源文件和测试脚本解析无错误。"
