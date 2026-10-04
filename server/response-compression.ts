import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/** gzip 必须被显式接受；q=0（含 0.0）表示客户端禁止该编码。 */
export function acceptsGzip(header: string): boolean {
  return header.split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().split(";");
    return encoding.toLowerCase() === "gzip"
      && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/i.test(parameter.trim()));
  });
}

/** 单进程压缩并发为 1；失败释放队列，后续请求仍可继续。 */
export function createGzipQueue(compress: (json: string) => Promise<Buffer> = (json) => gzipAsync(json, { level: 1 })) {
  let tail: Promise<unknown> = Promise.resolve();
  return (json: string): Promise<Buffer> => {
    const pending = tail.then(() => compress(json));
    tail = pending.catch(() => undefined);
    return pending;
  };
}

export const compressResponse = createGzipQueue();
