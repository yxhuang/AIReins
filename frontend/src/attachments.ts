import type { Mention } from "./types";

// 「+」附件的纯逻辑：图片重编码判定、附件状态类型、附件 → 上行 mention 的转换。
// 只有 prepareImageForUpload 依赖 DOM（createImageBitmap/canvas），且只在浏览器里被 Composer 调用。

/** 上行帧 image mention 支持的类型（与后端 uploads.ts 的白名单一致）。 */
const IMAGE_MENTION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 超过该体积的图片先压缩再传（移动网络与 25MB 上限之间的经验阈值）。 */
export const REENCODE_SIZE_THRESHOLD = 3.5 * 1024 * 1024;

/** 重编码后图片长边上限（px）。 */
const REENCODE_MAX_EDGE = 2048;

export interface PreparedFile {
  blob: Blob;
  name: string;
  type: string;
}

/** 图片需要重编码：体积超阈值，或类型不在 image mention 白名单（如 HEIC）。非图片一律不需要。 */
export function needsImageReencode(mimeType: string, size: number): boolean {
  if (!mimeType.startsWith("image/")) return false;
  return size > REENCODE_SIZE_THRESHOLD || !IMAGE_MENTION_TYPES.has(mimeType);
}

/**
 * 上传前的图片预处理：needsImageReencode 为 true 时把长边缩到 ≤2048px 并转 JPEG（quality 0.85），
 * 扩展名改 .jpg；解码/绘制失败（不支持的格式等）原样返回，交给后端按原文件处理。
 */
export async function prepareImageForUpload(file: PreparedFile): Promise<PreparedFile> {
  if (!needsImageReencode(file.type, file.blob.size)) return file;
  try {
    const bitmap = await createImageBitmap(file.blob);
    try {
      const scale = Math.min(1, REENCODE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (!blob) return file;
      const base = file.name.replace(/\.[^./\\]+$/, "") || "image";
      return { blob, name: `${base}.jpg`, type: "image/jpeg" };
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

/** 输入框上方附件条的一张卡片。 */
export interface Attachment {
  id: string;
  /** upload = 已传到 ~/.workbench/uploads；local = 直接引用电脑上的绝对路径（不上传） */
  source: "upload" | "local";
  name: string;
  status: "uploading" | "ready" | "error";
  path?: string;
  mimeType?: string;
  size?: number;
  /** 上传图片的本地预览（createObjectURL）；移除卡片/组件卸载时必须 revoke */
  previewUrl?: string;
  error?: string;
}

/** 「电脑上的文件」按扩展名猜图片类型；非图片返回 undefined（按 file mention 发送）。 */
export function localImageMimeType(name: string): string | undefined {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

/** ready 附件 → 上行 mention；uploading/error 一律返回 null（不进发送帧）。 */
export function attachmentMention(attachment: Attachment): Mention | null {
  if (attachment.status !== "ready" || !attachment.path) return null;
  if (attachment.mimeType && IMAGE_MENTION_TYPES.has(attachment.mimeType)) {
    return { type: "image", path: attachment.path, mimeType: attachment.mimeType, name: attachment.name };
  }
  return { type: "file", path: attachment.path, name: attachment.name };
}
