using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class WbRemoteGatewayTests
{
    const string Origin = "https://test.example.ts.net";
    const string Login = "tester@example.com";
    static void Assert(bool condition, string message)
    { if (!condition) throw new Exception(message); }
    static void Observe(Task task)
    { task.ContinueWith(t => { var ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted); }

    static string Request(string extra)
    { return "GET / HTTP/1.1\r\nHost: test.example.ts.net\r\nTailscale-User-Login: " + Login + "\r\n" + extra + "\r\n"; }

    static async Task<string> Fetch(int port, string request)
    {
        using (var client = new TcpClient())
        {
            await client.ConnectAsync(IPAddress.Loopback, port);
            client.ReceiveTimeout = 5000;
            byte[] data = Encoding.ASCII.GetBytes(request);
            NetworkStream stream = client.GetStream();
            await stream.WriteAsync(data, 0, data.Length);
            client.Client.Shutdown(SocketShutdown.Send);
            using (var reader = new StreamReader(stream, Encoding.UTF8))
                return await reader.ReadToEndAsync();
        }
    }

    sealed class Backend : IDisposable
    {
        public TcpListener Listener = new TcpListener(IPAddress.Loopback, 0);
        public int Port;
        public byte[] LastRequest;
        public void Start() { Listener.Start(); Port = ((IPEndPoint)Listener.LocalEndpoint).Port; }
        public async Task Serve(CancellationToken stop)
        {
            using (stop.Register(() => Listener.Stop()))
            {
                while (!stop.IsCancellationRequested)
                {
                    TcpClient client;
                    try { client = await Listener.AcceptTcpClientAsync(); }
                    catch { if (stop.IsCancellationRequested) return; throw; }
                    Observe(Respond(client));
                }
            }
        }
        async Task Respond(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                var bytes = new MemoryStream();
                var chunk = new byte[1024];
                int n;
                while ((n = await stream.ReadAsync(chunk, 0, chunk.Length)) != 0)
                    bytes.Write(chunk, 0, n);
                if (bytes.Length == 0) return; // readiness probe
                LastRequest = bytes.ToArray();
                byte[] response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
                await stream.WriteAsync(response, 0, response.Length);
            }
        }
        public void Dispose() { Listener.Stop(); }
    }

    public static async Task Run()
    {
        using (var stop = new CancellationTokenSource())
        using (var backend = new Backend())
        {
            // Reserve a stable free port; the actual backend begins only in startBackend.
            backend.Start(); int port = backend.Port; backend.Listener.Stop();
            backend.Listener = new TcpListener(IPAddress.Loopback, port);
            int launches = 0;
            var gate = new WbRemoteGateway(0, port, Origin, new[] { Login }, async () => {
                Interlocked.Increment(ref launches);
                await Task.Delay(300);
                backend.Listener.Start();
                Observe(backend.Serve(stop.Token));
            }, message => {}, 1500);
            Task running = gate.Run(stop.Token);
            Assert(launches == 0, "gateway boot started backend");
            using (var idle = new TcpClient())
            {
                await idle.ConnectAsync(IPAddress.Loopback, gate.Port);
                await Task.Delay(100);
                Assert(launches == 0, "TCP connection without HTTP woke WSL");
            }
            string denied = await Fetch(gate.Port, "GET / HTTP/1.1\r\nHost: test.example.ts.net\r\n\r\n");
            Assert(denied.StartsWith("HTTP/1.1 403"), "anonymous access accepted");
            denied = await Fetch(gate.Port, Request("Tailscale-User-Login: attacker@example.com\r\n"));
            Assert(denied.StartsWith("HTTP/1.1 403"), "duplicate identity accepted");
            denied = await Fetch(gate.Port, Request("").Replace(Login, "attacker@example.com"));
            Assert(denied.StartsWith("HTTP/1.1 403"), "unauthorized identity accepted");
            denied = await Fetch(gate.Port, Request("").Replace("GET /", "POST /"));
            Assert(denied.StartsWith("HTTP/1.1 403"), "write without Origin accepted");
            Assert(launches == 0, "rejected request woke backend");
            var requests = new Task<string>[8];
            for (int i = 0; i < requests.Length; i++) requests[i] = Fetch(gate.Port, Request(""));
            string[] responses = await Task.WhenAll(requests);
            foreach (string response in responses) Assert(response.EndsWith("OK"), "cold request lost");
            Assert(launches == 1, "parallel requests launched more than once");
            string bodyRequest = Request("Origin: " + Origin + "\r\nContent-Length: 7\r\n").Replace("GET /", "POST /") + "a=1&b=2";
            await Fetch(gate.Port, bodyRequest);
            Assert(Encoding.ASCII.GetString(backend.LastRequest) == bodyRequest, "HTTP bytes or identity changed");
            await Fetch(gate.Port, Request(""));
            Assert(launches == 1, "warm access restarted WSL");
            stop.Cancel(); await running;
        }
        Console.WriteLine("PASS: idle boot, authorization, parallel cold start, HTTP bodies, warm access");

        using (var stop = new CancellationTokenSource())
        using (var reserve = new TcpListenerScope())
        {
            int launches = 0;
            var blocked = new TaskCompletionSource<bool>();
            var gate = new WbRemoteGateway(0, reserve.Port, Origin, new[] { Login }, () => {
                Interlocked.Increment(ref launches); return blocked.Task;
            }, message => {}, 30);
            Task running = gate.Run(stop.Token);
            string response = await Fetch(gate.Port, Request(""));
            Assert(response.StartsWith("HTTP/1.1 503") && response.Contains("http-equiv=\"refresh\""), "no waiting page");
            response = await Fetch(gate.Port, Request(""));
            Assert(launches == 1, "page refresh duplicated a pending startup");
            blocked.SetException(new IOException("test failure"));
            await Task.Delay(100);
            response = await Fetch(gate.Port, Request(""));
            Assert(response.Contains("启动失败") && !response.Contains("http-equiv=\"refresh\""), "failure auto-retries forever");
            Assert(launches == 1, "startup failure cooldown missing");
            stop.Cancel(); await running;
        }
        Console.WriteLine("PASS: waiting page, startup failure, retry cooldown");
        await WebSocket();
    }

    sealed class TcpListenerScope : IDisposable
    {
        readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        public readonly int Port;
        public TcpListenerScope() { listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); }
        public void Dispose() { listener.Stop(); }
    }

    static async Task WebSocket()
    {
        var backend = new TcpListener(IPAddress.Loopback, 0); backend.Start();
        int port = ((IPEndPoint)backend.LocalEndpoint).Port;
        using (var stop = new CancellationTokenSource())
        {
            var gate = new WbRemoteGateway(0, port, Origin, new[] { Login }, () => {
                throw new Exception("warm WebSocket started WSL");
            }, message => {}, 100);
            Task running = gate.Run(stop.Token);
            Task echo = Task.Run(async () => {
                using (var up = await backend.AcceptTcpClientAsync())
                {
                    var stream = up.GetStream();
                    var header = new MemoryStream();
                    var one = new byte[1];
                    while (!Encoding.ASCII.GetString(header.ToArray()).EndsWith("\r\n\r\n"))
                    { if (await stream.ReadAsync(one, 0, 1) == 0) throw new IOException(); header.WriteByte(one[0]); }
                    byte[] handshake = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
                    await stream.WriteAsync(handshake, 0, handshake.Length);
                    byte[] frame = new byte[8]; int used = 0;
                    while (used < frame.Length) used += await stream.ReadAsync(frame, used, frame.Length - used);
                    await stream.WriteAsync(frame, 0, frame.Length);
                }
            });
            using (var down = new TcpClient())
            {
                await down.ConnectAsync(IPAddress.Loopback, gate.Port);
                var stream = down.GetStream();
                byte[] header = Encoding.ASCII.GetBytes(Request("Origin: " + Origin + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"));
                await stream.WriteAsync(header, 0, header.Length);
                var received = new MemoryStream(); var one = new byte[1];
                while (!Encoding.ASCII.GetString(received.ToArray()).EndsWith("\r\n\r\n"))
                { if (await stream.ReadAsync(one, 0, 1) == 0) throw new IOException(); received.WriteByte(one[0]); }
                Assert(Encoding.ASCII.GetString(received.ToArray()).StartsWith("HTTP/1.1 101"), "upgrade lost");
                byte[] frame = new byte[] { 130, 134, 0, 255, 1, 128, 13, 10 };
                await stream.WriteAsync(frame, 0, frame.Length);
                byte[] reply = new byte[frame.Length]; int used = 0;
                while (used < reply.Length) { int n = await stream.ReadAsync(reply, used, reply.Length - used); if (n == 0) throw new IOException(); used += n; }
                Assert(Convert.ToBase64String(reply) == Convert.ToBase64String(frame), "binary WebSocket data changed");
            }
            await echo; stop.Cancel(); await running; backend.Stop();
        }
        Console.WriteLine("PASS: WebSocket upgrade and binary bidirectional relay");
    }
}
