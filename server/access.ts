import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { log } from "./logger.js";

/** ~/.workbench/remote.json：手机经 Tailscale Serve 访问的入口配置（用户手写，server 只读）。 */
export interface RemoteConfig {
  /** 远程专用监听端口：同样只 bind 127.0.0.1，由 tailscale serve 转发进来 */
  port: number;
  /** 手机地址栏里的源，形如 https://my-desktop.tailxxxx.ts.net（全小写，无路径、无结尾斜杠） */
  origin: string;
  /** 允许的 Tailscale 登录名（Serve 注入的 Tailscale-User-Login 头） */
  allowedLogins: string[];
  /** 是否向这个入口开放用户自由终端；缺省关闭。 */
  terminal?: boolean;
}

export type AccessPolicy =
  | { kind: "local"; hosts: ReadonlySet<string>; origins: ReadonlySet<string> }
  | { kind: "remote"; hosts: ReadonlySet<string>; origin: string; logins: ReadonlySet<string> };

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** 本机入口：电脑浏览器直连本端口，或经 Vite 开发服务器（5173）代理过来。 */
export function localPolicy(port: number): AccessPolicy {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, "127.0.0.1:5173", "localhost:5173"];
  return { kind: "local", hosts: new Set(hosts), origins: new Set(hosts.map((host) => `http://${host}`)) };
}

/** Host：Serve 转发时可能保持 ts.net 域名，也可能改写成后端地址，两种都认。 */
export function remotePolicy(config: RemoteConfig): AccessPolicy {
  const hosts = [new URL(config.origin).host, `127.0.0.1:${config.port}`];
  return { kind: "remote", hosts: new Set(hosts), origin: config.origin, logins: new Set(config.allowedLogins) };
}

/**
 * 返回 null 表示放行，否则返回拒绝原因（直接显示给用户）。
 * 两个入口都先查 Host，挡 DNS 重绑定：恶意网页借重绑定连进来时，Host 是它自己的域名。
 * 本机：写操作和 WS 握手如果带 Origin，必须是本机页面（挡跨站伪造、WS 劫持）；
 *       不带 Origin 的是 curl / 脚本等本机进程，放行。
 * 远程：必须有 Serve 注入的身份头且在白名单里；写操作和 WS 握手必须带 Origin，且与配置的源完全相同。
 *       Serve 会剥掉客户端自带的同名头，所以经 Serve 来的身份头可信。绕过 Serve 直连这个端口的：
 *       网页过不了 Host 检查；本机进程能伪造头，但它们本来就能直连 8790，不扩大攻击面。
 */
export function checkAccess(
  policy: AccessPolicy,
  method: string,
  headers: IncomingHttpHeaders,
  isUpgrade: boolean,
): string | null {
  const origin = headers.origin;
  const host = (headers.host ?? "").toLowerCase();
  const mutating = isUpgrade || !SAFE_METHODS.has(method.toUpperCase());
  if (!policy.hosts.has(host)) return `Host 不在${policy.kind === "local" ? "本机" : "远程"}白名单：${host || "（空）"}`;
  if (policy.kind === "local") {
    if (mutating && origin !== undefined && !policy.origins.has(origin.toLowerCase())) {
      return `Origin 不在本机白名单：${origin}`;
    }
    return null;
  }
  const login = headers["tailscale-user-login"];
  if (typeof login !== "string" || login === "") {
    return "没有 Tailscale 身份：请用 tailscale serve 给出的 https://…ts.net 地址访问";
  }
  if (!policy.logins.has(login)) {
    return `Tailscale 账号 ${login} 未授权：把它加进 ~/.workbench/remote.json 的 allowedLogins，然后 wb restart`;
  }
  if (mutating && origin !== policy.origin) return `Origin 不匹配：${origin ?? "（空）"}，应为 ${policy.origin}`;
  return null;
}

/** 文件不存在 → null（不开远程入口）；内容不合法 → 抛错，由调用方记日志。 */
export function loadRemoteConfig(path: string, localPort: number): RemoteConfig | null {
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
  const { port, origin, allowedLogins, terminal } = (value ?? {}) as Record<string, unknown>;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535 || port === localPort) {
    throw new Error(`${path}：port 必须是 1–65535 的整数，且不能等于本机端口 ${localPort}`);
  }
  if (typeof origin !== "string" || !isTailnetOrigin(origin)) {
    throw new Error(`${path}：origin 必须形如 https://<机器名>.<tailnet>.ts.net（全小写，不带路径和结尾斜杠）`);
  }
  if (
    !Array.isArray(allowedLogins) ||
    allowedLogins.length === 0 ||
    !allowedLogins.every((login) => typeof login === "string" && login !== "")
  ) {
    throw new Error(`${path}：allowedLogins 必须是非空的字符串数组`);
  }
  if (terminal !== undefined && typeof terminal !== "boolean") {
    log("warn", "remote.json terminal 类型无效，终端保持关闭", { path });
  }
  return {
    port, origin, allowedLogins,
    ...(terminal !== undefined ? { terminal: terminal === true } : {}),
  };
}

/** https://<机器名>.<tailnet>.ts.net 这种规范写法（tailscale serve 只给 ts.net 域名签证书）。 */
function isTailnetOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}
