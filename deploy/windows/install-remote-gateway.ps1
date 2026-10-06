<#
.SYNOPSIS
    One-time phone-gateway setup in an elevated Windows PowerShell 5.1.
.NOTES
    The gateway starts when this Windows account signs in. proxy client also starts only after
    sign-in (HKCU Run), so a pre-sign-in gateway would have no proxy. No password is stored.
    Reading sources/config through a WSL UNC path may wake WSL during installation.
    The installed gateway stays idle until a phone request arrives. No Chrome window is opened.
#>
[CmdletBinding()]
param(
    [string]$Distro = 'ubuntu',
    [string]$LinuxUser = 'user',
    [string]$LinuxHome = '/home/user',
    [ValidateRange(1024, 65535)][int]$Port = 8794,
    [string]$TaskName = 'Workbench Remote Gateway'
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in an elevated Windows PowerShell as the Windows account that owns Ubuntu.'
}
foreach ($value in @($Distro, $LinuxUser)) {
    if ($value -notmatch '^[a-zA-Z0-9_.-]+$') { throw 'Invalid distro or Linux user.' }
}
if ($LinuxHome -notmatch '^/[a-zA-Z0-9_./=-]+$') { throw 'Invalid Linux home.' }
# Confirm this account has the distribution, without running wsl.exe.
$distributions = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath).DistributionName })
if ($distributions -notcontains $Distro) { throw "The current Windows account does not own WSL distro $Distro." }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    throw "Task '$TaskName' already exists; no settings were changed. Review it before updating."
}
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $tailscale)) { throw 'Tailscale CLI not found.' }
$remotePath = '\\wsl.localhost\' + $Distro + $LinuxHome.Replace('/', '\') + '\.workbench\remote.json'
$remote = Get-Content -LiteralPath $remotePath -Raw -Encoding UTF8 | ConvertFrom-Json
$remoteOrigin = [Uri]$remote.origin
if ($remoteOrigin.Scheme -ne 'https' -or $remoteOrigin.Host -notlike '*.ts.net' -or
    $remote.origin -ne $remoteOrigin.GetLeftPart([UriPartial]::Authority) -or
    @($remote.allowedLogins).Count -eq 0 -or [int]$remote.port -le 0 -or
    [int]$remote.port -gt 65535 -or [int]$remote.port -eq $Port) { throw 'Invalid existing remote.json.' }
# Fail early if the Windows gateway port is occupied. Binding loopback does not wake WSL.
$probe = New-Object Net.Sockets.TcpListener -ArgumentList @([Net.IPAddress]::Loopback, $Port)
try { $probe.Start() } finally { $probe.Stop() }
$installDir = Join-Path $env:LOCALAPPDATA 'workbench\remote-gateway'
$sources = @('wb-remote-gateway.cs', 'wb-remote-gateway.ps1')
foreach ($name in $sources) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) { throw "Missing source: $name" }
}
# Validate source and compiler before changing task or network configuration.
Add-Type -Path (Join-Path $PSScriptRoot 'wb-remote-gateway.cs')
$serveBefore = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read Tailscale Serve configuration.' }
$serveConfig = ($serveBefore -join "`n") | ConvertFrom-Json
$targetKey = $remoteOrigin.Host + ':443'
$target = $null
$rootHandler = $null
# A fresh machine has no Web map or HTTPS root (serve status returns {}).
if ($serveConfig.Web) { $target = $serveConfig.Web.PSObject.Properties[$targetKey] }
if ($target) {
    if ($target.Value.Handlers) { $rootHandler = $target.Value.Handlers.PSObject.Properties['/'] }
    if ($rootHandler -and $rootHandler.Value.Proxy -notin @('http://127.0.0.1:8792', "http://127.0.0.1:$($remote.port)")) {
        throw 'The existing HTTPS root is not the expected Workbench target; nothing was changed.'
    }
}
if ($serveConfig.AllowFunnel) {
    foreach ($entry in $serveConfig.AllowFunnel.PSObject.Properties) {
        if ($entry.Value) { throw 'Funnel is enabled. Review public access before installing this private gateway.' }
    }
}
Write-Host "Install loopback gateway 127.0.0.1:$Port -> Workbench port $($remote.port)"
Write-Host "Sign-in task '$TaskName' runs hidden as $($identity.Name) after sign-in."
Write-Host 'Change only the HTTPS / target; keep the phone URL.'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$backup = Join-Path $installDir ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
$serveBefore | Set-Content -LiteralPath (Join-Path $backup 'serve-before.json') -Encoding UTF8
@{ previousTarget = $(if ($rootHandler) { $rootHandler.Value.Proxy } else { $null }) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'rollback.json') -Encoding UTF8
foreach ($name in $sources) {
    $destination = Join-Path $installDir $name
    if (Test-Path -LiteralPath $destination) { Copy-Item -LiteralPath $destination -Destination $backup }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $destination -Force
}
$configPath = Join-Path $installDir 'remote-gateway.json'
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination $backup }
@{ distro = $Distro; linuxUser = $LinuxUser; linuxHome = $LinuxHome; port = $Port;
   backendPort = [int]$remote.port; origin = $remote.origin; allowedLogins = @($remote.allowedLogins) } |
    ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
# An interactive task would flash a console window. wscript runs PowerShell hidden and waits for it,
# so the task stays running and IgnoreNew/RestartCount still apply. Same launcher style as install-tray.ps1.
$vbs = @'
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
WScript.Quit sh.Run("""" & ps & """ -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & here & "\wb-remote-gateway.ps1""", 0, True)
'@
$launcher = Join-Path $installDir 'launcher.vbs'
if (Test-Path -LiteralPath $launcher) { Copy-Item -LiteralPath $launcher -Destination $backup }
Set-Content -LiteralPath $launcher -Value $vbs -Encoding ASCII
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $launcher + '"') -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
$saved = Get-ScheduledTask -TaskName $TaskName
if ($saved.Principal.LogonType -ne 'Interactive' -or $saved.Actions.Execute -ne $wscript) {
    throw 'Scheduled task read-back mismatch; Tailscale was not changed.'
}
Start-ScheduledTask -TaskName $TaskName
# Wait only for the gateway socket, never contact it or wake WSL during setup.
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $Port -ErrorAction SilentlyContinue) {
        $ready = $true; break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw "Gateway did not listen. Tailscale unchanged. Check $installDir\remote-gateway.log and Task Scheduler." }
& $tailscale serve --bg --yes --https=443 --set-path=/ "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { throw "Serve update failed; backup at $backup" }
$after = (& $tailscale serve status --json) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Serve read-back failed.' }
$readBack = $after | ConvertFrom-Json
if ($readBack.Web.PSObject.Properties[$targetKey].Value.Handlers.PSObject.Properties['/'].Value.Proxy -ne "http://127.0.0.1:$Port") {
    throw 'Serve target read-back mismatch.'
}
Write-Host "Installed. Phone URL: $($remote.origin)"
Write-Host "Backup: $backup"
Write-Host 'Final check: restart Windows, sign in, do not open Workbench, then open the URL on your phone.'
