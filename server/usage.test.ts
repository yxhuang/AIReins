import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeManualResetCredits,
  applyUsageSettingsPatch,
  createDefaultUsageRunners,
  createUsageService,
  extractKeyFromShellFile,
  httpsGetDirectOrProxy,
  parseAntigravityUsagePayload,
  parseClaudeUsagePayload,
  parseCodexRateLimits,
  parseKimiUsagePayload,
  parseWindowSpec,
  probeClaudeUsageCli,
  queryCodexAppServerRateLimits,
  readLatestCodexSessionUsage,
  resolveKimiKey,
  UsageInputError,
  type UsageProvider,
  type UsageProviderId,
  type UsageProviderRunner,
} from "./usage.js";

const root = mkdtempSync(join(tmpdir(), "aireins-usage-test-"));

try {
  // 1. Claude payload parsing, weekly scoped caps, spend/extra_usage money formatting, and manual reset credits.
  {
    const nowMs = Date.parse("2026-11-18T08:00:00Z");
    const parsed = parseClaudeUsagePayload({
      subscription_type: "max",
      rate_limits: {
        limits: [
          { kind: "weekly_all", percent: 42.4, resets_at: "2026-11-22T04:00:00Z" },
          { kind: "session", percent: 18.6, resets_at: "2026-11-18T11:00:00Z" },
          {
            kind: "weekly_scoped",
            percent: 12,
            resets_at: "2026-11-22T04:00:00Z",
            scope: { model: { display_name: "Sonnet" } },
          },
        ],
        weekly_scoped_shares: [
          { limit_index: 2, allowance_percent_of_weekly: 80 },
        ],
        extra_usage: {
          is_enabled: true,
          utilization: 25,
          used_credits: 1250,
          monthly_limit: 5000,
          decimal_places: 2,
          currency: "USD",
        },
      },
    }, {
      nowMs,
      manualCredits: [
        { title: "Expired yesterday", expires: "2026-11-17" },
        { title: "Today card", expires: "2026-11-18" },
        { title: "No-expiry backup", expires: null },
        { title: "Future ISO", expires: "2026-11-20T12:00:00Z" },
      ],
    });

    assert.equal(parsed.id, "claude");
    assert.equal(parsed.plan, "Max");
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.windows.map((w) => w.id), ["5h", "week", "week_sonnet", "extra_credits"]);
    assert.equal(parsed.windows[0]!.used_pct, 18.6);
    assert.equal(parsed.windows[2]!.window_label, "Sonnet");
    assert.deepEqual(parsed.windows[2]!.note_code, { code: "weekly_cap", cap: 80 });
    assert.equal(parsed.windows[3]!.note, "$12.5 / $50");
    assert.equal(parsed.reset_credits?.available_count, 3);
    assert.deepEqual(parsed.reset_credits?.credits?.map((c) => c.title), [
      "Today card",
      "Future ISO",
      "No-expiry backup",
    ]);

    const noLimits = parseClaudeUsagePayload({
      subscription_type: "free",
      rate_limits_available: false,
    }, { nowMs });
    assert.equal(noLimits.status, "error");
    assert.equal(noLimits.error_code, "claude_no_limits");
    assert.equal(noLimits.plan, "Free");
    assert.equal(activeManualResetCredits([], nowMs), null);
  }

  // 2. probeClaudeUsageCli against a local fake script (verifies stream-json control_request & CLAUDE_CODE_ENTRYPOINT removal).
  {
    const fakeClaude = join(root, "fake-claude.mjs");
    writeFileSync(fakeClaude, `#!/usr/bin/env node
import { createInterface } from "node:readline";
if ("CLAUDE_CODE_ENTRYPOINT" in process.env) {
  process.stderr.write("CLAUDE_CODE_ENTRYPOINT leaked");
  process.exit(2);
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request?.subtype === "get_usage") {
    process.stdout.write("non-json banner line\\n");
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        request_id: msg.request_id,
        subtype: "success",
        response: { subscription_type: "pro", limits: [{ kind: "session", percent: 33, resets_at: "2026-11-18T12:00:00Z" }] }
      }
    }) + "\\n");
  }
});
`, { mode: 0o755 });
    chmodSync(fakeClaude, 0o755);

    const payload = await probeClaudeUsageCli(root, fakeClaude, 5_000, {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    assert.equal(payload.subscription_type, "pro");

    // Immediate-exit stub that never reads stdin must reject cleanly without uncaught EPIPE.
    const exitImmediately = join(root, "exit-immediately.sh");
    writeFileSync(exitImmediately, "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", { mode: 0o755 });
    chmodSync(exitImmediately, 0o755);
    await assert.rejects(() => probeClaudeUsageCli(root, exitImmediately, 5_000, process.env));
    await assert.rejects(() => queryCodexAppServerRateLimits(exitImmediately, 5_000, process.env));
  }

  // 3. Antigravity official JSON schema parsing (single-group, multi-group, 0.0 remaining_fraction, credits).
  {
    const nowMs = Date.parse("2026-11-18T08:00:00Z");
    assert.equal(parseWindowSpec("5h").canonicalId, "5h");
    assert.equal(parseWindowSpec("168h").canonicalId, "week");
    assert.equal(parseWindowSpec("300m").canonicalId, "5h");

    const multi = parseAntigravityUsagePayload({
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "pro", name: "5h", window: "5h", remaining_fraction: 0.72, reset_time: "2026-11-18T11:30:00Z" },
            { id: "flash_disabled", name: "Disabled", disabled: true, remaining_fraction: 0.5 },
          ],
        },
        {
          name: "Claude and GPT Models",
          buckets: [
            { id: "claude", name: "5h", window: "5h", remaining_fraction: 0, remaining_amount: "0", reset_time: "2026-11-18T12:00:00Z" },
            { id: "claude_week", name: "Weekly", window: "7d", remaining_fraction: 0.6, reset_time: "2026-11-24T00:00:00Z" },
          ],
        },
      ],
    }, {
      remaining_credits: 380,
      plan_name: "Google AI Ultra",
    }, nowMs);

    assert.equal(multi.id, "antigravity");
    assert.equal(multi.on_demand, true);
    assert.equal(multi.plan, "Google AI Ultra");
    assert.equal(multi.credits_note, "380");
    assert.equal(multi.windows.length, 3);
    assert.equal(multi.windows[0]!.group, "Gemini Models");
    assert.equal(Math.round(multi.windows[0]!.used_pct), 28);
    assert.equal(multi.windows[1]!.group, "Claude and GPT Models");
    assert.equal(multi.windows[1]!.used_pct, 100, "remaining_fraction: 0 must parse as 100% used");
    assert.deepEqual(multi.windows[1]!.note_code, { code: "remaining_amount", amount: "0" });
    assert.equal(multi.windows[2]!.duration_ms, 7 * 24 * 3_600_000);

    const headlessUsage = {
      status: "SUCCESS",
      usage: { total_tokens: 0 },
      command: {
        name: "usage",
        data: {
          groups: [{
            name: "Gemini Models",
            buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.75 }],
          }],
        },
      },
    };
    const free = parseAntigravityUsagePayload(headlessUsage, null, nowMs);
    assert.equal(free.status, "ok");
    assert.equal(free.windows.length, 1);
    assert.equal(free.windows[0]!.duration_ms, 7 * 24 * 3_600_000);
    assert.equal(free.windows[0]!.used_pct, 25);
    assert.equal(free.credits_note, undefined);

    const withCredits = parseAntigravityUsagePayload(headlessUsage, {
      command: { name: "credits", data: { plan_name: "Pro", remaining_credits: 20 } },
    }, nowMs);
    assert.equal(withCredits.plan, "Pro");
    assert.equal(withCredits.credits_note, "20");

    // Zero credits shown explicitly as "0", and empty/all-disabled groups report antigravity_no_limits.
    const zeroAndEmpty = parseAntigravityUsagePayload(
      { groups: [{ name: "Gemini Models", buckets: [{ name: "5h", disabled: true }] }] },
      { remaining_credits: 0, plan_name: "Pro" },
      nowMs,
    );
    assert.equal(zeroAndEmpty.status, "error");
    assert.equal(zeroAndEmpty.error_code, "antigravity_no_limits");
    assert.equal(zeroAndEmpty.credits_note, "0");
    assert.equal(zeroAndEmpty.plan, "Pro");
  }

  // 4. Codex rate limits, reset credit detail preservation, local session rollout fallback, and app-server JSON-RPC.
  {
    const nowMs = Date.parse("2026-11-18T08:00:00Z");
    const first = parseCodexRateLimits({
      planType: "pro",
      secondary: { windowDurationMins: 10_080, usedPercent: 40, resetsAt: 1_795_300_000 },
      primary: { windowDurationMins: 300, usedPercent: 15, resetsAt: 1_794_995_000 },
    }, {
      fetchedAtMs: nowMs,
      resetCreditsRaw: {
        availableCount: 2,
        credits: [
          { status: "used", expiresAt: "2026-11-25T00:00:00Z" },
          { status: "available", expiresAt: "2026-11-28T00:00:00Z" },
          { status: "available", expiresAt: "2026-11-21T00:00:00Z" },
        ],
      },
    });
    assert.equal(first.usage.plan, "Pro");
    assert.deepEqual(first.usage.windows.map((w) => w.id), ["5h", "week"]);
    assert.equal(first.usage.reset_credits?.available_count, 2);
    assert.equal(first.usage.reset_credits?.credits?.[0]?.expires_at, "2026-11-21T00:00:00.000Z");

    // Subsequent response with credits: null preserves known unexpired details when count matches.
    const second = parseCodexRateLimits({
      planType: "pro",
      primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: 1_794_995_000 },
    }, {
      fetchedAtMs: nowMs,
      resetCreditsRaw: { availableCount: 2, credits: null },
      previousCredits: first.creditDetails,
    });
    assert.equal(second.usage.reset_credits?.credits?.length, 2);

    // Local rollout fallback picks newest rollout file and marks status: stale + codex_local_fallback.
    const sessionsDir = join(root, "codex-sessions", "2026", "11", "18");
    mkdirSync(sessionsDir, { recursive: true });
    const olderFile = join(sessionsDir, "rollout-older.jsonl");
    const newerFile = join(sessionsDir, "rollout-newer.jsonl");
    writeFileSync(olderFile, `${JSON.stringify({
      timestamp: "2026-11-18T06:00:00Z",
      payload: { rate_limits: { plan_type: "plus", primary: { window_minutes: 300, used_percent: 90, resets_at: "2026-11-18T10:00:00Z" } } },
    })}\n`);
    writeFileSync(newerFile, `${JSON.stringify({
      timestamp: "2026-11-18T07:30:00Z",
      payload: { rate_limits: { plan_type: "pro", primary: { window_minutes: 300, used_percent: 22, resets_at: "2026-11-18T11:00:00Z" } } },
    })}\n`);
    utimesSync(olderFile, new Date("2026-11-18T06:00:00Z"), new Date("2026-11-18T06:00:00Z"));
    utimesSync(newerFile, new Date("2026-11-18T07:30:00Z"), new Date("2026-11-18T07:30:00Z"));

    const fallback = readLatestCodexSessionUsage(join(root, "codex-sessions"));
    assert.ok(fallback);
    assert.equal(fallback.status, "stale");
    assert.equal(fallback.error_code, "codex_local_fallback");
    assert.equal(fallback.plan, "Pro");
    assert.equal(fallback.windows[0]!.used_pct, 22);

    // Fake codex app-server JSON-RPC roundtrip.
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake" } }) + "\\n");
  } else if (msg.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { rateLimits: { planType: "plus", primary: { windowDurationMins: 300, usedPercent: 11, resetsAt: 1794995000 } } }
    }) + "\\n");
  }
});
`, { mode: 0o755 });
    chmodSync(fakeCodex, 0o755);
    const rpc = await queryCodexAppServerRateLimits(fakeCodex, 5_000, process.env);
    assert.equal((rpc.rateLimits as Record<string, unknown>).planType, "plus");
  }

  // 5. Kimi key resolution (config > env > file regex without shell execution), payload parsing, and CONNECT proxy error handling.
  {
    const rcFile = join(root, "kimi.rc");
    writeFileSync(rcFile, `# comment
