import assert from "node:assert/strict";
import { CodexDriver, codexConfigSchemaFromModels } from "./drivers/codex.js";
import { configOptionsForModel, modelConfigPatch } from "../shared/model-config.js";
import type { DriverCallbacks, SessionConfig } from "./types.js";

const models = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: true, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} description` })) },
  { id: "small-model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  { id: "no-reasoning", supportedReasoningEfforts: [] },
  { id: "legacy-model", defaultReasoningEffort: "high" },
];
const schema = codexConfigSchemaFromModels(models, { model: "gpt-6.1-sol", model_reasoning_effort: "high" });
const effortFor = (model?: string) => configOptionsForModel(schema.options, model).find(option => option.id === "effort")!;
assert.deepEqual(effortFor().values.map(value => value.value), [null, "low", "medium", "high", "xhigh", "max"]);
assert.equal(effortFor().values.at(-1)!.description, "max description");
assert.deepEqual(effortFor("small-model").values.map(value => value.value), [null, "low"]);
assert.equal(effortFor("small-model").default, "low", "不把配置中的 high 当作其他模型的默认值");
assert.deepEqual(effortFor("no-reasoning").values.map(value => value.value), [null], "空能力列表不回退到通用档位");
assert.ok(effortFor("legacy-model").values.some(value => value.value === "xhigh"), "旧协议缺少能力列表时保持兼容");
assert.deepEqual(modelConfigPatch(schema.options, { effort: "max" }, "small-model"), { model: "small-model", effort: null });
assert.deepEqual(modelConfigPatch(schema.options, { effort: "high" }, "gpt-6.1-sol"), { model: "gpt-6.1-sol" });
assert.equal(codexConfigSchemaFromModels(models, undefined).options.find(option => option.id === "effort")!.default, null);

const frontend = await import(new URL("../frontend/src/config-view.ts", import.meta.url).href);
assert.deepEqual(frontend.configOptionsForModel(schema.options, "gpt-6.1-sol"), configOptionsForModel(schema.options, "gpt-6.1-sol"));

function harness(config: SessionConfig, resumeSessionId?: string) {
  const sent: any[] = [];
  const callbacks: DriverCallbacks = { emit: () => undefined, metadata: () => undefined,
    commands: () => undefined, status: () => undefined, exited: () => undefined };
  const driver = new CodexDriver({ sessionId: "effort-test", cwd: process.cwd(), config, resumeSessionId, callbacks });
  const internal = driver as any;
  internal.spawnProcess = () => undefined;
  internal.send = (frame: any) => {
    sent.push(frame);
    if (frame.id === undefined) return;
    const params = frame.params;
    const result = frame.method === "initialize" ? {}
      : frame.method === "config/read" ? { config: { model: "gpt-6.1-sol", model_reasoning_effort: "high" } }
      : frame.method === "model/list" ? { data: models }
      : frame.method === "thread/start" || frame.method === "thread/resume" ? {
        thread: { id: "effort-thread" }, model: params.model ?? "gpt-6.1-sol",
        reasoningEffort: params.config?.model_reasoning_effort ?? "high",
      } : { turn: { id: "effort-turn" } };
    queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({ id: frame.id, result })));
  };
  return { driver, sent };
}

for (const resume of [false, true]) {
  const { driver, sent } = harness({ model: "gpt-6.1-sol", effort: "max" }, resume ? "old-thread" : undefined);
  await driver.start();
  assert.equal(sent.find(frame => frame.method === (resume ? "thread/resume" : "thread/start")).params.config.model_reasoning_effort, "max");
  await driver.sendUserMessage({ text: "synthetic" });
  assert.equal(sent.find(frame => frame.method === "turn/start").params.effort, "max");
}
{
  const { driver, sent } = harness({});
  await driver.start();
  await driver.setConfig({ effort: "max" });
  await driver.sendUserMessage({ text: "synthetic" });
  assert.equal(sent.filter(frame => frame.method === "turn/start").at(-1).params.effort, "max");
  await assert.rejects(driver.setConfig({ effort: "minimal" }), /不合法/);
  await assert.rejects(driver.setConfig({ model: "small-model", effort: "max" }), /不合法/);
  const switched = await driver.setConfig({ model: "small-model" });
  assert.equal(switched.effort, "low", "模型切换撤销不兼容档位并采用目标模型默认值");
  await driver.sendUserMessage({ text: "synthetic" });
  const turn = sent.filter(frame => frame.method === "turn/start").at(-1).params;
  assert.equal(turn.model, "small-model");
  assert.equal(turn.effort, null, "协议清除旧档位覆盖");
}
console.log("✅ Codex effort: per-model catalog, frontend parity, max start/resume/turn, hot config and legacy compatibility");
