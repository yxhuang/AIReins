# Workbench

面向 Claude Code、Codex CLI 与 Kimi Code CLI 的本地薄工作台。M1 已实现 Node 22 + TypeScript 后端：原生 CLI worker、统一事件、REST/WS、审批回传、快照恢复和 NDJSON 持久化；前端留待 M2。

```bash
npm install
npm run server
```

服务固定监听 `127.0.0.1:8790`。后端设计、接口和实测记录见 [`server/README.md`](server/README.md)。
