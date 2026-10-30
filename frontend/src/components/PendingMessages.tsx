import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { store } from "../store";
import { useStore } from "../useStore";

/** 未确认内容只由用户核对后恢复；写出 WS 不等于服务端接收。 */
export function PendingMessages({ sessionId }: { sessionId: string }) {
  useStore(value => value.pendingMessages(sessionId).map(message => `${message.id}:${message.restored}`).join("\n"));
  const [blocked, setBlocked] = useState(false);
  const [, refresh] = useState(0);
  const now = Date.now();
  const pending = store.pendingMessages(sessionId);
  const nextNoticeAt = Math.min(...pending.map(message => message.sentAt + 5000).filter(at => at > now));
  useEffect(() => {
    if (!Number.isFinite(nextNoticeAt)) return;
    const timer = window.setTimeout(() => refresh(value => value + 1), Math.max(0, nextNoticeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextNoticeAt]);
  const messages = pending.filter(message => now - message.sentAt >= 5000);
  if (!messages.length) return null;
  const content = <div className="pending-message-notice" role="status">
    <p>{t("core.pendingSend")}</p>
    {messages.map(message => <div className="pending-message-item" key={message.id}>
      <details><summary>{t("core.pendingContent")}</summary><pre className="code-block">{message.text}</pre>
        {message.mentions?.map((mention, index) => <p key={index} className="mono">{mention.path}</p>)}
      </details>
      <div className="pending-message-actions">
        <button type="button" className="btn" disabled={message.restored} onClick={() => setBlocked(!store.restorePendingMessage(message.id))}>{t("core.restoreSend")}</button>
        <button type="button" className="btn" onClick={() => store.dismissPendingMessage(message.id)}>{t("core.dismissSend")}</button>
      </div>
    </div>)}
    {blocked && <p role="alert">{t("core.restoreBlocked")}</p>}
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
