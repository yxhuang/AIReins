import assert from "node:assert/strict";
import { skillQueryAt, filterSkills, insertSkill } from "../src/codex-skills.ts";
import { fetchCodexSkills, runCodexCommand } from "../src/api.ts";
import { filterCommands } from "../src/commands.ts";
import { CODEX_COMMANDS } from "../../server/codex-commands.ts";

assert.deepEqual(skillQueryAt("$", 1), { start: 0, end: 1, query: "" });
assert.deepEqual(skillQueryAt("你好 $ab-rest 尾部", 6), { start: 3, end: 11, query: "ab" });
assert.equal(skillQueryAt("foo$ab", 6), null);
assert.equal(skillQueryAt("$ab ", 4), null);
assert.deepEqual(insertSkill("你好 $ab-rest 尾部", { start: 3, end: 11 }, "test"), { text: "你好 $test  尾部", cursor: 9 });
const skills = [{ name: "Foo", description: "类型检查", enabled: true }, { name: "hidden", description: "类型检查", enabled: false }];
assert.deepEqual(filterSkills(skills, "foo"), [skills[0]]);
assert.deepEqual(filterSkills(skills, "类型"), [skills[0]]);
assert.equal(filterCommands(CODEX_COMMANDS, "comp")[0].name, "compact");
assert.equal(filterCommands(CODEX_COMMANDS, "undo").length, 0);

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  return new Response(JSON.stringify({ code: 0, data: url.includes("/info/") ? { skills, errors: [] } : { message: "accepted" } }));
};
try {
  assert.deepEqual((await fetchCodexSkills("session/id")).skills, skills);
  await runCodexCommand("session/id", "review", "只读");
  assert.equal(requests[0].url, "/api/sessions/session%2Fid/info/skills");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(requests[1].options.body), { name: "review", arguments: "只读" });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 40067, msg: "未知 Codex 命令" }));
  await assert.rejects(runCodexCommand("id", "undo"), /未知 Codex/);
} finally { globalThis.fetch = realFetch; }
console.log("✅ Codex $补全、替换范围、过滤与命令 HTTP 契约");
