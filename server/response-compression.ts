import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

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
