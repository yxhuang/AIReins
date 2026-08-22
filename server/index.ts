import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { log } from "./logger.js";
import { normalizeFileQuery, searchFiles } from "./file-search.js";
import { getMeta, SERVER_VERSION } from "./meta.js";
import { checkPageHealth, scanPages } from "./pages.js";
import { SessionManager } from "./session-manager.js";
import {
  AGENTS,
  CONFIG_OPTION_IDS,
  type CreateSessionInput,
  type PermissionDecision,
  type SessionConfig,
  type UnifiedEvent,
  type UserMessageInput,
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
const pages = scanPages();
const pagesById = new Map(pages.map((page) => [page.id, page]));
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
    } else if (method === "GET" && url.pathname === "/api/pages") {
      respond(response, 200, 0, "success", { pages }, requestId);
    } else if (method === "GET" && url.pathname === "/api/sessions") {
      respond(response, 200, 0, "success", { sessions: manager.list() }, requestId);
    } else if (method === "POST" && url.pathname === "/api/sessions") {
      const input = validateCreateSession(await readJson(request));
      const session = await manager.create(input);
      respond(response, 201, 0, "success", { session }, requestId);
    } else {
      const snapshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
      const commandsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
      const filesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
      const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      const pageHealthMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/health$/);
      if (method === "GET" && pageHealthMatch) {
        const id = decodeURIComponent(pageHealthMatch[1]);
        const page = pagesById.get(id);
        if (!page) throw new ApiError(404, 40410, `页面不存在：${id}`);
        respond(response, 200, 0, "success", await checkPageHealth(page), requestId);
      } else if (method === "GET" && snapshotMatch) {
        const id = decodeURIComponent(snapshotMatch[1]);
        const snapshot = manager.getSnapshot(id);
        if (!snapshot) throw new ApiError(404, 40401, `会话不存在：${id}`);
        respond(response, 200, 0, "success", snapshot, requestId);
      } else if (method === "GET" && commandsMatch) {
        const id = decodeURIComponent(commandsMatch[1]);
        const commands = manager.getCommands(id);
        if (!commands) throw new ApiError(404, 40401, `会话不存在：${id}`);
        respond(response, 200, 0, "success", { commands }, requestId);
      } else if (method === "GET" && filesMatch) {
        const id = decodeURIComponent(filesMatch[1]);
        const session = manager.get(id);
        if (!session) throw new ApiError(404, 40401, `会话不存在：${id}`);
        const query = validateFileQuery(session.cwd, url.searchParams.get("q") ?? "");
        const limit = validateFileLimit(url.searchParams.get("limit"));
        const files = await searchFiles(session.cwd, query, limit);
        respond(response, 200, 0, "success", { files }, requestId);
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
    if (message.type === "user_message") {
      await manager.sendUserMessage(sessionId, validateUserMessage(message));
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
    if (item.type !== "file") {
      throw new ApiError(400, 40017, `user_message.mentions[${index}].type 目前只支持 file`);
    }
    if (typeof item.path !== "string" || !item.path.trim()) {
      throw new ApiError(400, 40018, `user_message.mentions[${index}].path 必须是非空字符串`);
    }
    if (item.name !== undefined && typeof item.name !== "string") {
      throw new ApiError(400, 40019, `user_message.mentions[${index}].name 必须是字符串`);
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
