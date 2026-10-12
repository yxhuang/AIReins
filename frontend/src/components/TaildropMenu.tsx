import { t } from "../i18n";
import { useEffect, useState } from "react";
import { fetchTaildropTargets } from "../api";
import type { TaildropTargetsResult } from "../../../server/tailscale-peers";
import { SidebarActionMenu, type SidebarMenuItem } from "./SidebarActionMenu";

/** 右键/长按文件行或预览「发送」按钮弹出：列出 Taildrop 可接收设备，当前访问的设备排第一并标「本机」；行菜单另在前面放 leadingItems。 */
export function TaildropMenu({ position, folder, enabled = true, leadingItems = [], onSend, onClose }: {
  position: { x: number; y: number }; folder: boolean; enabled?: boolean; leadingItems?: SidebarMenuItem[];
  onSend: (ip: string, device: string) => void; onClose: (returnFocus?: boolean) => void;
}) {
  const [result, setResult] = useState<TaildropTargetsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchTaildropTargets(controller.signal).then(setResult, (reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [enabled]);
  const items = (enabled ? result?.targets ?? [] : []).map((target, index) => ({
    divider: index === 0 && leadingItems.length > 0,
    id: target.ip, icon: "send" as const, label: t("ui.TaildropMenu.send_to", { p0: (target.name), p1: (target.self ? t("ui.TaildropMenu.local_detail") : "") }),
    trailing: target.online ? undefined : t("ui.common.offline"), disabled: !target.online, onSelect: () => onSend(target.ip, target.name),
  }));
  return <SidebarActionMenu position={position} label={leadingItems.length ? t("ui.common.file_actions") : t("ui.TaildropMenu.send_to_device_with_taildrop")} items={[...leadingItems, ...items]} error={error ?? result?.reason ?? null} onClose={onClose}>
    {enabled && !result && !error && <p className="row-menu-note">{t("ui.TaildropMenu.reading_taildrop_devices")}</p>}
    {result && !result.reason && !items.length && <p className="row-menu-note">{t("ui.TaildropMenu.no_devices_available_to_receive_files")}</p>}
    {folder && items.length > 0 && <p className="row-menu-note">{t("ui.TaildropMenu.folders_will_be_zipped_before_sending")}</p>}
  </SidebarActionMenu>;
}
