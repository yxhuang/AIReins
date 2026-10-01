import { createReadStream, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { compressResponse } from "./response-compression.js";
import { WebSocket, WebSocketServer } from "ws";
import { checkAccess, loadRemoteConfig, localPolicy, remotePolicy, type AccessPolicy, type RemoteConfig } from "./access.js";
import { DispatchQueryError, getDispatch, getDispatchLog, getDispatchMessages, listDispatches, listDispatchHistory, listParentDispatches } from "./dispatches.js";
import { log } from "./logger.js";
import { DirListError, listDirectories } from "./dir-list.js";
import { normalizeFileQuery, searchFiles } from "./file-search.js";
import { HistoryIndex, HistoryQueryError } from "./history.js";
import { getMeta, SERVER_VERSION } from "./meta.js";
import { feishuSender, GateNotifier, larkCliSender, loadNotifyConfig, type NotifyConfig } from "./notify.js";
import { checkPageHealth, proxyPage, scanPages } from "./pages.js";
import { pruneStorage, workbenchHome } from "./persistence.js";
import { isValidIdleReleaseMinutes, loadPrefs, savePrefs, type WorkbenchPrefs } from "./prefs.js";
import { readClaudeStartupSettings, writeClaudeStartupSettings } from "./claude-settings.js";
import { SessionManager } from "./session-manager.js";
import { parseMcpAction } from "./session-menu.js";
import { preflightSnapshot, SnapshotCwdError } from "./snapshot.js";
import { TerminalError, TerminalRegistry, terminalEnabled, type TerminalEvent } from "./terminals.js";
import { IMAGE_MENTION_MIME_TYPES, resolveUploadFile, saveUpload, UploadError } from "./uploads.js";
import {
  AGENTS,
  CONFIG_OPTION_IDS,
  type CreateSessionInput,
  type PermissionDecision,
  type QuestionAnswers,
  type SessionConfig,
  type UnifiedEvent,
  type UserMessageInput,
} from "./types.js";
import { ulid } from "./ulid.js";
import { serveStatic } from "./static.js";
import { replaySession, sendEvent, sendWs } from "./event-stream.js";

const HOST = "127.0.0.1";
const PORT = listenPort(process.env.WORKBENCH_PORT);
const STATIC_ROOT = process.env.WORKBENCH_STATIC_DIR
  ? resolve(process.env.WORKBENCH_STATIC_DIR)
  : resolve(fileURLToPath(new URL("../frontend/dist", import.meta.url)));
const LOCAL_POLICY = localPolicy(PORT);
const REMOTE_CONFIG = readRemoteConfig();

/** 配置错误不影响本机入口。 */
function readRemoteConfig(): RemoteConfig | null {
  try {
    return loadRemoteConfig(join(workbenchHome, "remote.json"), PORT);
  } catch (error) {
    log("error", "remote.json 无效，远程入口未开启", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function listenPort(value: string | undefined): number {
  if (value === undefined) return 8790;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WORKBENCH_PORT 必须是 1 到 65535 的整数");
  }
  return port;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message);
  }
}

interface WsClientState {
  socket: WebSocket;
  sessionId?: string;
  lastSeq: Map<string, number>;
  /** 心跳：上次 ping 之后收到过 pong（刚连上时为 true） */
  alive: boolean;
}

let prefs: WorkbenchPrefs = loadPrefs();
// 必须在 SessionManager 读登记表之前：过期会话直接不载入
try {
  const pruned = pruneStorage(prefs.retentionDays);
  if (pruned.expired + pruned.removedFiles > 0) log("info", "storage pruned", { ...pruned, retentionDays: prefs.retentionDays });
} catch (error) {
  log("warn", "storage prune failed", { message: error instanceof Error ? error.message : String(error) });
}
const manager = new SessionManager();
const terminals = new TerminalRegistry(process.cwd());
const history = new HistoryIndex();
const pages = scanPages();
const pagesById = new Map(pages.map((page) => [page.id, page]));
void getMeta(); // 启动时探测一次并缓存，不让首个 /api/meta 承担延迟。
const wss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const clients = new Set<WsClientState>();
const terminalClients = new Map<WebSocket, boolean>();
// 包含未完成的 HTTP 请求和已升级连接，避免遗漏不在 WS 客户端表里的 socket。
const connections = new Set<Duplex>();

function trackConnections(listener: Server): void {
  listener.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
}

// 没回 pong 的连接在 25–50 秒内被断开（terminate 会触发 close，从 clients 里移除）。
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
  for (const [socket, alive] of terminalClients) {
    if (!alive) {
      socket.terminate();
      continue;
    }
    terminalClients.set(socket, false);
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
}, 25_000);
heartbeat.unref();

// 空闲自动释放：每分钟扫一次，N 来自 prefs（PUT /api/prefs 立即生效）；0 = 关闭。
const idleReleaseSweep = setInterval(() => {
  void manager.releaseIdleSessions(prefs.idleReleaseMinutes).catch((error) => {
    log("warn", "idle release sweep failed", { message: error instanceof Error ? error.message : String(error) });
  });
}, 60_000);
idleReleaseSweep.unref();

