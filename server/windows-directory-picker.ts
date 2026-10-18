import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { powershellCandidates, windowsPickerAvailable } from "./platform.js";
import { promisify } from "node:util";
import { listDirectories } from "./dir-list.js";

const POWERSHELL = powershellCandidates[0]!;
const execute = promisify(execFile);
let active = false;

export class WindowsPickerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function windowsPickerEnabled(local: boolean): boolean {
  return windowsPickerAvailable(local);
}

/** 盘符路径通过环境变量传入，不拼入 PowerShell 源码。 */
export function pickerStartPath(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f]/.test(value)) {
    throw new WindowsPickerError(400, "目录路径必须是不含控制字符的字符串");
  }
  const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(value);
  if (mount) return `${mount[1].toUpperCase()}:\\${(mount[2] ?? "").replaceAll("/", "\\")}`;
  if (/^[a-z]:[\\/]/i.test(value)) return value.replaceAll("/", "\\");
  // Linux 工作目录不作为 Windows 窗口起点，改用 Windows 用户目录。
  if (value.startsWith("/")) return "";
  throw new WindowsPickerError(400, "请选择 Windows 盘符目录或 Linux 绝对路径");
}

export const PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
# pwsh.exe 未声明 DPI 感知，系统会把窗口按位图放大而发虚；必须在创建任何窗口前设定。
[System.Windows.Forms.Application]::EnableVisualStyles()
[void][System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2)
# .NET 委托直接在计时线程退出，不调用 PowerShell runspace，也不逐次加载 C# 编译器。
$exitMethod = [System.Environment].GetMethod('Exit', [type[]]@([int]))
$exitBody = [System.Linq.Expressions.Expression]::Call($exitMethod, [System.Linq.Expressions.Expression[]]@([System.Linq.Expressions.Expression]::Constant(3)))
$timerState = [System.Linq.Expressions.Expression]::Parameter([object], 'state')
$exitCallback = [System.Linq.Expressions.Expression]::Lambda([System.Threading.TimerCallback], $exitBody, [System.Linq.Expressions.ParameterExpression[]]@($timerState)).Compile()
$deadline = [System.Threading.Timer]::new($exitCallback, $null, 120000, [System.Threading.Timeout]::Infinite)
$fileMode = $env:WORKBENCH_PICKER_MODE -eq 'file'
$dialog = if ($fileMode) { [System.Windows.Forms.OpenFileDialog]::new() } else { [System.Windows.Forms.FolderBrowserDialog]::new() }
$owner = [System.Windows.Forms.Form]::new()
try {
  $start = $env:WORKBENCH_PICKER_START
  if (-not $start -or -not [System.IO.Directory]::Exists($start)) { $start = $env:USERPROFILE }
  if ($fileMode) {
    $dialog.InitialDirectory = $start
    $dialog.Title = 'AIReins - Select file'
    $dialog.Filter = 'All files (*.*)|*.*'
    $dialog.Multiselect = $false
    $dialog.CheckFileExists = $true
    $dialog.RestoreDirectory = $true
  } else {
    $dialog.AutoUpgradeEnabled = $true
    $dialog.Description = 'AIReins - Select working directory'
    $dialog.UseDescriptionForTitle = $true
    $dialog.ShowNewFolderButton = $false
    $dialog.SelectedPath = $start
  }
  $owner.ShowInTaskbar = $false
  # 先创建显示透明 owner，再应用 TopMost：在 Handle 创建前赋值没有把原生窗口置顶。
  $owner.Opacity = 0
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Show()
  # 从 WSL 启动的后台进程无权抢前台，Activate 只会让任务栏一直闪；临时挂到前台窗口的输入队列通常可以激活。尽力而为，失败仍照常弹窗。
  try {
    # Reflection.Emit 声明 P/Invoke，避免 Add-Type 编译 C# 的启动开销。
    $nativeType = [System.Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([System.Reflection.AssemblyName]::new('AIReinsPicker'), 'Run').DefineDynamicModule('AIReinsPicker').DefineType('Native', 'Public, Class')
    foreach ($m in @(
      @('user32.dll', 'GetForegroundWindow', [IntPtr], @()),
      @('user32.dll', 'GetWindowThreadProcessId', [uint32], @([IntPtr], [IntPtr])),
      @('user32.dll', 'AttachThreadInput', [bool], @([uint32], [uint32], [bool])),
      @('user32.dll', 'SetForegroundWindow', [bool], @([IntPtr])),
      @('kernel32.dll', 'GetCurrentThreadId', [uint32], @())
    )) {
      $method = $nativeType.DefinePInvokeMethod($m[1], $m[0], 'Public, Static, PinvokeImpl', 'Standard', $m[2], [type[]]$m[3], 'Winapi', 'Auto')
      # 不加 PreserveSig 时返回值按 HRESULT 处理。
      $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
    }
    $native = $nativeType.CreateType()
    $foreground = $native::GetWindowThreadProcessId($native::GetForegroundWindow(), [IntPtr]::Zero)
    $current = $native::GetCurrentThreadId()
    $attached = $foreground -ne 0 -and $foreground -ne $current -and $native::AttachThreadInput($current, $foreground, $true)
    try { [void]$native::SetForegroundWindow($owner.Handle) }
    finally { if ($attached) { [void]$native::AttachThreadInput($current, $foreground, $false) } }
  } catch { [Console]::Error.WriteLine("foreground: $_") }
  $owner.TopMost = $true
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $chosen = if ($fileMode) { $dialog.FileName } else { $dialog.SelectedPath }
    @{ path = $chosen } | ConvertTo-Json -Compress
  } else { @{ path = $null } | ConvertTo-Json -Compress }
} finally { $deadline.Dispose(); $dialog.Dispose(); $owner.Dispose() }
`;

async function runPicker(start: string, mode: "dir" | "file"): Promise<string> {
  try {
    const { stdout } = await execute(POWERSHELL, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(PICKER_SCRIPT, "utf16le").toString("base64")], {
      cwd: "/mnt/c", timeout: 130_000, maxBuffer: 64 * 1024,
      env: { ...process.env, WORKBENCH_PICKER_START: start, WORKBENCH_PICKER_MODE: mode, WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ""}WORKBENCH_PICKER_START:WORKBENCH_PICKER_MODE` },
    });
    return stdout;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    throw new WindowsPickerError(503, code === 3 ? "Windows 选择窗口已超时关闭，请重试" : "无法打开 Windows 选择窗口，请使用网页浏览或粘贴路径");
  }
}

