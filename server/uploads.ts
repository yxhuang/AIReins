import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { workbenchHome } from "./persistence.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** 发送帧里 image mention 的上限（与各家 vision 输入的实用边界对齐） */
export const MAX_IMAGE_MENTION_BYTES = 10 * 1024 * 1024;
export const IMAGE_MENTION_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class UploadError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) {
    super(message);
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/** 按扩展名判断 mimeType；未知扩展返回 application/octet-stream。 */
export function mimeTypeForName(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** 清洗上传文件名：basename、去路径分隔符与控制字符、限长；洗空时回退 file。 */
export function sanitizeUploadName(raw: string): string {
  // basename 只认 POSIX 分隔符，Windows 风格反斜杠也要先剥掉
  let name = basename(raw.replace(/\\/g, "/"));
  // 控制字符（含 NUL）与路径分隔符替换为下划线
  name = name.replace(/[\u0000-\u001f\u007f/]/g, "_");
  // 去掉首尾部点与空白（防 ..、隐藏文件歧义、结尾空格）
  name = name.replace(/^[.\s]+|[.\s]+$/g, "");
  if (name.length > 120) {
    const ext = extname(name);
    name = name.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  return name || "file";
}

/** 落盘时间戳前缀（本地时区），形如 20260930-153012。 */
export function uploadTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function uploadsRoot(): string {
  return join(workbenchHome, "uploads");
}

/** 同秒同名冲突时在时间戳后追加 -1、-2 … */
function availablePath(dir: string, stamp: string, name: string): string {
  for (let index = 0; ; index++) {
    const candidate = join(dir, `${stamp}${index === 0 ? "" : `-${index}`}-${name}`);
    if (!existsSync(candidate)) return candidate;
  }
}

export interface SavedUpload {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/**
 * 把请求字节流存进 ~/.workbench/uploads/<sessionId>/<时间戳>-<清洗名>。
 * 超过 25 MB 时中断并删除半截文件，抛 413 UploadError；写入失败同样清理。
 */
export async function saveUpload(sessionId: string, rawName: string, body: Readable): Promise<SavedUpload> {
  const name = sanitizeUploadName(rawName);
  const dir = join(uploadsRoot(), sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = availablePath(dir, uploadTimestamp(), name);
  let size = 0;
  let failed: Error | null = null;
  const writer = createWriteStream(path, { mode: 0o600 });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      body.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          if (!failed) {
            failed = new UploadError(413, 41301, `附件超过 25 MB 上限（${name}）`);
            writer.destroy();
          }
          return; // 超限后丢弃剩余字节，让客户端把请求体发完再收 413
        }
        if (failed) return;
        if (!writer.write(chunk)) body.pause();
      });
      writer.on("drain", () => {
        if (!failed) body.resume();
      });
      body.on("end", () => {
        if (failed) reject(failed);
        else writer.end();
      });
      body.on("error", (error) => {
        failed = failed ?? error;
        writer.destroy();
        reject(failed);
      });
      writer.on("error", (error) => {
        failed = failed ?? error;
        reject(failed);
      });
      writer.on("finish", () => resolvePromise());
    });
  } catch (error) {
    await rm(path, { force: true });
    throw failed ?? error;
  }
  return { path, name, size, mimeType: mimeTypeForName(name) };
}

/**
 * /api/uploads/file 的路径收敛：realpath 后必须落在 uploadsRoot 之内且是普通文件，
 * 防 .. 与符号链接逃逸。不存在或越界都返回 null。
 */
export async function resolveUploadFile(rawPath: string): Promise<{ path: string; mimeType: string } | null> {
  if (!rawPath || rawPath.includes("\u0000")) return null;
  const root = resolve(uploadsRoot());
  let real: string;
  try {
    real = await realpath(rawPath);
  } catch {
    return null;
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) return null;
  try {
    if (!(await stat(real)).isFile()) return null;
  } catch {
    return null;
  }
  return { path: real, mimeType: mimeTypeForName(basename(real)) };
}
