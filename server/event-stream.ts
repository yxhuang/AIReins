import { WebSocket } from "ws";
import type { SessionManager } from "./session-manager.js";
import type { UnifiedEvent } from "./types.js";

export interface EventClient {
  socket: Pick<WebSocket, "readyState" | "send">;
  sessionId?: string;
  lastSeq: Map<string, number>;
}

export function sendEvent(client: EventClient, event: UnifiedEvent): void {
  if (client.sessionId && client.sessionId !== event.sessionId) return;
  const last = client.lastSeq.get(event.sessionId) ?? 0;
  if (event.ephemeral) { sendWs(client, event); return; }
  if (event.seq <= last) return;
  sendWs(client, event);
  client.lastSeq.set(event.sessionId, event.seq);
}

export function sendWs(client: EventClient, value: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(value));
}

/** 在全局 WS 上按会话游标补发，实时帧与补发交错由客户端去重。 */
export function replaySession(manager: Pick<SessionManager, "getEventsAfter">, client: EventClient, sessionId: string, afterSeq: number): void {
  if (client.sessionId && client.sessionId !== sessionId) throw new Error("不能补发其他会话");
  const replay = manager.getEventsAfter(sessionId, afterSeq);
  if (!replay) throw new Error(`会话不存在：${sessionId}`);
  client.lastSeq.set(sessionId, afterSeq);
  if (replay.requiresSnapshot) sendWs(client, { type: "resync_required", sessionId, currentSeq: replay.currentSeq });
  else {
    for (const event of replay.events) sendEvent(client, event);
    sendWs(client, { type: "replay_complete", sessionId, currentSeq: replay.currentSeq });
  }
}