/** 全局单窗口；取消不改变 cwd，成功结果检查文件或目录。run 可注入无 Windows 的回归夹具。 */
async function pickWindowsPath(initialPath: unknown, mode: "dir" | "file", run = (start: string) => runPicker(start, mode)): Promise<{ path: string | null }> {
  const start = pickerStartPath(initialPath);
  if (active) throw new WindowsPickerError(409, "已有 Windows 选择窗口，请先完成或取消选择");
  active = true;
  try {
    let result: unknown;
    try { result = JSON.parse((await run(start)).trim()); }
    catch (cause) {
      if (cause instanceof WindowsPickerError) throw cause;
      throw new WindowsPickerError(503, "Windows 选择窗口返回无效结果");
    }
    if (!result || typeof result !== "object" || !("path" in result)) throw new WindowsPickerError(503, "Windows 选择窗口返回无效结果");
    const path = (result as { path: unknown }).path;
    if (path === null) return { path: null };
    if (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path) || /[\x00-\x1f]/.test(path)) {
      throw new WindowsPickerError(400, mode === "file" ? "请选择 Windows 盘符下的文件" : "请选择 Windows 盘符下的文件夹");
    }
    const mapped = `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
    if (mode === "file") {
      try {
        if (!(await stat(mapped)).isFile()) throw new WindowsPickerError(400, "请选择普通文件");
      } catch (error) {
        if (error instanceof WindowsPickerError) throw error;
        throw new WindowsPickerError(400, "所选文件不存在或无法读取");
      }
      return { path: mapped };
    }
    return { path: (await listDirectories(mapped)).path };
  } finally { active = false; }
}

export function pickWindowsDirectory(initialPath: unknown, run?: (start: string) => Promise<string>): Promise<{ path: string | null }> {
  return pickWindowsPath(initialPath, "dir", run);
}
export function pickWindowsFile(initialPath: unknown, run?: (start: string) => Promise<string>): Promise<{ path: string | null }> {
  return pickWindowsPath(initialPath, "file", run);
}
