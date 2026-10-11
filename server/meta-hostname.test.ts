import assert from "node:assert/strict";
import { hostname } from "node:os";
import { getServerHostName } from "./meta.js";

assert.equal(getServerHostName(), hostname());
assert.equal(getServerHostName("https://alice-desktop.example.ts.net"), "alice-desktop");
assert.equal(getServerHostName("https://wb.example.com"), hostname());
assert.equal(getServerHostName("invalid"), hostname());
console.log("PASS: 服务端本机名字使用 Tailscale 配置，未配置时使用真实系统 hostname");
