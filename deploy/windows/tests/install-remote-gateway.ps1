# Windows PowerShell 5.1: simulate installer Serve preflight and rollback snapshot.
# Never invokes Tailscale, WSL, UAC or Task Scheduler. Leaves one temp directory for inspection.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-remote-gateway.ps1'
$tokens = $null; $errors = $null
[Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $installer -Raw -Encoding UTF8
$start = $source.IndexOf('$serveBefore = & $tailscale serve status --json')
$end = $source.IndexOf('Write-Host (T "安装 loopback 网关', $start)
$preflight = [scriptblock]::Create($source.Substring($start, $end - $start))
$start = $source.IndexOf('$serveBefore | Set-Content')
$end = $source.IndexOf('foreach ($name in $sources)', $start)
$snapshot = [scriptblock]::Create($source.Substring($start, $end - $start))
# The extracted blocks call the installer's T helper; English keeps rejection paths on the real throws.
function T([string]$Zh, [string]$En) { $En }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('wb-remote-install-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null

function Test-Serve {
    param([string]$Json, $ExpectedTarget, [bool]$Reject = $false)
    $remote = @{ port = 8793 }
    $remoteOrigin = [Uri]'https://new-pc.tail123.ts.net'
    # Deliberately seed a stale variable to detect missing initialization on fresh installs.
    $rootHandler = @{ Value = @{ Proxy = 'stale-target' } }
    $tailscale = { $global:LASTEXITCODE = 0; $Json }
    $rejected = $false
    try { . $preflight } catch { $rejected = $true }
    if ($rejected -ne $Reject) { throw "Unexpected Serve preflight result for $Json" }
    if ($Reject) { return }
    $backup = Join-Path $temp ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $backup | Out-Null
    . $snapshot
    $rollback = Get-Content -LiteralPath (Join-Path $backup 'rollback.json') -Raw | ConvertFrom-Json
    if ($rollback.previousTarget -ne $ExpectedTarget) { throw 'Wrong rollback previousTarget.' }
    if (($null -eq $ExpectedTarget) -and ($null -ne $rollback.previousTarget)) { throw 'Fresh rollback target must be JSON null.' }
    $saved = Get-Content -LiteralPath (Join-Path $backup 'serve-before.json') -Raw | ConvertFrom-Json
    if (($saved | ConvertTo-Json -Depth 20 -Compress) -ne (($Json | ConvertFrom-Json) | ConvertTo-Json -Depth 20 -Compress)) {
        throw 'Serve snapshot mismatch.'
    }
}

Test-Serve '{}' $null
Test-Serve '{"Web":{}}' $null
Test-Serve '{"Web":{"new-pc.tail123.ts.net:443":{"Handlers":{"/other":{"Proxy":"http://127.0.0.1:9000"}}}}}' $null
Test-Serve '{"Web":{"new-pc.tail123.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8792"}}}}}' 'http://127.0.0.1:8792'
Test-Serve '{"Web":{"new-pc.tail123.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8793"}}}}}' 'http://127.0.0.1:8793'
Test-Serve '{"Web":{"new-pc.tail123.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}' $null $true
Test-Serve '{"AllowFunnel":{"new-pc.tail123.ts.net:443":true}}' $null $true
Write-Host "PASS: 7 Serve preflight/rollback simulations. Temp snapshots: $temp"
