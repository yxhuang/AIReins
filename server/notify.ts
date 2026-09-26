import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { log } from "./logger.js";
import type { SessionRecord, UnifiedEvent } from "./types.js";

/** notify.json 中的 webhook 是密钥，不得写入日志。 */
export interface NotifyConfig {
  feishuWebhook: string;
  delaySeconds: number;
}

/** 文件不存在则关闭提醒；文件存在但无效时抛错，由启动入口记录。 */
export function loadNotifyConfig(path: string): NotifyConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} 不是有效 JSON`);
  }
  const { feishuWebhook, delaySeconds = 60 } = (value ?? {}) as Record<string, unknown>;
  if (typeof feishuWebhook !== "string" || !feishuWebhook.startsWith("https://")) {
    throw new Error(`${path}：feishuWebhook 必须是 https:// 开头的飞书机器人 webhook 地址`);
  }
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new Error(`${path}：delaySeconds 必须是不小于 0 的数字`);
  }
  return { feishuWebhook, delaySeconds };
}

export function gateLabel(payload: Record<string, unknown>): string {
  if (payload.interactionType === "ask_user_question") return "提问";
  return String(payload.toolName ?? payload.gate ?? "审批");
}

export function gateText(session: Pick<SessionRecord, "id" | "agent" | "cwd">, label: string, baseUrl?: string): string {
  const head = `[workbench] ${session.agent} @ ${basename(session.cwd)} 有闸门等你处理：${label}`;
  return baseUrl ? `${head}\n${baseUrl}/#/session/${encodeURIComponent(session.id)}` : head;
}

/** 挂起超过 delayMs 才提醒，同一会话按 cooldownMs 限频。 */
export class GateNotifier {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly lookup: (sessionId: string) => SessionRecord | undefined,
    private readonly delayMs: number,
    private readonly baseUrl?: string,
    private readonly cooldownMs = 60_000,
  ) {}

  handle(event: UnifiedEvent): void {
    const requestId = event.payload.requestId;
    if (event.type === "permission_request" && typeof requestId === "string") {
      const key = `${event.sessionId}\n${requestId}`;
      if (!this.timers.has(key)) this.schedule(key, event, this.delayMs);
    } else if (event.type === "permission_resolved" && typeof requestId === "string") {
      this.clear(`${event.sessionId}\n${requestId}`);
    } else if (event.type === "process_exited") {
      for (const key of this.timers.keys()) {
        if (key.startsWith(`${event.sessionId}\n`)) this.clear(key);
      }
    }
  }

  private schedule(key: string, event: UnifiedEvent, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.fire(key, event);
    }, delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  private clear(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  private async fire(key: string, event: UnifiedEvent): Promise<void> {
    const session = this.lookup(event.sessionId);
    if (!session || session.status === "dead") return;
    const now = Date.now();
    const wait = (this.lastSent.get(event.sessionId) ?? -Infinity) + this.cooldownMs - now;
    if (wait > 0) {
      this.schedule(key, event, wait);
      return;
    }
    this.lastSent.set(event.sessionId, now);
    try {
      await this.send(gateText(session, gateLabel(event.payload), this.baseUrl));
    } catch {
      // 发送错误可能带有完整请求 URL，不能把它写进日志。
      log("warn", "gate notification failed", { sessionId: event.sessionId });
    }
  }
}

/** 飞书自定义机器人返回 code:0 或旧格式 StatusCode:0。 */
export function feishuSender(webhook: string): (text: string) => Promise<void> {
  return async (text) => {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { code?: number; StatusCode?: number; msg?: string };
    const code = body.code ?? body.StatusCode ?? 0;
    if (!response.ok || code !== 0) {
      throw new Error(`飞书返回 HTTP ${response.status}，code ${code}${body.msg ? `：${body.msg}` : ""}`);
    }
  };
}
