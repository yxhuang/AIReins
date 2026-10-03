# Windows PowerShell 5.1. Runs as the WSL owner's noninteractive scheduled task.
[CmdletBinding()]
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
# 5.1 leaves $PSScriptRoot empty inside param defaults under -File, so resolve it here.
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'remote-gateway.json' }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($value in @($config.distro, $config.linuxUser)) {
    if ($value -notmatch '^[a-zA-Z0-9_.-]+$') { throw 'Invalid distro or Linux user.' }
}
if ($config.linuxHome -notmatch '^/[a-zA-Z0-9_./=-]+$') { throw 'Invalid Linux home.' }
Add-Type -Path (Join-Path $PSScriptRoot 'wb-remote-gateway.cs')
$log = [WbRemoteGateway]::FileLogger((Join-Path $PSScriptRoot 'remote-gateway.log'))
# Same lock/scope as the existing Linux socket entry; only this request launches WSL.
$command = 'flock -o /run/user/$(id -u)/wb-remote.lock systemd-run --user --scope -q /bin/bash -lc ''WORKBENCH_NO_OPEN=1 ' + $config.linuxHome + '/.local/bin/wb start'''
$arguments = '-d ' + $config.distro + ' -u ' + $config.linuxUser + ' -e /bin/bash -lc "' + $command + '"'
$starter = [WbRemoteGateway]::WslStarter((Join-Path $env:SystemRoot 'System32\wsl.exe'), $arguments, $log)
$gateway = [WbRemoteGateway]::new(
    [int]$config.port, [int]$config.backendPort, [string]$config.origin,
    [string[]]@($config.allowedLogins), $starter, $log, 8000
)
try { $gateway.Run([Threading.CancellationToken]::None).GetAwaiter().GetResult() }
catch { $log.Invoke($_.Exception.ToString()); throw }
