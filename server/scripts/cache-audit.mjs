#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const usage = "用法：node server/scripts/cache-audit.mjs <jsonl路径 | 会话ID前缀> [--ttl 3600] [--json]\n      node server/scripts/cache-audit.mjs --since Nd|Nh [--ttl 3600]";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const display = (value) => value ?? "-";

function options(args) {
  const result = { ttl: 3600, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") result.json = true;
    else if (arg === "--ttl" || arg === "--since") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} 缺少参数`);
      if (arg === "--ttl") {
        if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error("TTL 必须是非负秒数");
        result.ttl = Number(value);
      } else {
        const match = /^(\d+)([dh])$/.exec(value);
        if (!match || Number(match[1]) <= 0) throw new Error("--since 必须是正整数 Nd 或 Nh");
        result.since = Number(match[1]) * (match[2] === "d" ? 86400 : 3600) * 1000;
        if (!Number.isFinite(result.since)) throw new Error("--since 超出范围");
      }
    } else if (arg.startsWith("--") || result.target) throw new Error(`无效参数：${arg}`);
    else result.target = arg;
  }
  if ((!result.target && !result.since) || (result.target && result.since) || (result.since && result.json)) throw new Error(usage);
  return result;
}

async function listFiles(root) {
  const files = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const directory = path.join(root, project.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Only projects/<project>/*.jsonl; never descend into subagents or follow symlinks.
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(directory, entry.name));
    }
  }
  return files.sort();
}

async function audit(file, ttl) {
  const result = { file, sessionId: path.basename(file, ".jsonl"), turns: [], boundaries: [], anomalies: [] };
  const seen = new Set();
  let origin = null;
  let line = 0;
  let interrupted = false;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const boundary = (kind, timestamp, detail) => result.boundaries.push({ beforeIndex: result.turns.length + 1, timestamp: timestamp ?? null, kind, detail });
  for await (const text of lines) {
    line++;
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); }
    catch {
      // A live/truncated or damaged JSONL line must not abort a batch scan.
      // Do not compare across the unknown event or inherit its user origin.
      boundary("invalid_json", null, `跳过无效 JSON 行 ${line}；中断相邻轮比较`);
      interrupted = true;
      origin = null;
      continue;
    }
    if (!row || row.isSidechain === true) continue;
    const attachment = row.attachment;
    if (row.type === "attachment" && (attachment?.hookEvent === "SessionStart" || /^SessionStart(?::|$)/.test(attachment?.hookName ?? ""))) {
      boundary("SessionStart", row.timestamp, attachment.source ?? attachment.hookName?.split(":")[1] ?? "-");
    }
    if ((row.type === "system" && row.subtype === "compact_boundary") || row.isCompactSummary) boundary("compact", row.timestamp, "压缩边界");
    if (row.type === "user") origin = row.turnOrigin ?? null;
    const message = row.message;
    if (row.type !== "assistant" || !message?.usage || message.model === "<synthetic>") continue;
    // Keep the FIRST usage-bearing row per message.id. Claude repeats usage for
    // content blocks; later blocks must not shift the response time/user origin.
    // Missing IDs are independent rows, rather than all sharing an undefined key.
    if (message.id != null && seen.has(message.id)) continue;
    if (message.id != null) seen.add(message.id);
    const u = message.usage;
    const write5m = number(u.cache_creation?.ephemeral_5m_input_tokens);
    const write1h = number(u.cache_creation?.ephemeral_1h_input_tokens);
    const split = write5m !== null && write1h !== null;
    const write = split ? write5m + write1h : number(u.cache_creation_input_tokens);
    const prev = interrupted ? null : result.turns.at(-1);
    interrupted = false;
    const delta = prev ? (Date.parse(row.timestamp) - Date.parse(prev.timestamp)) / 1000 : NaN;
    const turn = {
      index: result.turns.length + 1, timestamp: row.timestamp ?? null,
      intervalSeconds: Number.isFinite(delta) ? delta : null,
      turnOrigin: origin, version: row.version ?? null, model: message.model ?? null,
      read: number(u.cache_read_input_tokens), write, write5m, write1h,
      writeSource: split ? "breakdown" : "cache_creation_input_tokens",
      input_tokens: number(u.input_tokens),
    };
    if (prev) {
      if (prev.version !== turn.version) boundary("version", turn.timestamp, `${display(prev.version)} -> ${display(turn.version)}`);
      if (prev.turnOrigin !== turn.turnOrigin) boundary("turnOrigin", turn.timestamp, `${display(prev.turnOrigin)} -> ${display(turn.turnOrigin)} (宿主切换线索)`);
      // The specified four-condition heuristic is the sole anomaly rule;
      // compact markers are displayed separately, not an extra exclusion.
      if (delta >= 0 && delta <= ttl && turn.model !== null && turn.model === prev.model
          && [turn.read, turn.write, prev.read, prev.write].every((v) => v !== null)
          && turn.read + turn.write >= 0.8 * (prev.read + prev.write)
          && turn.read < prev.read + prev.write - 3000) {
        result.anomalies.push({ ...turn, prevRead: prev.read, prevWrite: prev.write });
      }
    }
    result.turns.push(turn);
  }
  return result;
}

function localTime(timestamp, withDate) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "-";
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${withDate ? day + " " : ""}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function turnLine(turn, anomaly, withDate) {
  const seconds = turn.intervalSeconds;
  const interval = seconds === null ? "-" : seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
  const write = turn.writeSource === "breakdown" ? `${turn.write5m}/${turn.write1h}` : `${display(turn.write)}(总计，未细分)`;
  return `${anomaly ? "!!" : "  "} #${turn.index} ${localTime(turn.timestamp, withDate)} Δ=${interval} origin=${display(turn.turnOrigin)} version=${display(turn.version)} model=${display(turn.model)} read=${display(turn.read)} write(5m/1h)=${write} input=${display(turn.input_tokens)}${anomaly ? ` prevRead=${anomaly.prevRead} prevWrite=${anomaly.prevWrite}` : ""}`;
}