manager.onEvent((event) => {
  for (const client of clients) sendEvent(client, event);
});

startNotifier();

/** notify.json 配了才开启闸门提醒。 */
function startNotifier(): void {
  let config: NotifyConfig | null;
  try {
    config = loadNotifyConfig(join(workbenchHome, "notify.json"));
  } catch (error) {
    log("error", "notify.json 无效，闸门提醒未开启", { message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!config) return;
  const notifier = new GateNotifier(
    config.feishuWebhook ? feishuSender(config.feishuWebhook) : larkCliSender(config.larkUserId!),
    (id) => manager.get(id),
    config.delaySeconds * 1000,
    REMOTE_CONFIG?.origin,
  );
  manager.onEvent((event) => notifier.handle(event));
  log("info", "gate notifier started", { delaySeconds: config.delaySeconds, via: config.feishuWebhook ? "webhook" : "lark-cli" });
}

const server = createServer((request, response) => {
  void handleRequest(request, response, LOCAL_POLICY);
});
trackConnections(server);

server.on("upgrade", (request, socket, head) => handleUpgrade(request, socket, head, LOCAL_POLICY));

function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, policy: AccessPolicy): void {
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  const denied = checkAccess(policy, request.method ?? "GET", request.headers, true);
  if (denied) {
    log("warn", "websocket rejected", { reason: denied, path: request.url });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  if (url.pathname === "/ws/terminal") {
    if (!terminalEnabled(policy, REMOTE_CONFIG)) {
      log("warn", "websocket rejected", { reason: "终端未对该入口开放", path: request.url });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    terminalWss.handleUpgrade(request, socket, head, (websocket) => terminalWss.emit("connection", websocket, request));
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
}

wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const afterSeq = Math.max(0, Number(url.searchParams.get("afterSeq")) || 0);
  const client: WsClientState = { socket, sessionId, lastSeq: new Map(), alive: true };
  if (sessionId) client.lastSeq.set(sessionId, afterSeq);
  clients.add(client);

  if (sessionId) {
    const replay = manager.getEventsAfter(sessionId, afterSeq);
    if (!replay) {
      sendWs(client, { type: "error", code: 40401, msg: `会话不存在：${sessionId}` });
    } else if (replay.requiresSnapshot) {
      sendWs(client, { type: "resync_required", sessionId, currentSeq: replay.currentSeq });
    } else {
      for (const event of replay.events) sendEvent(client, event);
    }
  }
  sendWs(client, { type: "ready", serverVersion: SERVER_VERSION, sessionId, afterSeq });

  socket.on("message", (data) => void handleWsMessage(client, data.toString("utf8")));
  socket.on("pong", () => {
    client.alive = true;
  });
  socket.on("close", () => clients.delete(client));
  socket.on("error", (error) => log("warn", "websocket error", { message: error.message, sessionId }));
});

terminalWss.on("connection", (socket) => {
  terminalClients.set(socket, true);
  const attachments = new Map<string, () => void>();
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendTerminalWs(socket, { type: "error", message: "终端 WS 消息必须是 JSON 文本帧" });
      return;
    }
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("消息必须是对象");
      message = value as Record<string, unknown>;
    } catch {
      sendTerminalWs(socket, { type: "error", message: "终端 WS 消息必须是 JSON 对象" });
      return;
    }
    const terminalId = message.terminalId;
    if (typeof terminalId !== "string" || !terminalId) {
      sendTerminalWs(socket, { type: "error", message: "terminalId 必须是非空字符串" });
      return;
    }
    try {
      if (message.type === "attach") {
        attachments.get(terminalId)?.();
        const replay = terminals.attach(terminalId, (event: TerminalEvent) => sendTerminalWs(socket, event));
        attachments.set(terminalId, replay.detach);
        sendTerminalWs(socket, { type: "attached", terminalId, omitted: replay.omitted });
        sendTerminalWs(socket, { type: "data", terminalId, data: replay.data });
        if (replay.exited) sendTerminalWs(socket, { type: "exit", terminalId, exitCode: replay.exitCode });
      } else if (message.type === "detach") {
        attachments.get(terminalId)?.();
        attachments.delete(terminalId);
      } else if (message.type === "input") {
        terminals.input(terminalId, message.data);
      } else if (message.type === "resize") {
        terminals.resize(terminalId, message.cols, message.rows);
      } else {
        throw new TerminalError("invalid", `不支持的终端 WS 类型：${String(message.type)}`);
      }
    } catch (error) {
      sendTerminalWs(socket, { type: "error", terminalId, message: error instanceof Error ? error.message : String(error) });
    }
  });
  socket.on("close", () => {
    for (const detach of attachments.values()) detach();
    terminalClients.delete(socket);
  });
  socket.on("pong", () => terminalClients.set(socket, true));
  socket.on("error", (error) => log("warn", "terminal websocket error", { message: error.message }));
});

function sendTerminalWs(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) {
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(value));
}

server.listen(PORT, HOST, () => {
  log("info", "workbench server started", { host: HOST, port: PORT, staticRoot: STATIC_ROOT });
});

server.on("error", (error) => {
  log("error", "server error", { message: error.message, host: HOST, port: PORT });
  process.exitCode = 1;
});

