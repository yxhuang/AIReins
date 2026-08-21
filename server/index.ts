import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { log } from "./logger.js";
import { getMeta, SERVER_VERSION } from "./meta.js";
import { SessionManager } from "./session-manager.js";
import {
  AGENTS,
  CONFIG_OPTION_IDS,
  type CreateSessionInput,
  type PermissionDecision,
  type SessionConfig,
  type UnifiedEvent,
} from "./types.js";
import { ulid } from "./ulid.js";

const HOST = "127.0.0.1";
const PORT = listenPort(process.env.WORKBENCH_PORT);
const STATIC_ROOT = process.env.WORKBENCH_STATIC_DIR
  ? resolve(process.env.WORKBENCH_STATIC_DIR)
  : resolve(fileURLToPath(new URL("../frontend/dist", import.meta.url)));

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
}

const manager = new SessionManager();
void getMeta(); // 启动时探测一次并缓存，不让首个 /api/meta 承担延迟。
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WsClientState>();

manager.onEvent((event) => {
  for (const client of clients) sendEvent(client, event);
});

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
});

wss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const afterSeq = Math.max(0, Number(url.searchParams.get("afterSeq")) || 0);
  const client: WsClientState = { socket, sessionId, lastSeq: new Map() };
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
  socket.on("close", () => clients.delete(client));
  socket.on("error", (error) => log("warn", "websocket error", { message: error.message, sessionId }));
});

server.listen(PORT, HOST, () => {
  log("info", "workbench server started", { host: HOST, port: PORT, staticRoot: STATIC_ROOT });
});

server.on("error", (error) => {
  log("error", "server error", { message: error.message, host: HOST, port: PORT });
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "workbench server stopping", { signal });
  for (const client of clients) client.socket.close(1001, "server shutdown");
  await manager.shutdown();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestId = ulid();
  const started = Date.now();
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/meta") {
      respond(response, 200, 0, "success", await getMeta(), requestId);
    } else if (method === "GET" && url.pathname === "/api/sessions") {
      respond(response, 200, 0, "success", { sessions: manager.list() }, requestId);
    } else if (method === "POST" && url.pathname === "/api/sessions") {
      const input = validateCreateSession(await readJson(request));
      const session = await manager.create(input);
      respond(response, 201, 0, "success", { session }, requestId);
    } else {
      const snapshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "GET" && snapshotMatch) {
        const id = decodeURIComponent(snapshotMatch[1]);
        const snapshot = manager.getSnapshot(id);
        if (!snapshot) throw new ApiError(404, 40401, `会话不存在：${id}`);
        respond(response, 200, 0, "success", snapshot, requestId);
      } else if (method === "GET" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const session = manager.get(id);
        if (!session) throw new ApiError(404, 40401, `会话不存在：${id}`);
        respond(response, 200, 0, "success", { session }, requestId);
      } else if (method === "DELETE" && detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const removed = await manager.remove(id);
        if (!removed) throw new ApiError(404, 40401, `会话不存在：${id}`);
        respond(response, 200, 0, "success", {
          removedSessionId: id,
          transcriptsDeleted: false,
          nativeTranscriptPath: removed.nativeTranscriptPath,
          workbenchTranscriptPreserved: true,
        }, requestId);
      } else if (!url.pathname.startsWith("/api/")) {
        if (!serveStatic(url.pathname, response)) throw new ApiError(404, 40400, "静态前端尚未构建");
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
    if (!response.headersSent) respond(response, apiError.status, apiError.code, apiError.message, {}, requestId);
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

async function handleWsMessage(client: WsClientState, text: string): Promise<void> {
  let message: Record<string, any>;
  try {
    message = JSON.parse(text) as Record<string, any>;
  } catch {
    sendWs(client, { type: "error", code: 40001, msg: "WS 消息必须是 JSON" });
    return;
  }
  const sessionId = String(message.sessionId ?? client.sessionId ?? "");
  if (!sessionId) {
    sendWs(client, { type: "error", code: 40002, msg: "WS 消息缺少 sessionId" });
    return;
  }
  try {
    if (message.type === "user_message") {
      await manager.sendUserMessage(sessionId, String(message.text ?? ""));
    } else if (message.type === "permission_resolved") {
      const decisions = new Set(["allow", "deny", "always"]);
      if (!decisions.has(message.decision)) throw new Error("decision 必须是 allow、deny 或 always");
      await manager.resolvePermission(
        sessionId,
        String(message.requestId ?? ""),
        message.decision as PermissionDecision,
        message.updatedInput,
      );
    } else if (message.type === "interrupt") {
      await manager.interrupt(sessionId);
    } else if (message.type === "set_config") {
      await manager.setConfig(sessionId, validateSessionConfig(message.config, "set_config.config"));
    } else {
      throw new Error(`不支持的 WS 上行类型：${String(message.type)}`);
    }
    sendWs(client, { type: "ack", action: message.type, sessionId, clientRequestId: message.requestId });
  } catch (error) {
    sendWs(client, {
      type: "error",
      code: 40003,
      msg: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  }
}

function sendEvent(client: WsClientState, event: UnifiedEvent): void {
  if (client.sessionId && client.sessionId !== event.sessionId) return;
  const last = client.lastSeq.get(event.sessionId) ?? 0;
  if (event.seq <= last) return;
  sendWs(client, event);
  client.lastSeq.set(event.sessionId, event.seq);
}

function sendWs(client: WsClientState, value: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(value));
}

function respond(
  response: ServerResponse,
  status: number,
  code: number,
  msg: string,
  data: unknown,
  requestId: string,
): void {
  const body = JSON.stringify({ code, msg, data, request_id: requestId });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
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
  if (input.agentId !== undefined && typeof input.agentId !== "string") throw new ApiError(400, 40003, "agentId 必须是字符串");
  if (input.initialMessage !== undefined && typeof input.initialMessage !== "string") throw new ApiError(400, 40004, "initialMessage 必须是字符串");
  if (input.model !== undefined && typeof input.model !== "string") throw new ApiError(400, 40005, "model 必须是字符串");
  if (input.kimiMode !== undefined && !["default", "plan", "auto", "yolo"].includes(String(input.kimiMode))) {
    throw new ApiError(400, 40006, "kimiMode 必须是 default、plan、auto 或 yolo");
  }
  if (input.config !== undefined) validateSessionConfig(input.config, "config");
  return input as unknown as CreateSessionInput;
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
    if (typeof input[key] !== "string") {
      throw new ApiError(400, 40009, `${label}.${key} 必须是字符串`);
    }
  }
  return input as SessionConfig;
}

function serveStatic(pathname: string, response: ServerResponse): boolean {
  if (!existsSync(STATIC_ROOT)) return false;
  const relative = pathname === "/" ? "/index.html" : pathname;
  let path = resolve(STATIC_ROOT, `.${relative}`);
  if (!path.startsWith(`${STATIC_ROOT}/`) && path !== STATIC_ROOT) return false;
  if ((!existsSync(path) || statSync(path).isDirectory()) && existsSync(resolve(STATIC_ROOT, "index.html"))) {
    path = resolve(STATIC_ROOT, "index.html");
  }
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(response);
  return true;
}
