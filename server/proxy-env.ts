import { loadPrefs } from "./prefs.js";

/** Keep the configured endpoint even while the proxy is offline, so later connections can recover. */
export function proxyEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...environment };
  const prefs = loadPrefs();
  const proxy = prefs.proxyUrl ?? prefs.codexProxyUrl;
  if (!proxy) return env;
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    env[key] = proxy;
  }
  const bypass = new Set(["localhost", "127.0.0.1", "::1", "100.64.0.0/10", ".ts.net",
    ...[env.no_proxy, env.NO_PROXY].flatMap(value => (value ?? "").split(/[,\s]+/).map(item => item.trim()).filter(Boolean)),
  ]);
  env.no_proxy = env.NO_PROXY = [...bypass].join(",");
  return env;
}
