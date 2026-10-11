import { useEffect, useState } from "react";
import { fetchTaildropTargets } from "../api";
import type { TaildropTargetsResult } from "../../../server/tailscale-peers";
import { SidebarActionMenu, type SidebarMenuItem } from "./SidebarActionMenu";

/** 右键/长按文件行或预览「发送」按钮弹出：列出 Taildrop 可接收设备，当前访问的设备排第一并标「本机」；行菜单另在前面放 leadingItems。 */
export function TaildropMenu({ position, folder, leadingItems = [], onSend, onClose }: {
  position: { x: number; y: number }; folder: boolean; leadingItems?: SidebarMenuItem[];
  onSend: (ip: string, device: string) => void; onClose: (returnFocus?: boolean) => void;
}) {
  const [result, setResult] = useState<TaildropTargetsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchTaildropTargets(controller.signal).then(setResult, (reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, []);
  const items = (result?.targets ?? []).map((target, index) => ({
    divider: index === 0 && leadingItems.length > 0,
    id: target.ip, icon: "send" as const, label: `发送到 ${target.name}${target.self ? "（本机）" : ""}`,
    trailing: target.online ? undefined : "离线", disabled: !target.online, onSelect: () => onSend(target.ip, target.name),
  }));
  return <SidebarActionMenu position={position} label={leadingItems.length ? "文件操作" : "用 Taildrop 发送到设备"} items={[...leadingItems, ...items]} error={error ?? result?.reason ?? null} onClose={onClose}>
    {!result && !error && <p className="row-menu-note">正在读取 Taildrop 设备…</p>}
    {result && !result.reason && !items.length && <p className="row-menu-note">没有可接收文件的设备</p>}
    {folder && items.length > 0 && <p className="row-menu-note">文件夹会先打包成 zip 再发送</p>}
  </SidebarActionMenu>;
}
