#!/usr/bin/env node
// 守卫：深色令牌在 styles.css 里有两份（媒体查询 + [data-theme="dark"]），
// 纯 CSS 无法复用，只能重复。改一处漏一处会导致「跟随系统的深色」和
// 「手动选的深色」悄悄长得不一样。这个脚本让它变成显式失败。
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const grab = (re, label) => {
  const m = css.match(re);
  if (!m) { console.error(`❌ 找不到${label}，选择器可能被改过`); process.exit(1); }
  return Object.fromEntries([...m[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)]
    .map(([, k, v]) => [k, v.trim()]));
};
const media = grab(
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/,
  "媒体查询深色块");
const attr = grab(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/, "[data-theme=dark] 深色块");

const keys = [...new Set([...Object.keys(media), ...Object.keys(attr)])].sort();
const bad = keys.filter((k) => media[k] !== attr[k]);
if (bad.length) {
  console.error(`❌ 两份深色令牌不一致，共 ${bad.length} 项：`);
  for (const k of bad) console.error(`   ${k}: 媒体查询=${media[k] ?? "缺失"}  属性选择器=${attr[k] ?? "缺失"}`);
  console.error("   两处都要改，否则「跟随系统的深色」与「手动选的深色」会不一样。");
  process.exit(1);
}
console.log(`✅ 深色令牌两份一致（${keys.length} 项）`);
