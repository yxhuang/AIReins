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