function printSession(result) {
  console.log(`会话 ${result.sessionId}\n文件 ${result.file}`);
  const withDate = new Set(result.turns.map((t) => localTime(t.timestamp, true).split(" ")[0])).size > 1;
  const anomalies = new Map(result.anomalies.map((a) => [a.index, a]));
  const boundaries = new Map();
  for (const b of result.boundaries) {
    if (!boundaries.has(b.beforeIndex)) boundaries.set(b.beforeIndex, []);
    boundaries.get(b.beforeIndex).push(b);
  }
  for (let index = 1; index <= result.turns.length + 1; index++) {
    for (const b of boundaries.get(index) ?? []) console.log(`--- 边界 #${index} 前: ${b.kind} ${b.detail} ---`);
    if (index <= result.turns.length) console.log(turnLine(result.turns[index - 1], anomalies.get(index), withDate));
  }
  console.log(`汇总：${result.turns.length} 轮，意外失效 ${result.anomalies.length} 条`);
}

async function main() {
  const opts = options(process.argv.slice(2));
  const root = await realpath(process.env.WORKBENCH_CLAUDE_HISTORY_DIR || path.join(homedir(), ".claude/projects"));
  if (opts.since) {
    const cutoff = Date.now() - opts.since;
    let sessions = 0, turns = 0, anomalies = 0, errors = 0, invalidLines = 0;
    const details = [];
    for (const file of await listFiles(root)) {
      try {
        if ((await stat(file)).mtimeMs < cutoff) continue;
        const result = await audit(file, opts.ttl);
        sessions++; turns += result.turns.length; anomalies += result.anomalies.length;
        const skipped = result.boundaries.filter((b) => b.kind === "invalid_json").length;
        invalidLines += skipped;
        console.log(`${result.sessionId}\t${path.basename(path.dirname(file))}\t轮数=${result.turns.length}\t意外失效=${result.anomalies.length}${skipped ? `\t跳过坏行=${skipped}` : ""}`);
        if (result.anomalies.length) details.push(result);
      } catch (error) { errors++; console.error(error.message); }
    }
    for (const result of details) {
      console.log(`失效明细：${result.sessionId} (${path.basename(path.dirname(result.file))})`);
      for (const a of result.anomalies) console.log(turnLine(a, a, true));
    }
    console.log(`总计：会话 ${sessions}，轮数 ${turns}，意外失效 ${anomalies} 条，读取错误 ${errors}，跳过坏行 ${invalidLines}`);
    if (errors) process.exitCode = 1;
    return;
  }
  let file;
  if (opts.target.includes("/") || opts.target.endsWith(".jsonl")) {
    file = await realpath(opts.target.startsWith("~/") ? path.join(homedir(), opts.target.slice(2)) : path.resolve(opts.target));
    const relative = path.relative(root, file).split(path.sep);
    if (relative.length !== 2 || relative[0] === ".." || !file.endsWith(".jsonl") || !(await stat(file)).isFile()) throw new Error("路径必须位于历史根目录的 <项目>/*.jsonl 层");
  } else {
    const matches = (await listFiles(root)).filter((f) => path.basename(f, ".jsonl").startsWith(opts.target));
    if (matches.length !== 1) throw new Error(matches.length ? `会话前缀有多个匹配：\n${matches.join("\n")}` : `未找到会话：${opts.target}`);
    [file] = matches;
  }
  const result = await audit(file, opts.ttl);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printSession(result);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
