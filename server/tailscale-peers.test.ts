import assert from "node:assert/strict";
import { parseTaildropTargets, parseTailscalePeers } from "./tailscale-peers.js";
import { normalizeRemoteOrigin } from "../frontend/src/host-connections.js";

const peer = (name: string, OS = "linux", Online = true, DNSName = `${name}.tail123.ts.net.`) =>
  ({ HostName: name, OS, Online, DNSName, TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::2"] });
const result = parseTailscalePeers(JSON.stringify({
  BackendState: "Running", Self: peer("self"),
  Peer: {
    self: peer("self"), z: peer("Zulu", "WINDOWS"), a: peer("Alpha", "macOS"),
    offline: peer("Aaron", "Linux", false), phone: peer("phone", "iOS"), android: peer("android", "android"),
    evil: peer("evil", "linux", true, "evil.example."), suffix: peer("suffix", "linux", true, "pc.tail123.ts.net.evil.test"),
    path: peer("path", "linux", true, "pc.tail123.ts.net/path"), nested: peer("nested", "linux", true, "extra.pc.tail123.ts.net"),
    malformed: null,
  },
}));
assert.deepEqual(result.peers.map(value => value.name), ["Alpha", "Zulu", "Aaron"], "排除自身/手机/非法域名，在线优先后按名称排序");
assert.deepEqual(result.peers[0], { name: "Alpha", origin: "https://alpha.tail123.ts.net", online: true, os: "macOS", ips: ["100.64.1.2", "fd7a:115c:a1e0::2"] });
for (const value of result.peers) assert.equal(normalizeRemoteOrigin(value.origin), value.origin);
assert.deepEqual(parseTailscalePeers("{broken"), { peers: [], reason: "Tailscale 状态不是有效 JSON" });
for (const value of ["null", "[]", "42"]) assert.equal(parseTailscalePeers(value).peers.length, 0);
assert.deepEqual(parseTailscalePeers('{"BackendState":"Stopped"}'), { peers: [], reason: "Tailscale 未运行" });
assert.deepEqual(parseTailscalePeers('{"Peer":{}}'), { peers: [] });
assert.equal(parseTailscalePeers(JSON.stringify({ Peer: { pc: { ...peer("pc"), HostName: "", TailscaleIPs: [42, "bad", "100.64.1.3"] } } })).peers[0]?.name, "pc");
console.log("PASS: Tailscale 电脑发现、自身/手机排除、DNS 与前端兼容、排序、坏 JSON 和停止状态");

const targets = parseTaildropTargets("100.64.0.9\tmy-laptop\toffline; last seen 18h ago\r\n100.64.0.7\tzeta\n100.64.0.8\tiphone-14-pro\n\nnot-an-ip\tbad\n100.64.0.10\t\n", "100.64.0.8");
assert.deepEqual(targets, [
  { name: "iphone-14-pro", ip: "100.64.0.8", online: true, self: true },
  { name: "zeta", ip: "100.64.0.7", online: true, self: false },
  { name: "my-laptop", ip: "100.64.0.9", online: false, self: false },
]);
assert.deepEqual(parseTaildropTargets(""), []);
console.log("PASS: Taildrop 目标解析、本机置顶、离线识别与坏行过滤");
