# Workbench

面向 Claude Code、Codex CLI 与 Kimi Code CLI 的本地工作台：一个跑在 WSL 里的 Node 进程，浏览器就是界面，直接驱动三家原生 CLI，多会话并行，危险操作要过审批闸门。

- 现状、待办与接手须知（新会话先读）：[`HANDOFF.md`](HANDOFF.md)
- 后端设计、接口和实测记录：[`server/README.md`](server/README.md)

```bash
npm install
wb                     # 后台启动并在浏览器打开（= bin/workbench）；另有 stop / restart / status / logs
npm run server         # 或者在前台直接跑
```

服务默认只监听 `127.0.0.1:8790`，端口可用 `WORKBENCH_PORT` 改。
