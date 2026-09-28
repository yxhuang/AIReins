#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "../src/components/MarkdownMessage.tsx";

const render = (text) => renderToStaticMarkup(createElement(MarkdownMessage, { text }));
const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
assert.doesNotMatch(html, /<script\b/i);
assert.doesNotMatch(html, /onerror\s*=/i);
assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);

const link = render('[普通链接](https://example.com)');
assert.match(link, /target="_blank"/);
assert.match(link, /rel="noopener noreferrer"/);
console.log("✅ Markdown XSS 与普通链接属性");
