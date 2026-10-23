<#
.SYNOPSIS
    Exercise the actual tray startup functions with API, WSL and UI boundaries stubbed.
    Does not start Windows programs, WinForms, WSL, Chrome or a real service.
#>
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'wb-tray.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Ensure-Service', 'Open-Workbench', 'Close-StartupWindow')) {
    $functions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($functions.Count -ne 1) { throw "Expected one $name" }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}

# Open-Workbench only needs these static calls in the failure path.
class WbNative {
    static [IntPtr[]] Windows() { return @() }
}
function Write-TrayLog([string]$message) { }
function Test-Service { $script:steps.Add('check'); return $script:ready }
function Show-StartupWindow { $script:steps.Add('splash') }
function Invoke-Wsl([string]$command) {
    $script:steps.Add('wsl')
    if ($script:failStart) { throw 'synthetic startup failure' }
}
function Get-WbApi([string]$path, [int]$timeout) { $script:steps.Add('api'); return @{ code = 0 } }
function Show-Failure([string]$message) {
    if ($script:StartupWindow) { throw 'Splash must be disposed before failure notification' }
    $script:steps.Add('failure')
}
function Complete-Action([bool]$failed) {
    if (-not $failed) { throw 'Failure must reach pending-click cleanup' }
    $script:steps.Add('complete')
}
function T([string]$zh, [string]$en) { return $en }
function Check([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }

$script:steps = New-Object 'System.Collections.Generic.List[string]'
$script:Tray = New-Object PSObject
$script:Tray | Add-Member ScriptMethod ShowBalloonTip { throw 'Startup must not submit a Windows notification' }
$script:ready = $true
$script:failStart = $false
Ensure-Service
Check (($script:steps -join ',') -eq 'check') 'Healthy service must skip splash and WSL'

$script:steps.Clear()
$script:ready = $false
Ensure-Service
Check (($script:steps -join ',') -eq 'check,splash,wsl,api') 'Cold start must show splash before WSL and wait for readiness'

$script:disposed = 0
$script:StartupWindow = New-Object PSObject
$script:StartupWindow | Add-Member ScriptMethod Dispose { $script:disposed++ }
$script:StartupTitleFont = New-Object PSObject
$script:StartupTitleFont | Add-Member ScriptMethod Dispose { $script:disposed++ }
$script:steps.Clear()
$script:failStart = $true
$script:Busy = $false
$script:Exiting = $false
$script:OpenMutex = New-Object PSObject
$script:OpenMutex | Add-Member ScriptMethod WaitOne { param($timeout); return $true }
$script:OpenMutex | Add-Member ScriptMethod ReleaseMutex { $script:steps.Add('unlock') }
Open-Workbench
Check (($script:steps -join ',') -eq 'check,splash,wsl,failure,unlock,complete') 'Failed startup must release the lock and pending requests'
Check ($script:disposed -eq 2) 'Splash and its font must each be disposed once'
Check ($null -eq $script:StartupWindow -and $null -eq $script:StartupTitleFont) 'Startup UI references must be cleared'
Check (-not $script:Busy) 'Failed startup must release Busy'
Close-StartupWindow
Check ($script:disposed -eq 2) 'Repeated cleanup must be harmless'
Write-Host 'PASS: warm start, cold start order, startup failure, lock/Busy cleanup and UI disposal'
