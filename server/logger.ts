const SENSITIVE_KEY = /(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|proxy)/i;

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|sess)-[A-Za-z0-9_-]+/g, "$1-[REDACTED]")
    .replace(/((?:https?|all|no)_proxy=)\S+/gi, "$1[REDACTED]")
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://[REDACTED]@")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(nested)]),
    );
  }
  return value;
}

export function log(
  level: "info" | "warn" | "error",
  message: string,
  context: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...redact(context) as Record<string, unknown>,
  });
  (level === "error" ? console.error : console.log)(line);
}
