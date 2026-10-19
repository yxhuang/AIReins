#!/usr/bin/env node
import { strict as assert } from "node:assert";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage, MessageLink } from "../src/components/MarkdownMessage.tsx";
import { HistoryTimeline } from "../src/components/HistoryTimeline.tsx";
import { FilePreview } from "../src/components/FilePreview.tsx";
import { store } from "../src/store.ts";
globalThis.React = React;

const render = (text) => renderToStaticMarkup(createElement(MarkdownMessage, { text }));
const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
assert.doesNotMatch(html, /<script\b/i);
assert.doesNotMatch(html, /onerror\s*=/i);
assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);

const link = render('[普通链接](https://example.com)');
assert.match(link, /target="_blank"/);
assert.match(link, /rel="noopener noreferrer"/);
const local = renderToStaticMarkup(createElement(MarkdownMessage, { text: '[源码](file:///home/u/a.ts:12) [相对](src/a.ts) [网页](https://example.com)', cwd: '/home/u', sessionId: 'one' }));
assert.match(local, /title="打开文件：\/home\/u\/a.ts"/);
assert.match(local, /title="打开文件：\/home\/u\/src\/a.ts"/);
assert.match(local, /href="https:\/\/example.com" target="_blank"/);
const history = renderToStaticMarkup(createElement(HistoryTimeline, { agent: "codex", cwd: "/repo", sessionId: "one", messages: [{ role: "assistant", text: "[恢复历史文件](README.md)", timestamp: "2026-10-04T00:00:00Z" }] }));
assert.match(history, /title="打开文件：\/repo\/README.md"/);
console.log("✅ Markdown XSS 与普通链接属性");

const draft = '[材料](<证明材料/01_中文 空格.pdf>) [上级](../shared.pdf) [文件](file:///tmp/a.pdf) [网页](https://example.com) [锚点](#title) [危险](javascript:alert%281%29) [无效](bad%ZZ.pdf) ![图片](https://example.com/image.png)';
const preview = { target: { path: '/repo/docs/说明.md', root: '/repo', sessionId: 'one' },
  file: { path: '/repo/docs/说明.md', name: '说明.md', kind: 'markdown', text: draft, editable: true, size: draft.length, mimeType: 'text/markdown', version: 'v1' },
  draft, loadId: 1, loading: false, saving: false, error: null };
const previewHtml = renderToStaticMarkup(createElement(FilePreview, { preview }));
assert.match(previewHtml, /title="打开文件：\/repo\/docs\/证明材料\/01_中文 空格.pdf"/);
assert.match(previewHtml, /title="打开文件：\/repo\/shared.pdf"/);
assert.match(previewHtml, /title="打开文件：\/tmp\/a.pdf"/);
assert.match(previewHtml, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
assert.doesNotMatch(previewHtml, /<a[^>]*>锚点<\/a>|<a[^>]*>危险<\/a>|<a[^>]*>无效<\/a>|<img\b/);
assert.match(previewHtml, /图片/);
console.log("✅ 文件 Markdown 链接按所在目录解析、外链安全新标签、无效链接与图片不导航");

// 沿用现有 hook fixture 模式，直接执行共享组件的真实点击处理。
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals.H, previousOpen = store.openFilePreview;
try {
  internals.H = { useContext: () => ({ cwd: '/repo/docs', root: preview.target.root, sessionId: preview.target.sessionId }) };
  let opened, prevented;
  store.openFilePreview = async target => { opened = target; };
  for (const [href, path, root] of [
    ['证明材料/01_中文 空格.pdf', '/repo/docs/证明材料/01_中文 空格.pdf', '/repo'],
    ['../shared.pdf', '/repo/shared.pdf', '/repo'],
    ['../../outside.pdf', '/outside.pdf', '/'],
  ]) {
    prevented = false;
    const link = MessageLink({ href, children: '文件' });
    link.props.onClick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(opened, { path, root, sessionId: 'one' });
  }
} finally { internals.H = previousDispatcher; store.openFilePreview = previousOpen; }
console.log("✅ 本地链接点击沿用预览 root/sessionId，越出 root 时复用目录回退");
