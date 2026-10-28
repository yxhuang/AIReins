// 较长的流式 Markdown 暂用纯文本；结束后一次完整解析，保留跨块围栏、表格等语义。
export const STREAMING_MARKDOWN_PLAIN_TEXT_THRESHOLD = 16 * 1024;

/** Fixed window throttle; stop publishes the exact final text synchronously. */
export function createStreamingTextThrottle(publish: (text: string) => void) {
  let latest = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    update(text: string, streaming: boolean) {
      latest = text;
      if (!streaming) { cancel(); publish(text); }
      else if (timer === undefined) timer = setTimeout(() => { timer = undefined; publish(latest); }, 100);
    },
    cancel,
  };
}
