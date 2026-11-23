import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { setImmediate as yieldToServer } from "node:timers/promises";
import { gzip, gunzipSync } from "node:zlib";

const MAGIC = Buffer.from("WBNDZ001");
const HEADER_BYTES = MAGIC.length + 8;
const BLOCK_BYTES = 1024 * 1024;
const compress = promisify(gzip);
export const ARCHIVE_TEMP_PATTERN = /^\.[a-zA-Z0-9_-]+\.ndjson\.wb-archive-[a-f0-9-]+\.tmp$/;

export interface TranscriptInput {
  archived: boolean;
  size: number;
  read(target: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

export function readFully(input: TranscriptInput, target: Buffer, position: number): void {
  let offset = 0;
  while (offset < target.length) {
    const count = input.read(target, offset, target.length - offset, position + offset);
    if (!count) throw new Error("Incomplete transcript archive");
    offset += count;
  }
}

/** Independent gzip blocks preserve NDJSON byte offsets for the existing history pager. */
export function openTranscriptInput(path: string): TranscriptInput {
  const fd = openSync(path, "r");
  try {
    const plain: TranscriptInput = {
      archived: false, size: fstatSync(fd).size,
      read: (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
      close: () => closeSync(fd),
    };
    if (plain.size < MAGIC.length) return plain;
    const magic = Buffer.alloc(MAGIC.length);
    readFully(plain, magic, 0);
    if (!magic.equals(MAGIC)) return plain;
    const sizeBytes = Buffer.alloc(8);
    readFully(plain, sizeBytes, MAGIC.length);
    const size = Number(sizeBytes.readBigUInt64LE());
    const blockCount = Math.ceil(size / BLOCK_BYTES);
    if (!Number.isSafeInteger(size) || size <= 0 || blockCount > (plain.size - HEADER_BYTES) / 24) {
      throw new Error("Invalid transcript archive size");
    }
    const blocks: { offset: number; length: number }[] = [];
    const lengthBytes = Buffer.alloc(4);
    let position = HEADER_BYTES;
    for (let index = 0; index < blockCount; index++) {
      readFully(plain, lengthBytes, position);
      const length = lengthBytes.readUInt32LE();
      position += lengthBytes.length;
      if (length < 20 || length > BLOCK_BYTES + 1024 || position + length > plain.size) {
        throw new Error("Invalid transcript archive block");
      }
      blocks.push({ offset: position, length });
      position += length;
    }
    if (position !== plain.size) throw new Error("Unexpected bytes after transcript archive");
    let cachedIndex = -1;
    let cached = Buffer.alloc(0);
    return {
      archived: true, size, close: plain.close,
      read(target, offset, length, start) {
        const end = Math.min(size, start + length);
        for (let position = start; position < end;) {
          const index = Math.floor(position / BLOCK_BYTES);
          const blockOffset = position % BLOCK_BYTES;
          if (index !== cachedIndex) {
            const block = blocks[index]!;
            const bytes = Buffer.allocUnsafe(block.length);
            readFully(plain, bytes, block.offset);
            const expected = Math.min(BLOCK_BYTES, size - index * BLOCK_BYTES);
            cached = gunzipSync(bytes, { maxOutputLength: expected });
            if (cached.length !== expected) throw new Error("Invalid uncompressed transcript block size");
            cachedIndex = index;
          }
          const count = Math.min(cached.length - blockOffset, end - position);
          cached.copy(target, offset + position - start, blockOffset, blockOffset + count);
          position += count;
        }
        return Math.max(0, end - start);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readTranscriptText(path: string): string {
  const input = openTranscriptInput(path);
  try {
    if (!input.archived) return readFileSync(path, "utf8");
    const bytes = Buffer.allocUnsafe(input.size);
    readFully(input, bytes, 0);
    return bytes.toString("utf8");
  } finally { input.close(); }
}

function temporaryPath(path: string): string {
  const name = basename(path);
  const original = ARCHIVE_TEMP_PATTERN.test(name) ? name.substring(1, name.indexOf(".wb-archive-")) : name;
  return join(dirname(path), `.${original}.wb-archive-${randomUUID()}.tmp`);
}

export function replaceTranscriptLines(path: string, lines: Iterable<string>): void {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error("Cannot replace a non-regular transcript");
  const temporary = temporaryPath(path);
  const fd = openSync(temporary, "wx", before.mode & 0o777);
  try {
    try {
      for (const line of lines) writeFileSync(fd, line);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (!sameVersion(before, path)) throw new Error("Transcript changed during restore");
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

export function sameVersion(before: Stats, path: string): boolean {
  try {
    const current = lstatSync(path);
    return current.isFile() && current.dev === before.dev && current.ino === before.ino
      && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Applies a reversible line representation before running the existing archive codec. */
export async function rewriteArchivedTranscript(
  path: string,
  rewrite: (line: Buffer) => Buffer | undefined,
  mayReplace: () => boolean,
): Promise<number> {
  const before = lstatSync(path);
  if (!before.isFile()) return 0;
  const input = openTranscriptInput(path);
  const temporary = temporaryPath(path);
  let created = false;
  try {
    const target = await open(temporary, "wx", before.mode & 0o777);
    created = true;
    let changed = false;
    try {
      let buffered: Buffer[] = [];
      let bytes = 0;
      for (const { bytes: line } of transcriptLines(input)) {
        const replacement = rewrite(line);
        changed ||= !!replacement;
        buffered.push(replacement ?? line);
        bytes += buffered.at(-1)!.length;
        if (bytes < BLOCK_BYTES) continue;
        if (!mayReplace()) return 0;
        await target.writeFile(Buffer.concat(buffered, bytes));
        buffered = [];
        bytes = 0;
      }
      if (!changed) return 0;
      if (bytes) await target.writeFile(Buffer.concat(buffered, bytes));
      await target.sync();
    } finally { await target.close(); }
    await archiveTranscript(temporary, mayReplace);
    const bytes = lstatSync(temporary).size;
    if (bytes >= before.size || !mayReplace() || !sameVersion(before, path)) return 0;
    renameSync(temporary, path);
    created = false;
    return before.size - bytes;
  } finally {
    input.close();
    if (created) unlinkSync(temporary);
  }
}

export function* transcriptLines(input: Pick<TranscriptInput, "read"> | number): Generator<{ bytes: Buffer; offset: number }> {
  let parts: Buffer[] = [];
  let position = 0;
  let offset = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const size = typeof input === "number" ? readSync(input, chunk, 0, chunk.length, position)
      : input.read(chunk, 0, chunk.length, position);
    if (!size) break;
    position += size;
    const bytes = chunk.subarray(0, size);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      const segment = bytes.subarray(start, end + 1);
      const line = parts.length ? Buffer.concat([...parts, segment]) : segment;
      parts = [];
      yield { bytes: line, offset };
      offset += line.length;
      start = end + 1;
    }
    if (start < bytes.length) parts.push(bytes.subarray(start));
  }
  if (parts.length) yield { bytes: Buffer.concat(parts), offset };
}

export async function indexTranscriptLines<T>(input: TranscriptInput, visit: (bytes: Buffer, offset: number) => T,
  keepReading: () => boolean): Promise<boolean> {
  let nextYield = 0;
  for (const { bytes, offset } of transcriptLines(input)) {
    if (offset >= nextYield) {
      if (!keepReading()) return false;
      nextYield = offset + BLOCK_BYTES;
      await yieldToServer();
    }
    visit(bytes, offset);
  }
  return true;
}

export async function archiveTranscript(path: string, mayReplace: () => boolean): Promise<number> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const temporary = temporaryPath(path);
  let created = false;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size < HEADER_BYTES) return 0;
    const magic = Buffer.alloc(MAGIC.length);
    await source.read(magic, 0, magic.length, 0);
    if (magic.equals(MAGIC)) return 0;
    const target = await open(temporary, "wx", before.mode & 0o777);
    created = true;
    let bytes = HEADER_BYTES;
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      MAGIC.copy(header);
      header.writeBigUInt64LE(BigInt(before.size), MAGIC.length);
      await target.writeFile(header);
      const input = Buffer.allocUnsafe(BLOCK_BYTES);
      for (let position = 0; position < before.size; position += BLOCK_BYTES) {
        if (!mayReplace()) return 0;
        const size = Math.min(BLOCK_BYTES, before.size - position);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await source.read(input, offset, size - offset, position + offset);
          if (!bytesRead) return 0;
          offset += bytesRead;
        }
        const block = await compress(input.subarray(0, size), { level: 1 });
        const length = Buffer.alloc(4);
        length.writeUInt32LE(block.length);
        await target.writeFile(Buffer.concat([length, block]));
        bytes += length.length + block.length;
      }
      if (bytes >= before.size) return 0;
      await target.sync();
    } finally { await target.close(); }
    if (!mayReplace() || !sameVersion(before, path)) return 0;
    renameSync(temporary, path);
    created = false;
    return before.size - bytes;
  } finally {
    await source.close();
    if (created) unlinkSync(temporary);
  }
}

/** Writes continue as ordinary NDJSON. Keep the compressed copy until the replacement is durable. */
export function unpackTranscriptForAppend(path: string): boolean {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error("Cannot unpack a non-regular transcript");
  let input: TranscriptInput;
  try { input = openTranscriptInput(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const temporary = temporaryPath(path);
  let created = false;
  try {
    if (!input.archived) return false;
    const target = openSync(temporary, "wx", before.mode & 0o777);
    created = true;
    try {
      const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
      for (let position = 0; position < input.size; position += BLOCK_BYTES) {
        const block = buffer.subarray(0, Math.min(BLOCK_BYTES, input.size - position));
        readFully(input, block, position);
        writeFileSync(target, block);
      }
      fsyncSync(target);
    } finally { closeSync(target); }
    if (!sameVersion(before, path)) throw new Error("Transcript changed during unpack");
    renameSync(temporary, path);
    created = false;
    return true;
  } finally {
    input.close();
    if (created) unlinkSync(temporary);
  }
}
