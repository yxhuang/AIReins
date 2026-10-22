import { loadPrefs } from "./prefs.js";

/** Keep the configured endpoint even while the proxy is offline, so later connections can recover. */
export function codexEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...environment };
  const proxy = loadPrefs().codexProxyUrl;
  if (!proxy) return env;
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    env[key] = proxy;
  }
  const bypass = new Set(["localhost", "127.0.0.1", "::1",
    ...[env.no_proxy, env.NO_PROXY].flatMap(value => (value ?? "").split(",").map(item => item.trim()).filter(Boolean)),
  ]);
  env.no_proxy = env.NO_PROXY = [...bypass].join(",");
  return env;
}
