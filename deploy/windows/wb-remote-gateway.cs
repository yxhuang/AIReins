using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// TCP relay: preserve Tailscale identity, HTTP bodies and WebSocket frames.
// No WSL process or backend probe runs until an authorized HTTP request arrives.
public sealed class WbRemoteGateway
{
    readonly TcpListener listener;
    readonly int backendPort;
    readonly string origin;
    readonly HashSet<string> logins;
    readonly Func<Task> startBackend;
    readonly Action<string> log;
    readonly int responseWaitMs;
    readonly object startupLock = new object();
    readonly SemaphoreSlim slots = new SemaphoreSlim(128);
    Task startup;
    DateTime retryAfter;

    public WbRemoteGateway(int port, int backendPort, string origin, string[] logins,
                          Func<Task> startBackend, Action<string> log, int responseWaitMs)
    {
        listener = new TcpListener(IPAddress.Loopback, port);
        this.backendPort = backendPort;
        this.origin = origin;
        this.logins = new HashSet<string>(logins, StringComparer.Ordinal);
        this.startBackend = startBackend;
        this.log = log;
        this.responseWaitMs = responseWaitMs;
    }

    public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }

    static void Observe(Task task)
    {
        task.ContinueWith(t => { var ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
    }

    public async Task Run(CancellationToken stop)
    {
        listener.Start();
        log("listening on 127.0.0.1:" + Port + "; WSL starts on request");
        using (stop.Register(() => listener.Stop()))
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await listener.AcceptTcpClientAsync().ConfigureAwait(false); }
                catch (Exception) { if (stop.IsCancellationRequested) break; throw; }
                if (!slots.Wait(0)) { client.Close(); continue; }
                // Handle catches connection errors; the continuation only releases capacity.
                Observe(Handle(client, stop).ContinueWith(t => { slots.Release(); }, TaskScheduler.Default));
            }
        }
    }

    async Task<TcpClient> Connect()
    {
        var client = new TcpClient();
        try
        {
            Task connecting = client.ConnectAsync(IPAddress.Loopback, backendPort);
            if (await Task.WhenAny(connecting, Task.Delay(500)).ConfigureAwait(false) != connecting)
            {
                // Observe any eventual failure after disposing the timed-out socket.
                Observe(connecting);
                client.Close(); return null;
            }
            await connecting.ConfigureAwait(false);
            return client;
        }
        catch (SocketException) { client.Close(); return null; }
        catch { client.Close(); throw; }
    }

    Task EnsureStarted()
    {
        lock (startupLock)
        {
            if (startup != null && (!startup.IsCompleted || DateTime.UtcNow < retryAfter))
                return startup;
            startup = Task.Run(async () =>
            {
                log("starting WSL and Workbench");
                try
                {
                    await startBackend().ConfigureAwait(false);
                    for (int i = 0; i < 80; i++)
                    {
                        using (var probe = await Connect().ConfigureAwait(false))
                            if (probe != null) { log("Workbench ready"); return; }
                        await Task.Delay(250).ConfigureAwait(false);
                    }
                    throw new IOException("Workbench remote port did not become ready");
                }
                catch (Exception error)
                {
                    lock (startupLock) { retryAfter = DateTime.UtcNow.AddSeconds(30); }
                    log("startup failed: " + error.Message);
                    throw;
                }
            });
            Observe(startup);
            return startup;
        }
    }

    // Read only the first header block; bytes read beyond it remain in the buffer.
    static async Task<byte[]> Header(NetworkStream stream)
    {
        using (var bytes = new MemoryStream())
        {
            var chunk = new byte[4096];
            while (bytes.Length < 32768)
            {
                int n = await stream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false);
                if (n == 0) throw new IOException("incomplete HTTP header");
                long previous = bytes.Length;
                bytes.Write(chunk, 0, n);
                byte[] data = bytes.GetBuffer();
                for (int i = (int)Math.Max(0, previous - 3); i + 3 < bytes.Length; i++)
                    if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10)
                        return bytes.ToArray();
            }
            throw new IOException("HTTP header too large");
        }
    }

    bool Authorized(byte[] bytes)
    {
        string head = Encoding.ASCII.GetString(bytes);
        head = head.Substring(0, head.IndexOf("\r\n\r\n", StringComparison.Ordinal));
        string[] lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] request = lines[0].Split(' ');
        if (request.Length != 3 || request[2] != "HTTP/1.1") return false;
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon <= 0 || Char.IsWhiteSpace(lines[i][0])) return false;
            string key = lines[i].Substring(0, colon);
            // Never accept duplicate security headers. Other repeated headers are relayed intact.
            if (headers.ContainsKey(key) && (key.Equals("Host", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Origin", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Tailscale-User-Login", StringComparison.OrdinalIgnoreCase))) return false;
            headers[key] = lines[i].Substring(colon + 1).Trim();
        }
        string host, login, requestOrigin;
        if (!headers.TryGetValue("Host", out host) ||
            !host.Equals(new Uri(origin).Authority, StringComparison.OrdinalIgnoreCase) ||
            !headers.TryGetValue("Tailscale-User-Login", out login) || !logins.Contains(login)) return false;
        bool mutating = (request[0] != "GET" && request[0] != "HEAD") || headers.ContainsKey("Upgrade");
        return !mutating || (headers.TryGetValue("Origin", out requestOrigin) && requestOrigin == origin);
    }

    static async Task Reply(NetworkStream stream, int status, bool waiting)
    {
        string body = status == 403 ? "Forbidden: use your authorized Tailscale device." :
            "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            (waiting ? "<meta http-equiv=\"refresh\" content=\"5\">" : "") +
            "<title>Workbench</title><body style=\"font:18px system-ui;padding:32px\">" +
            (waiting ? "正在启动 Workbench，请稍候。页面会自动重试。" :
                "Workbench 启动失败。请稍后刷新；持续失败时检查电脑上的 remote-gateway.log。") +
            "<p><a href=\"\">刷新页面</a></p></body></html>";
        byte[] content = Encoding.UTF8.GetBytes(body);
        string header = "HTTP/1.1 " + status + (status == 403 ? " Forbidden" : " Service Unavailable") +
            "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n" +
            "Retry-After: 5\r\nConnection: close\r\nContent-Length: " + content.Length + "\r\n\r\n";
        byte[] prefix = Encoding.ASCII.GetBytes(header);
        await stream.WriteAsync(prefix, 0, prefix.Length).ConfigureAwait(false);
        await stream.WriteAsync(content, 0, content.Length).ConfigureAwait(false);
    }

    static async Task Pipe(NetworkStream input, NetworkStream output, TcpClient from, TcpClient to)
    {
        try
        {
            await input.CopyToAsync(output).ConfigureAwait(false);
            try { to.Client.Shutdown(SocketShutdown.Send); } catch (SocketException) { }
        }
        catch { from.Close(); to.Close(); throw; }
    }

    async Task Handle(TcpClient down, CancellationToken stop)
    {
        using (down)
        using (stop.Register(() => down.Close()))
        {
            try
            {
                NetworkStream stream = down.GetStream();
                Task<byte[]> reading = Header(stream);
                if (await Task.WhenAny(reading, Task.Delay(5000)).ConfigureAwait(false) != reading)
                {
                    Observe(reading);
                    return;
                }
                byte[] initial = await reading.ConfigureAwait(false);
                if (!Authorized(initial)) { await Reply(stream, 403, false).ConfigureAwait(false); return; }
                TcpClient up = await Connect().ConfigureAwait(false);
                if (up == null)
                {
                    Task boot = EnsureStarted();
                    await Task.WhenAny(boot, Task.Delay(responseWaitMs)).ConfigureAwait(false);
                    up = await Connect().ConfigureAwait(false);
                    if (up == null)
                    { await Reply(stream, 503, !boot.IsCompleted).ConfigureAwait(false); return; }
                }
                using (up)
                using (stop.Register(() => up.Close()))
                {
                    // Cache both streams before either direction half-closes a socket.
                    // TcpClient.GetStream() can reject a socket after Shutdown(Send).
                    NetworkStream upstream = up.GetStream();
                    await upstream.WriteAsync(initial, 0, initial.Length).ConfigureAwait(false);
                    await Task.WhenAll(Pipe(stream, upstream, down, up), Pipe(upstream, stream, up, down)).ConfigureAwait(false);
                }
            }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            catch (Exception error) { log("connection failed: " + error.Message); }
        }
    }

    public static Func<Task> WslStarter(string executable, string arguments, Action<string> log)
    {
        return () => Task.Run(() =>
        {
            var info = new ProcessStartInfo(executable, arguments) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(info))
            {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(90000))
                {
                    process.Kill(); process.WaitForExit(2000);
                    throw new TimeoutException("WSL command exceeded 90 seconds");
                }
                Task.WaitAll(output, error);
                if (process.ExitCode != 0)
                    throw new IOException("WSL exit " + process.ExitCode + ": " + error.Result.Trim() + " " + output.Result.Trim());
            }
        });
    }

    // Logging stays in C#: worker threads must never call a PowerShell scriptblock.
    public static Action<string> FileLogger(string path)
    {
        object sync = new object();
        return message => {
            lock (sync)
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine;
                if (File.Exists(path) && new FileInfo(path).Length > 1048576)
                    File.WriteAllText(path, line, Encoding.UTF8);
                else File.AppendAllText(path, line, Encoding.UTF8);
            }
        };
    }
}
