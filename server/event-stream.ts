import { withMessageMetadata } from "./i18n/messages.js";
import { WebSocket } from "ws";
import type { SessionManager } from "./session-manager.js";
import type { UnifiedEvent } from "./types.js";

const REPLAY_MAX_BYTES = 512 * 1024;

export interface EventClient {
  socket: Pick<WebSocket, "readyState" | "send" | "bufferedAmount" | "terminate">;
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
  if (client.socket.readyState !== WebSocket.OPEN) return;
  if (client.socket.bufferedAmount > 1024 * 1024) { client.socket.terminate(); return; }
  client.socket.send(JSON.stringify(withMessageMetadata(value)));
}

/** 在全局 WS 上按会话游标补发，实时帧与补发交错由客户端去重。 */
export function replaySession(manager: Pick<SessionManager, "getEventsAfter">, client: EventClient, sessionId: string, afterSeq: number): void {
  if (client.sessionId && client.sessionId !== sessionId) throw new Error("不能补发其他会话");
  const replay = manager.getEventsAfter(sessionId, afterSeq);
  if (!replay) throw new Error(`会话不存在：${sessionId}`);
  client.lastSeq.set(sessionId, afterSeq);
  const resync = { type: "resync_required", sessionId, currentSeq: replay.currentSeq };
  if (replay.requiresSnapshot) { sendWs(client, resync); return; }
  const complete = { type: "replay_complete", sessionId, currentSeq: replay.currentSeq };
  const frames: { event: UnifiedEvent; json: string }[] = [];
  let bytes = client.socket.bufferedAmount + Buffer.byteLength(JSON.stringify(complete));
  for (const event of replay.events) {
    const json = JSON.stringify(withMessageMetadata(event));
    bytes += Buffer.byteLength(json);
    // Leave room for framing/control messages below the slow-client disconnect limit.
    if (bytes > REPLAY_MAX_BYTES) { sendWs(client, resync); return; }
    frames.push({ event, json });
  }
  for (const { event, json } of frames) {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(json);
    client.lastSeq.set(sessionId, event.seq);
  }
  sendWs(client, complete);
}
