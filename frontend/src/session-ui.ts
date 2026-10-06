/** 顶栏路径只保留末两段；完整值仍由组件放进 title。 */
export function compactCwd(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** 复用滚动事件判断，不为「回到最新」增加轮询。 */
export function awayFromLatest(height: number, top: number, viewport: number): boolean {
  return height - top - viewport > 120;
}

/** 正文提交后按既有贴底意图更新；阅读历史时不移动视口。 */
export function syncStreamViewport(container: { scrollHeight: number; scrollTop: number; clientHeight: number }, sticky: boolean): boolean {
  if (sticky) container.scrollTop = container.scrollHeight;
  return awayFromLatest(container.scrollHeight, container.scrollTop, container.clientHeight);
}

export function showComposerInterrupt(status: string, supported: boolean | undefined, processId: number | undefined, text: string): boolean {
  return status === "running" && Boolean(supported && processId && text.trim());
}

/** R 总是追加到末尾；空白输入保持原样，同一命令不重复追加。 */
export function appendRefineCommand(text: string, command: string): string {
  if (!text.trim()) return text;
  const trimmed = text.trimEnd();
  return trimmed.endsWith(command) ? trimmed : `${trimmed}\n${command}`;
}
