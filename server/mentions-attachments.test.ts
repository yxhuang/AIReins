import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "./drivers/claude.js";
import { CodexDriver } from "./drivers/codex.js";
import { KimiDriver } from "./drivers/kimi.js";
import type { DriverCallbacks, UnifiedEvent } from "./types.js";

// 图片与二进制/超大文件引用在三家 driver 的翻译契约（无真实 CLI，打桩 stdin 抓帧）。

const fixture = await mkdtemp(join(tmpdir(), "workbench-mention-attachments-test-"));
const png = join(fixture, "pic.png");
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const text = join(fixture, "note.txt");
const binary = join(fixture, "report.pdf");
const bigText = join(fixture, "big.txt");
await writeFile(png, pngBytes);
await writeFile(text, "普通文本内容");
await writeFile(binary, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]));
await writeFile(bigText, "a".repeat(1024 * 1024 + 1));

function makeDriver<D extends ClaudeDriver | CodexDriver | KimiDriver>(
  Ctor: new (options: any) => D,
  patch: (driver: D) => void,
): { driver: D; sent: Record<string, any>[] } {
  const sent: Record<string, any>[] = [];
  const callbacks: DriverCallbacks = {
    emit: () => undefined as UnifiedEvent | undefined,
    metadata: () => undefined,
    commands: () => undefined,
    status: () => undefined,
    exited: () => undefined,
  };
  const driver = new Ctor({ sessionId: "test", cwd: fixture, config: {}, callbacks });
  (driver as unknown as { child: ChildProcessWithoutNullStreams }).child = {
    stdin: { writable: true, write: (line: string) => { sent.push(JSON.parse(line)); return true; } },
  } as unknown as ChildProcessWithoutNullStreams;
  patch(driver);
  return { driver, sent };
}

try {
  // Claude：image → base64 image block；文本文件 → document；二进制/超大 → 文本末尾降级行，不抛错
  {
    const { driver, sent } = makeDriver(ClaudeDriver, () => undefined);
    await driver.sendUserMessage({
      text: "看附件",
      mentions: [
        { type: "image", path: png, mimeType: "image/png" },
        { type: "file", path: text },
        { type: "file", path: binary },
        { type: "file", path: bigText },
      ],
    });
    const frame = sent.at(-1)!;
    assert.equal(frame.type, "user");
    const content = frame.message.content as Record<string, any>[];
    const textBlock = content.find((block) => block.type === "text")!;
    assert.ok(textBlock.text.startsWith("看附件\n"), "原文本在最前");
    assert.ok(textBlock.text.includes(`[附件] ${binary}（二进制或超过 1 MiB，未嵌入，请用工具读取）`), "二进制降级行");
    assert.ok(textBlock.text.includes(`[附件] ${bigText}（二进制或超过 1 MiB，未嵌入，请用工具读取）`), "超大文本降级行");
    const imageBlock = content.find((block) => block.type === "image")!;
    assert.deepEqual(imageBlock.source, { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") });
    const documents = content.filter((block) => block.type === "document");
    assert.equal(documents.length, 1, "只有可嵌入文本发 document");
    assert.equal(documents[0].source.data, "普通文本内容");
    // 无文本、只有二进制附件时也能发（降级行就是文本）
    await driver.sendUserMessage({ mentions: [{ type: "file", path: binary }] });
    const onlyBinary = sent.at(-1)!.message.content as Record<string, any>[];
    assert.equal(onlyBinary.length, 1);
    assert.equal(onlyBinary[0].type, "text");
    assert.ok(String(onlyBinary[0].text).includes("[附件]"));
  }

  // Kimi：image → ACP image content；文本文件 → embedded resource；二进制 → 降级行进文本
  {
    const { driver, sent } = makeDriver(KimiDriver, (d) => {
      (d as unknown as { nativeSessionId: string }).nativeSessionId = "session_test";
    });
    await driver.sendUserMessage({
      text: "看附件",
      mentions: [
        { type: "image", path: png, mimeType: "image/webp" },
        { type: "file", path: text },
        { type: "file", path: binary },
      ],
    });
    const prompt = sent.at(-1)!.params.prompt as Record<string, any>[];
    const textBlock = prompt.find((block) => block.type === "text")!;
    assert.ok(textBlock.text.startsWith("看附件\n"));
    assert.ok(textBlock.text.includes(`[附件] ${binary}（二进制或超过 1 MiB，未嵌入，请用工具读取）`));
    const imageBlock = prompt.find((block) => block.type === "image")!;
    assert.equal(imageBlock.mimeType, "image/webp");
    assert.equal(imageBlock.data, pngBytes.toString("base64"));
    const resources = prompt.filter((block) => block.type === "resource");
    assert.equal(resources.length, 1);
    assert.equal(resources[0].resource.text, "普通文本内容");
  }

  // Codex：image → localImage（schema 核对见 spikes/PROTOCOL-NOTES.md）；文件引用仍是 mention + text_elements
  {
    const { driver, sent } = makeDriver(CodexDriver, (d) => {
      (d as unknown as { threadId: string }).threadId = "thread_test";
    });
    await driver.sendUserMessage({
      text: "看附件 @note.txt",
      mentions: [
        { type: "image", path: png, mimeType: "image/png" },
        { type: "file", path: text },
        { type: "file", path: binary },
      ],
    });
    const input = sent.at(-1)!.params.input as Record<string, any>[];
    const localImages = input.filter((item) => item.type === "localImage");
    assert.deepEqual(localImages, [{ type: "localImage", path: png }]);
    const mentions = input.filter((item) => item.type === "mention");
    assert.deepEqual(mentions.map((item) => item.path), [text, binary], "Codex 文件引用只传路径，二进制不变");
    const textItem = input.find((item) => item.type === "text")!;
    assert.equal(textItem.text_elements.length, 2, "图片不占 text_elements 占位");
  }

  console.log("✅ 三家 driver 附件翻译测试全过");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
