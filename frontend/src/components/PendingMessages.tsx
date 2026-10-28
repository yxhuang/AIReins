import { useState } from "react";
import { t } from "../i18n";
import { store } from "../store";
import { useStore } from "../useStore";

/** 未确认内容只由用户核对后恢复；写出 WS 不等于服务端接收。 */
export function PendingMessages({ sessionId }: { sessionId: string }) {
  useStore(value => value.pendingMessages(sessionId).map(message => `${message.id}:${message.restored}`).join("\n"));
  const [blocked, setBlocked] = useState(false);
  const messages = store.pendingMessages(sessionId);
  if (!messages.length) return null;
  return <div className="new-hint" role="status">
    <p>{t("core.pendingSend")}</p>
    {messages.map(message => <div key={message.id}>
      <details><summary>{t("core.pendingContent")}</summary><pre className="code-block">{message.text}</pre>
        {message.mentions?.map((mention, index) => <p key={index} className="mono">{mention.path}</p>)}
      </details>
      <button type="button" className="btn" disabled={message.restored} onClick={() => setBlocked(!store.restorePendingMessage(message.id))}>{t("core.restoreSend")}</button>
      <button type="button" className="btn" onClick={() => store.dismissPendingMessage(message.id)}>{t("core.dismissSend")}</button>
    </div>)}
    {blocked && <p role="alert">{t("core.restoreBlocked")}</p>}
  </div>;
}
