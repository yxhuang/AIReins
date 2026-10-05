#!/usr/bin/env node
import { strict as assert } from "node:assert";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "../src/components/MarkdownMessage.tsx";
import { HistoryTimeline } from "../src/components/HistoryTimeline.tsx";
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
