import assert from "node:assert/strict";
import { redact } from "./logger.js";

// 查询串里名字含 token/key/secret/password 的参数一律脱敏，其他参数保留。
assert.equal(
  redact("/pages/x/?access_token=abc&api_key=def&refresh_token=ghi&client_secret=jkl&token=m&page=2"),
  "/pages/x/?access_token=[REDACTED]&api_key=[REDACTED]&refresh_token=[REDACTED]&client_secret=[REDACTED]&token=[REDACTED]&page=2",
);
console.log("logger: 查询串凭据脱敏通过");
