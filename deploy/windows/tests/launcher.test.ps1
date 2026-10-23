<# Compiles the actual launcher and tests ownership/forwarding without starting the tray or Chrome. #>
$ErrorActionPreference = 'Stop'
$windows = Split-Path -Parent $PSScriptRoot
foreach ($name in @('wb-tray.ps1', 'install-tray.ps1', 'tests\tray-startup.ps1', 'tests\tray-click-filter.ps1')) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $windows $name), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}
$native = [regex]::Match([IO.File]::ReadAllText((Join-Path $windows 'wb-tray.ps1')), "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $native.Success) { throw 'Native tray types not found' }
$launcher = [IO.File]::ReadAllText((Join-Path $windows 'launcher.cs'))
$launcher = $launcher.Replace('__AIREINS_DISTRO__', 'ubuntu').Replace('__AIREINS_WB_PATH__', '~/.local/bin/aireins').Replace('__AIREINS_PORT__', '8790')
$tests = @'
namespace AIReinsLauncher {
    using System;
    using System.Collections.Generic;
    internal sealed class Fixture : ILauncherRuntime {
        internal Queue<bool> Owners = new Queue<bool>();
        internal List<int> Waits = new List<int>();
        internal bool Forwarded;
        internal bool FailStart;
        internal int Starts, Releases, Forwards;
        public bool AcquireOwner(int ms) { Waits.Add(ms); return Owners.Dequeue(); }
        public void ReleaseOwner() { Releases++; }
        public bool ForwardShow() { Forwards++; return Forwarded; }
        public void StartTray() { Starts++; if (FailStart) throw new InvalidOperationException("fixture"); }
        public void Log(string message) { }
    }
    public static class LauncherChecks {
        private static void Check(bool value, string name) { if (!value) throw new Exception(name); }
        public static void Run() {
            var fresh = new Fixture(); fresh.Owners.Enqueue(true);
            Check(Launcher.Run(fresh) == 0 && fresh.Starts == 1 && fresh.Releases == 1 && fresh.Forwards == 0,
                "No owner: release lock before starting tray");
            var warm = new Fixture { Forwarded = true };
            warm.Owners.Enqueue(false); warm.Owners.Enqueue(false);
            Check(Launcher.Run(warm) == 0 && warm.Starts == 0 && warm.Forwards == 1 && warm.Releases == 0,
                "Warm: forward without starting PowerShell");
            Check(warm.Waits.Count == 2 && warm.Waits[0] == 0 && warm.Waits[1] == 35000, "Bounded takeover wait");
            foreach (bool forwarded in new[] { true, false }) {
                var takeover = new Fixture { Forwarded = forwarded };
                takeover.Owners.Enqueue(false); takeover.Owners.Enqueue(true);
                Check(Launcher.Run(takeover) == 0 && takeover.Starts == 1 && takeover.Releases == 1,
                    "Owner exits: take over even if message was posted");
            }
            var failed = new Fixture(); failed.Owners.Enqueue(false); failed.Owners.Enqueue(false);
            Check(Launcher.Run(failed) == 1 && failed.Starts == 0, "Missing listener and held lock: report failure");
            var brokenStart = new Fixture { FailStart = true }; brokenStart.Owners.Enqueue(true);
            try { Launcher.Run(brokenStart); throw new Exception("Expected startup failure"); }
            catch (InvalidOperationException) { Check(brokenStart.Releases == 1, "Startup failure leaves no held lock"); }
        }
    }
}
'@
Add-Type -TypeDefinition ($native.Groups[1].Value + "`n" + $launcher + "`n" + $tests) -ReferencedAssemblies @('System', 'System.Core', 'System.Windows.Forms')
[AIReinsLauncher.LauncherChecks]::Run()
Write-Host 'PASS: PowerShell syntax, actual C# launcher compilation, warm forwarding, startup, takeover and failure paths'
