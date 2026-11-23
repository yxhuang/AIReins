import { proxyEnvironment } from "../proxy-env.js";
import type { DriverConfigSchema, DriverOptions } from "../types.js";
import { AcpDriver, acpConfigSchemaFromOptions } from "./kimi.js";
import { StdioRpcProbe } from "./rpc-probe.js";

export class AntigravityDriver extends AcpDriver {
  constructor(options: DriverOptions) { super(options, "antigravity"); }
}

/** 模型与推理档位来自账号的 ACP 配置，订阅变更后无需硬编码更新。 */
export async function probeAntigravityConfigSchema(cwd: string): Promise<DriverConfigSchema> {
  const probe = new StdioRpcProbe("agy", ["acp"], cwd, proxyEnvironment());
  let sessionId = "";
  try {
    await probe.request("initialize", {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: "aireins-meta", title: "AIReins metadata probe", version: "0.5.0" },
    });
    // 后台探测需要等账号配置就绪，页面不必等待这一步。
    const result = await probe.request("session/new", { cwd, mcpServers: [] }, 45_000);
    sessionId = typeof result?.sessionId === "string" ? result.sessionId : "";
    return acpConfigSchemaFromOptions(Array.isArray(result?.configOptions) ? result.configOptions : [], "antigravity");
  } finally {
    if (sessionId) {
      try { await probe.request("session/close", { sessionId }, 1_000); } catch { /* 进程回收仍会执行。 */ }
    }
    await probe.close();
  }
}
