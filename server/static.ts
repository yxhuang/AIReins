import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ServerResponse } from "node:http";

export function serveStatic(staticRoot: string, pathname: string, response: ServerResponse, acceptEncoding = ""): boolean {
  if (!existsSync(staticRoot)) return false;
  const relative = pathname === "/" ? "/index.html" : pathname;
  let path = resolve(staticRoot, `.${relative}`);
  if (!path.startsWith(`${staticRoot}/`) && path !== staticRoot) return false;
  if ((!existsSync(path) || statSync(path).isDirectory()) && existsSync(resolve(staticRoot, "index.html"))) {
    path = resolve(staticRoot, "index.html");
  }
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  // 只有 assets/ 下的文件名带内容哈希，可以永久缓存；其余（index.html、图标、manifest）文件名固定，每次回源确认。
  const immutable = path.startsWith(`${staticRoot}/assets/`);
  const gzip = acceptEncoding.split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().split(";");
    return encoding.toLowerCase() === "gzip" && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()));
  }) && existsSync(`${path}.gz`);
  response.writeHead(200, {
    "vary": "accept-encoding",
    ...(gzip ? { "content-encoding": "gzip" } : {}),
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  });
  createReadStream(gzip ? `${path}.gz` : path).pipe(response);
  return true;
}
