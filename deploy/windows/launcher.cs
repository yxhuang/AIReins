// Compiled together with the tray's native types during installation.
namespace AIReinsLauncher {
    using System;
    using System.Diagnostics;
    using System.Globalization;
    using System.IO;
    using System.Threading;

    internal interface ILauncherRuntime {
        bool AcquireOwner(int milliseconds);
        void ReleaseOwner();
        bool ForwardShow();
        void StartTray();
        void Log(string message);
    }

    internal static class Launcher {
        internal static int Run(ILauncherRuntime runtime) {
            if (runtime.AcquireOwner(0)) {
                runtime.ReleaseOwner(); // The PowerShell owner must acquire this mutex itself.
                runtime.StartTray();
                return 0;
            }
            bool forwarded = runtime.ForwardShow();
            runtime.Log("launcher: forwarded=" + forwarded);
            // Preserve takeover when an owner is already exiting. This wait consumes no UI thread
            // and does not delay the window: the resident tray handles the posted request immediately.
            if (runtime.AcquireOwner(35000)) {
                runtime.ReleaseOwner();
                runtime.StartTray();
                return 0;
            }
            return forwarded ? 0 : 1;
        }
    }

    internal sealed class WindowsRuntime : ILauncherRuntime, IDisposable {
        internal const string Distro = "__AIREINS_DISTRO__";
        internal const string WbPath = "__AIREINS_WB_PATH__";
        internal const int Port = __AIREINS_PORT__;
        private readonly string directory = AppDomain.CurrentDomain.BaseDirectory;
        private readonly Mutex owner = new Mutex(false, "Local\\Workbench.Tray." + Distro + "." + Port);

        public bool AcquireOwner(int milliseconds) {
            try { return owner.WaitOne(milliseconds); }
            catch (AbandonedMutexException) { return true; }
        }
        public void ReleaseOwner() { owner.ReleaseMutex(); }
        public bool ForwardShow() {
            IntPtr target = WbNative.FindWindowEx(new IntPtr(-3), IntPtr.Zero, null,
                "Workbench.Tray.Show." + Distro + "." + Port);
            if (target == IntPtr.Zero) return false;
            WbNative.AllowSetForegroundWindow(-1);
            return WbNative.PostMessage(target, WbNative.WM_APP_SHOW, IntPtr.Zero, IntPtr.Zero);
        }
        public void StartTray() {
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            string assembly = Path.GetFileName(typeof(WindowsRuntime).Assembly.Location);
            var info = new ProcessStartInfo(powershell,
                "-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File \"" +
                Path.Combine(directory, "wb-tray.ps1") + "\" -Distro " + Distro + " -Port " + Port +
                " -WbPath " + WbPath + " -NativeAssembly \"" + assembly + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.WorkingDirectory = directory;
            Log("launcher: start tray");
            using (var process = Process.Start(info)) {
                if (process == null) throw new InvalidOperationException("Could not start the AIReins tray.");
            }
        }
        public void Log(string message) {
            try {
                string path = Path.Combine(directory, "tray.log");
                FileMode mode = File.Exists(path) && new FileInfo(path).Length > 1048576 ? FileMode.Create : FileMode.Append;
                using (var stream = new FileStream(path, mode, FileAccess.Write, FileShare.ReadWrite))
                using (var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false))) {
                    writer.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) +
                        " [" + Process.GetCurrentProcess().Id + "] " + message);
                }
            } catch { /* Logging must not block opening the application. */ }
        }
        public void Dispose() { owner.Dispose(); }
    }

    internal static class Program {
        [STAThread]
        private static int Main() {
            try {
                using (var runtime = new WindowsRuntime()) {
                    runtime.Log("launcher: start");
                    if (Launcher.Run(runtime) == 0) return 0;
                    runtime.Log("launcher: no listener and takeover timed out");
                    throw new InvalidOperationException("Could not contact or take over the AIReins tray. Try again later.");
                }
            } catch (Exception error) {
                System.Windows.Forms.MessageBox.Show(error.Message, "AIReins",
                    System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