export KIMI_API_KEY="sk-from-file-123"
`);
    assert.equal(extractKeyFromShellFile(rcFile, "KIMI_API_KEY"), "sk-from-file-123");
    assert.deepEqual(
      resolveKimiKey({ apiKey: "sk-config", apiKeyFile: rcFile }, { KIMI_API_KEY: "sk-env" }),
      { key: "sk-config", source: "config", envName: "KIMI_API_KEY" },
    );
    assert.deepEqual(
      resolveKimiKey({ apiKeyFile: rcFile }, { KIMI_API_KEY: "sk-env" }),
      { key: "sk-env", source: "env", envName: "KIMI_API_KEY" },
    );
    assert.deepEqual(
      resolveKimiKey({ apiKeyFile: rcFile }, {}),
      { key: "sk-from-file-123", source: "file", envName: "KIMI_API_KEY" },
    );

    const kimiOk = parseKimiUsagePayload({
      subType: "TYPE_PRO",
      limits: [
        { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: 30, limit: 100, resetTime: "2026-11-18T10:00:00Z" } },
      ],
      usage: { used: 250, limit: 1000, resetTime: "2026-11-23T00:00:00Z" },
    }, Date.parse("2026-11-18T08:00:00Z"));
    assert.equal(kimiOk.plan, "Pro");
    assert.deepEqual(kimiOk.windows.map((w) => [w.id, w.used_pct]), [["5h", 30], ["week", 25]]);

    const kimiNoPlan = parseKimiUsagePayload({});
    assert.equal(kimiNoPlan.status, "auth_expired");
    assert.equal(kimiNoPlan.error_code, "kimi_no_plan");

    // Local loopback HTTP CONNECT proxy framing + real TLS ClientHello tunnel + invalid header rejection.
    let connectTarget = "";
    let respond200 = false;
    let sawTlsClientHelloOnTunnel = false;
    const serverSockets = new Set<import("node:stream").Duplex>();
    const proxyServer = createHttpServer();
    proxyServer.on("connect", (req, clientSocket) => {
      serverSockets.add(clientSocket);
      clientSocket.on("error", () => { /* ignore client reset */ });
      clientSocket.on("close", () => serverSockets.delete(clientSocket));
      connectTarget = req.url ?? "";
      if (respond200) {
        clientSocket.on("data", (chunk: Buffer) => {
          // TLS Handshake record starts with 0x16 0x03 — proves httpsRequest actually used the CONNECT tunnel!
          if (chunk.length >= 2 && chunk[0] === 0x16 && chunk[1] === 0x03) {
            sawTlsClientHelloOnTunnel = true;
            clientSocket.destroy();
          }
        });
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } else {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      }
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxyServer.address() as { port: number }).port;
    try {
      await assert.rejects(
        httpsGetDirectOrProxy("https://api.kimi.com/coding/v1/usages", { Authorization: "Bearer test" }, {
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          timeoutMs: 3_000,
        }),
        /proxy CONNECT status 502/,
      );
      assert.equal(connectTarget, "api.kimi.com:443");

      // Valid headers over 200 CONNECT must send TLS ClientHello through the proxy tunnel (never direct-connecting).
      respond200 = true;
      await assert.rejects(
        httpsGetDirectOrProxy("https://api.kimi.com/coding/v1/usages", { Authorization: "Bearer sk-valid-token" }, {
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          timeoutMs: 3_000,
        }),
      );
      assert.equal(sawTlsClientHelloOnTunnel, true, "HTTPS request must traverse the CONNECT proxy socket");

      // Invalid header char inside async CONNECT 200 callback must reject Promise cleanly without uncaught exception.
      await assert.rejects(
        httpsGetDirectOrProxy("https://api.kimi.com/coding/v1/usages", { Authorization: "Bearer bad\u007fchar" }, {
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          timeoutMs: 3_000,
        }),
      );
    } finally {
      for (const s of serverSockets) s.destroy();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }

    // Non-regular directory path rejected by extractKeyFromShellFile & applyUsageSettingsPatch without blocking.
    assert.equal(extractKeyFromShellFile(root, "KIMI_API_KEY"), null);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { kimi: { apiKeyFile: root } }), UsageInputError);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { kimi: { apiKey: "sk bad space" } }), UsageInputError);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { kimi: { apiKey: "sk-中文" } }), UsageInputError);
  }

  // 6. Default runners: liveClaudeUsage reuse + Kimi HTTP 401 classification without leaking secrets.
  {
    let liveCalled = 0;
    const runners = createDefaultUsageRunners({
      cwd: root,
      getConfig: () => ({ version: 1, kimi: { apiKey: "sk-top-secret-value" } }),
      liveClaudeUsage: async () => {
        liveCalled++;
        return { subscription_type: "max", limits: [{ kind: "session", percent: 9, resets_at: "2026-11-18T11:00:00Z" }] };
      },
      httpGet: async (_url, headers) => {
        assert.equal(headers.Authorization, "Bearer sk-top-secret-value");
        return { status: 401, body: '{"error":"invalid"}' };
      },
      env: {},
    });
    const claudeRes = await runners.claude.fetch();
    assert.equal(liveCalled, 1);
    assert.equal(claudeRes.status, "ok");
    assert.equal(claudeRes.windows[0]!.used_pct, 9);

    const kimiRes = await runners.kimi.fetch();
    assert.equal(kimiRes.status, "auth_expired");
    assert.equal(kimiRes.error_code, "kimi_auth_expired");
    assert.ok(!JSON.stringify(kimiRes).includes("sk-top-secret-value"), "error payload must never echo Kimi secret");
  }

  // 7. createUsageService: Antigravity on-demand compliance (NEVER background-polled), freshness cache,
  //    exponential backoff, stale transition, live Codex ingestion, 0600 permissions, and secret redaction.
  {
    let clock = Date.parse("2026-11-18T08:00:00Z");
    const calls: Record<UsageProviderId, number> = { claude: 0, antigravity: 0, codex: 0, kimi: 0 };
    let claudeShouldFail = false;
    let agyShouldFail = false;
    let changeEvents = 0;

    const mkOk = (id: UsageProviderId, pct: number): UsageProvider => ({
      id,
      name: id === "antigravity" ? "Antigravity" : id,
      plan: "Pro",
      windows: [{ id: "5h", label: "5h", duration_ms: 18_000_000, used_pct: pct, resets_at: new Date(clock + 7_200_000).toISOString(), note: null }],
      status: "ok",
      error: null,
      fetched_at: new Date(clock).toISOString(),
      reset_credits: null,
      ...(id === "antigravity" ? { on_demand: true } : {}),
    });

    const runners: Record<UsageProviderId, UsageProviderRunner> = {
      claude: {
        id: "claude",
        async fetch() {
          calls.claude++;
          if (claudeShouldFail) {
            return { ...mkOk("claude", 0), windows: [], status: "error", error: "boom", error_code: "network_error" };
          }
          return mkOk("claude", 10 + calls.claude);
        },
      },
      antigravity: {
        id: "antigravity",
        onDemand: true,
        async fetch() {
          calls.antigravity++;
          if (agyShouldFail) {
            return { ...mkOk("antigravity", 0), windows: [], status: "error", error: "agy missing", error_code: "antigravity_cli_unavailable" };
          }
          return mkOk("antigravity", 20 + calls.antigravity);
        },
      },
      codex: {
        id: "codex",
        async fetch() {
          calls.codex++;
          return mkOk("codex", 30);
        },
      },
      kimi: {
        id: "kimi",
        async fetch() {
          calls.kimi++;
          return mkOk("kimi", 40);
        },
      },
    };

    const configPath = join(root, "wb", "usage.json");
    const cachePath = join(root, "wb", "usage-cache.json");
    const service = createUsageService({
      configPath,
      cachePath,
      now: () => clock,
      intervalMs: 300_000,
      firstRetryMs: 60_000,
      maxBackoffMs: 1_800_000,
      staleAfterMs: 900_000,
      onDemandFreshMs: 300_000,
      runners,
      env: {},
      onChange: () => { changeEvents++; },
    });

    // Background start() polls claude/codex/kimi, NEVER antigravity.
    service.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, { claude: 1, antigravity: 0, codex: 1, kimi: 1 });
    assert.ok(changeEvents >= 3);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600, "usage-cache.json must be 0600");

    // Opening panel triggers on-demand Antigravity once, then respects 5m freshness window.
    service.notifyPanelOpened();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.antigravity, 1);
    service.notifyPanelOpened();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.antigravity, 1, "fresh Antigravity snapshot must not re-run agy on repeated panel opens");

    // After 5m, opening panel refreshes Antigravity once.
    clock += 301_000;
    service.notifyPanelOpened();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.antigravity, 2);

    // On Antigravity error, 60s error cooldown prevents rapid retry storms.
    clock += 301_000;
    agyShouldFail = true;
    service.notifyPanelOpened();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.antigravity, 3);
    clock += 15_000;
    service.notifyPanelOpened();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.antigravity, 3, "failed on-demand provider must respect 60s retry cooldown");
    agyShouldFail = false;

    // Explicit refresh("all") refreshes all enabled providers including Antigravity.
    const refreshed = await service.refresh("all");
    assert.equal(calls.antigravity, 4);
    assert.deepEqual(refreshed.providers.map((p) => p.id), ["claude", "antigravity", "codex", "kimi"]);

    // Stale transition after staleAfterMs (15m).
    clock += 901_000;
    const staleSummary = service.summary();
    assert.ok(staleSummary.providers.every((p) => p.status === "stale"));

    // Live Codex rate-limit ingestion updates cache immediately and marks status ok.
    service.ingestCodexRateLimits({
      rateLimits: {
        planType: "pro",
        primary: { windowDurationMins: 300, usedPercent: 55, resetsAt: Math.floor((clock + 3_600_000) / 1000) },
      },
    });
    const afterIngest = service.summary().providers.find((p) => p.id === "codex");
    assert.equal(afterIngest?.status, "ok");
    assert.equal(afterIngest?.windows[0]?.used_pct, 55);

    // Settings update: masked write-only Kimi key, 0600 file mode, never echoed in GET/PUT responses.
    const secret = "sk-kimi-never-echo-999";
    const updated = await service.updateSettings({
      providers: { codex: { enabled: false } },
      kimi: { apiKey: secret, useProxy: true },
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600, "usage.json must be 0600");
    assert.equal(updated.settings.providers.codex.enabled, false);
    assert.equal(updated.settings.kimi.keyConfigured, true);
    assert.equal(updated.settings.kimi.keySource, "config");
    assert.equal(updated.settings.kimi.useProxy, true);
    assert.ok(!JSON.stringify(updated).includes(secret), "updateSettings response must never include raw apiKey");
    assert.ok(!JSON.stringify(service.settings()).includes(secret), "settings() response must never include raw apiKey");
    assert.ok(!updated.summary.providers.some((p) => p.id === "codex"), "disabled provider hidden from summary");

    // Clearing Kimi key removes it from disk.
    const cleared = await service.updateSettings({ kimi: { apiKey: null } });
    assert.equal(cleared.settings.kimi.keyConfigured, false);
    assert.equal(cleared.settings.kimi.keySource, "none");
    assert.ok(!readFileSync(configPath, "utf8").includes(secret));

    // Exponential backoff validation on background provider failure.
    claudeShouldFail = true;
    await service.refresh("claude");
    assert.equal(service.summary().providers.find((p) => p.id === "claude")?.status, "error");

    // Validation errors throw UsageInputError.
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { providers: { unknown: { enabled: true } } }), UsageInputError);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { kimi: { apiKey: "bad\nkey" } }), UsageInputError);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { kimi: { apiKeyFile: "relative/path" } }), UsageInputError);
    assert.throws(() => applyUsageSettingsPatch({ version: 1 }, { claude: { resetCredits: [{ expires: "not-a-date" }] } }), UsageInputError);
    await assert.rejects(() => service.refresh("unknown"), UsageInputError);

    await service.stop();

    // Reloading a fresh service tightens wide 0644 permissions back to 0600 and preserves cached providers/settings.
    chmodSync(configPath, 0o644);
    chmodSync(cachePath, 0o644);
    let resolveSlowCodex: ((val: UsageProvider) => void) | undefined;
    const reloaded = createUsageService({
      configPath,
      cachePath,
      now: () => clock,
      runners: {
        ...runners,
        codex: {
          id: "codex",
          fetch: () => new Promise((r) => { resolveSlowCodex = r; }),
        },
      },
      env: {},
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600, "loadUsageConfig must tighten 0644 back to 0600");
    assert.equal(statSync(cachePath).mode & 0o777, 0o600, "cache load must tighten 0644 back to 0600");
    assert.equal(reloaded.settings().providers.codex.enabled, false);
    assert.ok(reloaded.summary().providers.some((p) => p.id === "antigravity"));

    // Generation guard: live ingestCodexRateLimits must not be overwritten when an older in-flight poll finishes later.
    await reloaded.updateSettings({ providers: { codex: { enabled: true } } });
    assert.ok(resolveSlowCodex, "enabling codex started background fetch");
    reloaded.ingestCodexRateLimits({
      rateLimits: {
        planType: "pro",
        primary: { windowDurationMins: 300, usedPercent: 77, resetsAt: Math.floor((clock + 3_600_000) / 1000) },
      },
    });
    resolveSlowCodex!({ ...mkOk("codex", 12), status: "stale", error_code: "codex_local_fallback", error: "old" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reloaded.summary().providers.find((p) => p.id === "codex")?.windows[0]?.used_pct, 77, "stale in-flight poll must not overwrite newer live Codex update");
    await reloaded.stop();
  }

  console.log("✅ usage server tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
