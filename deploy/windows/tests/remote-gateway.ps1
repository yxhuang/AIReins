# Compile and test with loopback mock servers. Never runs WSL, Chrome or Tailscale.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$root = Split-Path -Parent $PSScriptRoot
foreach ($name in @('wb-remote-gateway.ps1', 'install-remote-gateway.ps1')) {
    $tokens = $null; $errors = $null
    [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $name), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw ($errors | Out-String) }
}
Add-Type -Path @((Join-Path $root 'wb-remote-gateway.cs'), (Join-Path $PSScriptRoot 'remote-gateway.tests.cs'))
$tests = [WbRemoteGatewayTests]::Run()
try {
    if (-not $tests.Wait(30000)) { throw 'Gateway tests exceeded 30 seconds.' }
    $tests.GetAwaiter().GetResult()
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    if ($tests.Exception) { [Console]::Error.WriteLine($tests.Exception.Flatten().ToString()) }
    exit 1
}