const remoteServer = REMOTE_CONFIG ? startRemoteListener(REMOTE_CONFIG) : null;

function startRemoteListener(config: RemoteConfig): Server {
  const policy = remotePolicy(config);
  const remote = createServer((request, response) => {
    void handleRequest(request, response, policy);
  });
  trackConnections(remote);
  remote.on("upgrade", (request, socket, head) => handleUpgrade(request, socket, head, policy));
  remote.on("error", (error) => log("error", "remote listener error", { message: error.message, port: config.port }));
  remote.listen(config.port, HOST, () => {
    log("info", "remote listener started", { host: HOST, port: config.port, origin: config.origin });
  });
  return remote;
}

let shuttingDown = false;
let restartPending = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    log("error", "workbench server shutdown timed out", { signal, timeoutMs: 10_000 });
    process.exit(1);
  }, 10_000);
  log("info", "workbench server stopping", { signal });
  clearInterval(heartbeat);
  clearInterval(idleReleaseSweep);
  try {
    for (const client of clients) client.socket.close(1001, "server shutdown");
    for (const socket of terminalClients.keys()) socket.close(1001, "server shutdown");
    terminals.shutdown();
    // wb stop 以主监听空出作为 worker 已停完的标志；此前只拒绝请求，不关闭监听。
    await manager.shutdown();
    const listeners = remoteServer ? [server, remoteServer] : [server];
    const closed = listeners.map((listener) => new Promise<void>((resolveClose, rejectClose) => {
      listener.close((error) => error ? rejectClose(error) : resolveClose());
    }));
    for (const listener of listeners) listener.closeAllConnections();
    for (const client of clients) client.socket.terminate();
    for (const socket of terminalClients.keys()) socket.terminate();
    for (const socket of connections) socket.destroy();
    await Promise.all(closed);
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    log("error", "workbench server shutdown failed", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.once("exit", () => terminals.shutdown());

async function handleRequest(request: IncomingMessage, response: ServerResponse, policy: AccessPolicy): Promise<void> {
  if (shuttingDown) {
    response.writeHead(503, { "Connection": "close", "Content-Type": "text/plain; charset=utf-8" });
    response.end("server shutting down");
    return;
  }
  const requestId = ulid();
  const started = Date.now();
  try {
    const denied = checkAccess(policy, request.method ?? "GET", request.headers, false);
    if (denied) throw new ApiError(403, 40300, denied);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/meta") {
      const meta = await getMeta();
      await respond(response, 200, 0, "success", {
        ...meta,
        capabilities: { terminal: terminalEnabled(policy, REMOTE_CONFIG) },
      }, requestId);
    } else if (method === "POST" && url.pathname === "/api/restart") {
      if (!restartPending) {
        restartPending = true;
        // finish 保证先交付 202；稍后让浏览器有机会处理响应并进入遮罩。
        response.once("finish", () => {
          setTimeout(() => {
            // POSIX detached 会新建 session / process group，stop 不会连坐此启动器。
            const child = spawn("bash", [fileURLToPath(new URL("../bin/workbench", import.meta.url)), "restart"], {
              detached: true,
              stdio: "ignore",
              env: {
                ...process.env,
                WORKBENCH_PORT: String(PORT),
                WORKBENCH_HOME: resolve(workbenchHome),
                WORKBENCH_LOG: resolve(process.env.WORKBENCH_LOG || join(workbenchHome, "server.log")),
                ...(process.env.WORKBENCH_STATIC_DIR ? { WORKBENCH_STATIC_DIR: STATIC_ROOT } : {}),
                WORKBENCH_NO_OPEN: "1",
              },
            });
            child.once("error", (error) => {
              restartPending = false;
              log("error", "workbench restart launcher failed", { message: error.message });
            });
            // 启动器在停服前就失败退出时放开闸门，允许再点
            child.once("exit", (code) => { if (code) restartPending = false; });
            child.unref();
          }, 200);
        });
      }
      await respond(response, 202, 0, "accepted", { restarting: true }, requestId);
    } else if (url.pathname === "/api/terminals" && method === "GET") {
      requireTerminalEnabled(policy);
      await respond(response, 200, 0, "success", { terminals: terminals.list() }, requestId);
    } else if (url.pathname === "/api/terminals" && method === "POST") {
      requireTerminalEnabled(policy);
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, 40040, "请求体必须是 JSON 对象");
      try {
        const { cwd, shell, cols, rows } = input as Record<string, unknown>;
        await respond(response, 201, 0, "success", terminals.create({ cwd: cwd as string | undefined, shell, cols: cols as number, rows: rows as number }), requestId);
      } catch (error) {
        throw asTerminalApiError(error);
      }
    } else if (method === "POST" && /^\/api\/terminals\/[^/]+\/kill$/.test(url.pathname)) {
      requireTerminalEnabled(policy);
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      try {
        terminals.kill(id);
        await respond(response, 200, 0, "success", { ok: true }, requestId);
      } catch (error) {
        throw asTerminalApiError(error);
      }
    } else if (method === "GET" && url.pathname === "/api/fs/dirs") {
      try {
        const files = url.searchParams.get("files");
        if (files !== null && files !== "1" && files !== "0") {
          throw new ApiError(400, 40036, "files 参数只接受 1 或 0");
        }
        await respond(response, 200, 0, "success", await listDirectories(url.searchParams.get("path") ?? undefined, { files: files === "1" }), requestId);
      } catch (error) {
        if (error instanceof DirListError) throw new ApiError(400, 40035, error.message);
        throw error;
      }
    } else if (method === "POST" && url.pathname === "/api/uploads") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!manager.get(sessionId)) throw new ApiError(404, 40401, `会话不存在：${sessionId || "（空）"}`);
      const name = url.searchParams.get("name") ?? "";
      if (!name.trim()) throw new ApiError(400, 40070, "name 参数必须是非空文件名");
      try {
        await respond(response, 201, 0, "success", await saveUpload(sessionId, name, request), requestId);
      } catch (error) {
        if (error instanceof UploadError) throw new ApiError(error.status, error.code, error.message);
        throw error;
      }
    } else if (method === "GET" && url.pathname === "/api/uploads/file") {
      const file = await resolveUploadFile(url.searchParams.get("path") ?? "");
      if (!file) throw new ApiError(404, 40450, "文件不在上传目录内或不存在");
      const size = statSync(file.path).size;
      response.writeHead(200, {
        "content-type": file.mimeType,
        "content-length": size,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        // 上传的 SVG/HTML 被直接打开时不能在工作台同源下跑脚本；<img> 不受影响
        "content-security-policy": "sandbox",
      });
      createReadStream(file.path).pipe(response);
    } else if (method === "GET" && url.pathname === "/api/dispatches") {
      try {
        const parent = url.searchParams.get("parent");
        await respond(response, 200, 0, "success", { dispatches: parent !== null ? await listParentDispatches(parent) : await listDispatches(url.searchParams.get("limit")) }, requestId);
      } catch (error) {
        if (error instanceof DispatchQueryError) throw new ApiError(400, 40000, error.message);
        throw error;
      }
    } else if (method === "GET" && url.pathname === "/api/dispatches/history") {
      try {
        await respond(response, 200, 0, "success", await listDispatchHistory(url.searchParams.get("offset")), requestId);
      } catch (error) {
        if (error instanceof DispatchQueryError) throw new ApiError(400, 40000, error.message);
        throw error;
      }
    } else if (method === "GET" && url.pathname.startsWith("/api/dispatches/")) {
      const match = url.pathname.match(/^\/api\/dispatches\/([^/]+)(\/log|\/messages)?$/);
      if (!match) throw new ApiError(404, 40400, "派单不存在");
      let runId: string;
      try { runId = decodeURIComponent(match[1]!); }
      catch { throw new ApiError(404, 40400, "派单不存在"); }
      try {
        const data = match[2] === "/messages"
          ? await getDispatchMessages(runId, url.searchParams.get("cursor"))
          : match[2]
          ? await getDispatchLog(runId, url.searchParams.get("stream") ?? "stdout", url.searchParams.get("offset"))
          : await getDispatch(runId);
        if (!data) throw new ApiError(404, 40400, "派单或日志不可读取");
        await respond(response, 200, 0, "success", data, requestId);
      } catch (error) {
        if (error instanceof DispatchQueryError) throw new ApiError(400, 40000, error.message);
        throw error;
      }
    } else if (method === "GET" && url.pathname === "/api/pages") {
      await respond(response, 200, 0, "success", { pages }, requestId);
    } else if (url.pathname === "/api/prefs" && method === "GET") {
      await respond(response, 200, 0, "success", { ...prefs }, requestId);
    } else if (url.pathname === "/api/prefs" && method === "PUT") {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, 40061, "请求体必须是 JSON 对象");
      const idleReleaseMinutes = (input as Record<string, unknown>).idleReleaseMinutes;
      if (!isValidIdleReleaseMinutes(idleReleaseMinutes)) {
        throw new ApiError(400, 40062, "idleReleaseMinutes 必须是 0 到 1440 的整数");
      }
      prefs = { ...prefs, idleReleaseMinutes };
      savePrefs(prefs);
      await respond(response, 200, 0, "success", { ...prefs }, requestId);
    } else if (url.pathname === "/api/claude/settings" && (method === "GET" || method === "PUT")) {
      let enabled: boolean | undefined;
      if (method === "PUT") {
        const input = await readJson(request);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ApiError(400, 40064, "请求体必须是 JSON 对象");
        }
        const value = (input as Record<string, unknown>).remoteControlAtStartup;
        if (typeof value !== "boolean") {
          throw new ApiError(400, 40064, "remoteControlAtStartup 必须是布尔值");
        }
        enabled = value;
      }
      try {
        const settings = enabled === undefined ? readClaudeStartupSettings() : writeClaudeStartupSettings(enabled);
        await respond(response, 200, 0, "success", settings, requestId);
      } catch (error) {
        throw new ApiError(400, 40064, error instanceof Error ? error.message : String(error));
      }
    } else if (method === "GET" && url.pathname === "/api/sessions") {
      await respond(response, 200, 0, "success", { sessions: manager.list() }, requestId);
    } else if (method === "GET" && url.pathname === "/api/history") {
      const input = validateHistoryQuery(url.searchParams);
      try {
        await respond(response, 200, 0, "success", await history.list(input), requestId);
      } catch (error) {
        if (error instanceof HistoryQueryError) throw new ApiError(400, 40032, error.message);
        throw error;
      }
    } else if (method === "POST" && url.pathname === "/api/snapshot/preflight") {
      const cwd = validateSnapshotPreflight(await readJson(request));
      try {
        await respond(response, 200, 0, "success", await preflightSnapshot(cwd), requestId);
      } catch (error) {
        if (error instanceof SnapshotCwdError) throw new ApiError(400, 40022, error.message);
        throw error;
      }
    } else if (method === "POST" && url.pathname === "/api/sessions") {
      const input = validateCreateSession(await readJson(request));
      // 续接导入：在 create 前记下原生消息文件的截止 cursor（historyCursor 是服务端内部字段，
      // 客户端即使在请求体里传了也会被这里覆盖）；算不出只记日志，照常创建。
      let historyCursor: string | undefined;
      if (input.resumeSessionId) {
        try {
          historyCursor = await history.endCursor(input.agent, input.resumeSessionId);
        } catch (error) {
          log("warn", "history endCursor failed; creating without cursor", {
            agent: input.agent,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const session = await manager.create({ ...input, historyCursor });
      await respond(response, 201, 0, "success", { session }, requestId);
    } else {
      const snapshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      const commandsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
      const codexCommandMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/codex\/command$/);
      const filesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
      const releaseMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/release$/);
      const infoMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/info\/([a-z]+)$/);
      const pluginMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/plugins$/);
      const mcpMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp$/);
      const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      const historyMessagesMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/([^/]+)\/messages$/);
      const pageHealthMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/health$/);
      const pageProxyMatch = url.pathname.match(/^\/pages\/([^/]+)(\/.*)?$/);
      if (method === "GET" && pageHealthMatch) {
        const id = decodeURIComponent(pageHealthMatch[1]);
        const page = pagesById.get(id);
        if (!page) throw new ApiError(404, 40410, `页面不存在：${id}`);
        await respond(response, 200, 0, "success", await checkPageHealth(page), requestId);
      } else if (method === "GET" && snapshotMatch) {
        const id = decodeURIComponent(snapshotMatch[1]);
        const snapshot = manager.getSnapshot(id);
        if (!snapshot) throw new ApiError(404, 40401, `会话不存在：${id}`);
        await respond(response, 200, 0, "success", snapshot, requestId);
      } else if (method === "POST" && codexCommandMatch) {
        const id = decodeURIComponent(codexCommandMatch[1]);
        if (!manager.get(id)) throw new ApiError(404, 40401, `会话不存在：${id}`);
        const input = await readJson(request);
        try {
          await respond(response, 200, 0, "success", await manager.executeCodexCommand(id, input), requestId);
        } catch (error) {
          throw new ApiError(400, 40067, error instanceof Error ? error.message : String(error));
        }
      } else if (method === "GET" && commandsMatch) {
        const id = decodeURIComponent(commandsMatch[1]);
        const commands = manager.getCommands(id);
        if (!commands) throw new ApiError(404, 40401, `会话不存在：${id}`);
        await respond(response, 200, 0, "success", { commands }, requestId);
      } else if (method === "GET" && filesMatch) {
        const id = decodeURIComponent(filesMatch[1]);
        const session = manager.get(id);
        if (!session) throw new ApiError(404, 40401, `会话不存在：${id}`);
        const query = validateFileQuery(session.cwd, url.searchParams.get("q") ?? "");
        const limit = validateFileLimit(url.searchParams.get("limit"));
        const files = await searchFiles(session.cwd, query, limit);
        await respond(response, 200, 0, "success", { files }, requestId);
      } else if (method === "POST" && releaseMatch) {
        const id = decodeURIComponent(releaseMatch[1]);
        if (!manager.get(id)) throw new ApiError(404, 40401, `会话不存在：${id}`);
        try {
          const result = await manager.release(id, "manual");
          await respond(response, 200, 0, "success", result, requestId);
        } catch (error) {
          throw new ApiError(400, 40060, error instanceof Error ? error.message : String(error));
        }
      } else if (method === "POST" && mcpMatch) {
        const id = decodeURIComponent(mcpMatch[1]);
        if (!manager.get(id)) throw new ApiError(404, 40401, `会话不存在：${id}`);
        const input = await readJson(request);
        try {
          await respond(response, 200, 0, "success", await manager.manageMcp(id, parseMcpAction(input)), requestId);
        } catch (error) {
          throw new ApiError(400, 40066, error instanceof Error ? error.message : String(error));
        }
      } else if (method === "PUT" && pluginMatch) {
        const id = decodeURIComponent(pluginMatch[1]);
        if (!manager.get(id)) throw new ApiError(404, 40401, `会话不存在：${id}`);
        const input = await readJson(request);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new ApiError(400, 40065, "请求体必须是 JSON 对象");
        }
        const body = input as Record<string, unknown>;
        if (typeof body.id !== "string" || typeof body.enabled !== "boolean") {
          throw new ApiError(400, 40065, "id 必须是字符串，enabled 必须是布尔值");
        }
        try {
          await respond(response, 200, 0, "success", await manager.setPluginEnabled(id, body.id, body.enabled, body.scope), requestId);
        } catch (error) {
          throw new ApiError(400, 40065, error instanceof Error ? error.message : String(error));
        }
      } else if (method === "GET" && infoMatch) {
        const id = decodeURIComponent(infoMatch[1]);
        if (!manager.get(id)) throw new ApiError(404, 40401, `会话不存在：${id}`);
        try {
          await respond(response, 200, 0, "success", await manager.queryInfo(id, infoMatch[2]), requestId);
        } catch (error) {
          throw new ApiError(400, 40063, error instanceof Error ? error.message : String(error));
        }
      } else if (method === "GET" && historyMessagesMatch) {
        const agent = validateHistoryAgent(decodeHistorySegment(historyMessagesMatch[1]));
        const nativeSessionId = validateNativeSessionId(decodeHistorySegment(historyMessagesMatch[2]));
        try {
          const page = await history.messages(agent, nativeSessionId, validateHistoryMessagesQuery(url.searchParams));
          if (!page) throw new ApiError(404, 40430, "历史会话不存在或无法读取");
          await respond(response, 200, 0, "success", page, requestId);
        } catch (error) {
          if (error instanceof HistoryQueryError) throw new ApiError(400, 40034, error.message);
          throw error;
        }
      } else if (method === "GET" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const session = manager.get(id);
        if (!session) throw new ApiError(404, 40401, `会话不存在：${id}`);
        await respond(response, 200, 0, "success", { session }, requestId);
      } else if (method === "DELETE" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const removed = await manager.remove(id);
        if (!removed) throw new ApiError(404, 40401, `会话不存在：${id}`);
        await respond(response, 200, 0, "success", {
          removedSessionId: id,
          transcriptsDeleted: false,
          nativeTranscriptPath: removed.nativeTranscriptPath,
          workbenchTranscriptPreserved: true,
        }, requestId);
      } else if (pageProxyMatch) {
        const page = pagesById.get(decodeURIComponent(pageProxyMatch[1]));
        if (!page?.proxy) throw new ApiError(404, 40410, `页面不存在或未开启代理：${pageProxyMatch[1]}`);
        if (!pageProxyMatch[2]) {
          // 目标前端用相对路径，入口必须带结尾斜杠才能解析对
          response.writeHead(302, { location: `/pages/${pageProxyMatch[1]}/${url.search}` });
          response.end();
        } else {
          try {
            await proxyPage(page, pageProxyMatch[2] + url.search, request, response);
          } catch (error) {
            throw new ApiError(502, 50200, `${page.name} 不可达：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else if (!url.pathname.startsWith("/api/")) {
        if (!serveStatic(STATIC_ROOT, url.pathname, response, request.headers["accept-encoding"])) throw new ApiError(404, 40400, "静态前端尚未构建");
      } else {
        throw new ApiError(404, 40400, "接口不存在");
      }
    }
    log("info", "request completed", {
      request_id: requestId,
      method: request.method,
      path: request.url,
      status: response.statusCode,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, 50000, error instanceof Error ? error.message : String(error));
    if (!response.headersSent) await respond(response, apiError.status, apiError.code, apiError.message, {}, requestId);
    log("error", "request failed", {
      request_id: requestId,
      method: request.method,
      path: request.url,
      status: apiError.status,
      code: apiError.code,
      message: apiError.message,
      durationMs: Date.now() - started,
    });
  }
}

function requireTerminalEnabled(policy: AccessPolicy): void {
  if (!terminalEnabled(policy, REMOTE_CONFIG)) throw new ApiError(403, 40300, "终端未对该入口开放");
}

function asTerminalApiError(error: unknown): Error {
  if (error instanceof TerminalError) {
    return new ApiError(error.kind === "missing" ? 404 : 400, error.kind === "missing" ? 40440 : 40040, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function handleWsMessage(client: WsClientState, text: string): Promise<void> {
  let message: Record<string, any>;
  try {
    message = JSON.parse(text) as Record<string, any>;
  } catch {
    sendWs(client, { type: "error", code: 40001, msg: "WS 消息必须是 JSON" });
    return;
  }
  const context = {
    action: typeof message.type === "string" ? message.type : String(message.type ?? ""),
    ...(message.clientRequestId !== undefined ? { clientRequestId: message.clientRequestId } : {}),
  };
  const sessionId = String(message.sessionId ?? client.sessionId ?? "");
  if (!sessionId) {
    sendWs(client, { type: "error", code: 40002, msg: "WS 消息缺少 sessionId", ...context });
    return;
  }
  try {
    if (message.clientRequestId !== undefined && typeof message.clientRequestId !== "string") {
      throw new Error("clientRequestId 必须是字符串");
    }
    if (message.type === "replay") {
      if (!Number.isSafeInteger(message.afterSeq) || message.afterSeq < 0) throw new Error("afterSeq 必须是非负整数");
      replaySession(manager, client, sessionId, message.afterSeq);
    } else if (message.type === "user_message") {
      await manager.sendUserMessage(sessionId, validateUserMessage(message));
    } else if (message.type === "permission_resolved") {
      const decisions = new Set(["allow", "deny", "always"]);
      if (!decisions.has(message.decision)) throw new Error("decision 必须是 allow、deny 或 always");
      const questionAnswers = validateQuestionAnswers(message.questionAnswers);
      if (questionAnswers && message.decision === "deny") {
        throw new Error("questionAnswers 只能与 allow 或 always 一起发送");
      }
      if (questionAnswers && message.updatedInput !== undefined) {
        throw new Error("questionAnswers 与 updatedInput 不能同时发送");
      }
      await manager.resolvePermission(
        sessionId,
        String(message.requestId ?? ""),
        message.decision as PermissionDecision,
        message.updatedInput,
        questionAnswers,
      );
    } else if (message.type === "interrupt") {
      await manager.interrupt(sessionId);
    } else if (message.type === "set_config") {
      await manager.setConfig(sessionId, validateSessionConfig(message.config, "set_config.config"));
    } else if (message.type === "set_remote_control") {
      if (typeof message.enabled !== "boolean") throw new Error("set_remote_control.enabled 必须是布尔值");
      await manager.setRemoteControl(sessionId, message.enabled);
    } else {
      throw new Error(`不支持的 WS 上行类型：${String(message.type)}`);
    }
    sendWs(client, { type: "ack", sessionId, ...context });
  } catch (error) {
    sendWs(client, {
      type: "error",
      code: 40003,
      msg: error instanceof Error ? error.message : String(error),
      sessionId,
      ...context,
    });
  }
}

function validateQuestionAnswers(value: unknown): QuestionAnswers | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("questionAnswers 必须是问题文本到答案字符串的 JSON 对象");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 4) {
    throw new Error("questionAnswers 必须包含 1 到 4 个答案");
  }
  for (const [question, answer] of entries) {
    if (!question.trim() || question.length > 2_000) {
      throw new Error("questionAnswers 的问题文本必须为 1 到 2000 个字符");
    }
    if (typeof answer !== "string" || !answer.trim() || answer.length > 10_000) {
      throw new Error("questionAnswers 的答案必须为 1 到 10000 个字符的字符串");
    }
  }
  return Object.fromEntries(entries) as QuestionAnswers;
}

function validateFileQuery(cwd: string, value: string): string {
  try {
    return normalizeFileQuery(cwd, value);
  } catch (error) {
    throw new ApiError(400, 40020, error instanceof Error ? error.message : String(error));
  }
}

function validateFileLimit(value: string | null): number {
  if (value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, 40021, "limit 必须是 1 到 200 的整数");
  }
  return limit;
}

function validateHistoryQuery(searchParams: URLSearchParams): {
  agent?: CreateSessionInput["agent"];
  q?: string;
  limit: number;
  cursor?: string;
} {
  const agentValue = searchParams.get("agent");
  const q = searchParams.get("q") ?? "";
  const cursor = searchParams.get("cursor") ?? "";
  if (q.length > 500) throw new ApiError(400, 40030, "q 最多 500 个字符");
  if (cursor.length > 4_096) throw new ApiError(400, 40031, "cursor 过长");
  const limitValue = searchParams.get("limit");
  const limit = limitValue === null || limitValue === "" ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, 40031, "history limit 必须是 1 到 200 的整数");
  }
  return {
    ...(agentValue ? { agent: validateHistoryAgent(agentValue) } : {}),
    ...(q ? { q } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

function validateHistoryAgent(value: string): CreateSessionInput["agent"] {
  if (!AGENTS.includes(value as CreateSessionInput["agent"])) {
    throw new ApiError(400, 40030, "history agent 必须是 claude、codex 或 kimi");
  }
  return value as CreateSessionInput["agent"];
}

function validateHistoryMessagesQuery(searchParams: URLSearchParams): { limit: number; cursor?: string } {
  const limitValue = searchParams.get("limit");
  const limit = limitValue === null || limitValue === "" ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, 40034, "消息 limit 必须是 1 到 200 的整数");
  }
  const cursor = searchParams.get("cursor") ?? "";
  if (cursor.length > 4_096) throw new ApiError(400, 40034, "消息 cursor 过长");
  return { limit, ...(cursor ? { cursor } : {}) };
}

function validateNativeSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ApiError(400, 40033, "nativeSessionId 格式无效");
  }
  return value;
}

function decodeHistorySegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 40033, "history 路径参数编码无效");
  }
}

async function respond(
  response: ServerResponse,
  status: number,
  code: number,
  msg: string,
  data: unknown,
  requestId: string,
): Promise<void> {
  const json = JSON.stringify({ code, msg, data, request_id: requestId });
  // 长会话快照可达十几 MB，手机走远程时 10 秒内下不完；大响应按 Accept-Encoding 用 gzip（level 1：约 1/5 体积、百毫秒内）
  const gzip = json.length > 32 * 1024 && /\bgzip\b/.test(String(response.req?.headers["accept-encoding"] ?? ""));
  const body = gzip ? await compressResponse(json) : json;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new ApiError(413, 41300, "请求体超过 1 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ApiError(400, 40000, "请求体不是有效 JSON");
  }
}

function validateCreateSession(value: unknown): CreateSessionInput {
  if (!value || typeof value !== "object") throw new ApiError(400, 40000, "请求体必须是 JSON 对象");
  const input = value as Record<string, unknown>;
  if (!AGENTS.includes(input.agent as CreateSessionInput["agent"])) {
    throw new ApiError(400, 40001, "agent 必须是 claude、codex 或 kimi");
  }
  if (typeof input.cwd !== "string") throw new ApiError(400, 40002, "cwd 必须是绝对路径字符串");
  if (input.snapshot !== undefined && !["auto", "skip"].includes(String(input.snapshot))) {
    throw new ApiError(400, 40023, "snapshot 必须是 auto 或 skip");
  }
  if (input.agentId !== undefined && typeof input.agentId !== "string") throw new ApiError(400, 40003, "agentId 必须是字符串");
  if (input.initialMessage !== undefined && typeof input.initialMessage !== "string") throw new ApiError(400, 40004, "initialMessage 必须是字符串");
  if (input.model !== undefined && typeof input.model !== "string") throw new ApiError(400, 40005, "model 必须是字符串");
  if (input.resumeSessionId !== undefined) {
    if (typeof input.resumeSessionId !== "string") {
      throw new ApiError(400, 40005, "resumeSessionId 必须是字符串");
    }
    validateNativeSessionId(input.resumeSessionId);
  }
  if (input.kimiMode !== undefined && !["default", "plan", "auto", "yolo"].includes(String(input.kimiMode))) {
    throw new ApiError(400, 40006, "kimiMode 必须是 default、plan、auto 或 yolo");
  }
  if (input.config !== undefined) validateSessionConfig(input.config, "config");
  return input as unknown as CreateSessionInput;
}

function validateSnapshotPreflight(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, 40020, "请求体必须是 JSON 对象");
  }
  const cwd = (value as Record<string, unknown>).cwd;
  if (typeof cwd !== "string") throw new ApiError(400, 40022, "cwd 必须是绝对路径字符串");
  return cwd;
}

function validateSessionConfig(value: unknown, label: string): SessionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, 40007, `${label} 必须是 JSON 对象`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CONFIG_OPTION_IDS.includes(key as (typeof CONFIG_OPTION_IDS)[number])) {
      throw new ApiError(400, 40008, `${label} 不支持字段：${key}`);
    }
    if (typeof input[key] !== "string" && input[key] !== null) {
      throw new ApiError(400, 40009, `${label}.${key} 必须是字符串或 null`);
    }
  }
  return input as SessionConfig;
}

function validateUserMessage(value: Record<string, any>): UserMessageInput {
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new ApiError(400, 40010, "user_message.text 必须是字符串");
  }
  let command: UserMessageInput["command"];
  if (value.command !== undefined) {
    if (!value.command || typeof value.command !== "object" || Array.isArray(value.command)) {
      throw new ApiError(400, 40011, "user_message.command 必须是对象");
    }
    if (typeof value.command.name !== "string") {
      throw new ApiError(400, 40012, "user_message.command.name 必须是字符串");
    }
    if (value.command.arguments !== undefined && typeof value.command.arguments !== "string") {
      throw new ApiError(400, 40013, "user_message.command.arguments 必须是字符串");
    }
    command = {
      name: value.command.name,
      ...(value.command.arguments !== undefined ? { arguments: value.command.arguments } : {}),
    };
  }
  if (value.mentions !== undefined && !Array.isArray(value.mentions)) {
    throw new ApiError(400, 40014, "user_message.mentions 必须是数组");
  }
  if ((value.mentions?.length ?? 0) > 20) {
    throw new ApiError(400, 40015, "单条 user_message 最多包含 20 个引用");
  }
  const mentions = (value.mentions ?? []).map((mention: unknown, index: number) => {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)) {
      throw new ApiError(400, 40016, `user_message.mentions[${index}] 必须是对象`);
    }
    const item = mention as Record<string, unknown>;
    if (item.type !== "file" && item.type !== "image") {
      throw new ApiError(400, 40017, `user_message.mentions[${index}].type 只支持 file 或 image`);
    }
    if (typeof item.path !== "string" || !item.path.trim()) {
      throw new ApiError(400, 40018, `user_message.mentions[${index}].path 必须是非空字符串`);
    }
    if (item.name !== undefined && typeof item.name !== "string") {
      throw new ApiError(400, 40019, `user_message.mentions[${index}].name 必须是字符串`);
    }
    if (item.type === "image") {
      if (typeof item.mimeType !== "string" || !IMAGE_MENTION_MIME_TYPES.has(item.mimeType)) {
        throw new ApiError(400, 40024, `user_message.mentions[${index}].mimeType 必须是 image/png、image/jpeg、image/gif 或 image/webp`);
      }
      return {
        type: "image" as const,
        path: item.path,
        mimeType: item.mimeType,
        ...(item.name !== undefined ? { name: item.name } : {}),
      };
    }
    return {
      type: "file" as const,
      path: item.path,
      ...(item.name !== undefined ? { name: item.name } : {}),
    };
  });
  return {
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(command ? { command } : {}),
    ...(mentions.length ? { mentions } : {}),
  };
}
