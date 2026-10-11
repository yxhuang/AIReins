const SENSITIVE_KEY = /(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|proxy)/i;

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|sess)-[A-Za-z0-9_-]+/g, "$1-[REDACTED]")
    .replace(/((?:https?|all|no)_proxy=)\S+/gi, "$1[REDACTED]")
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://[REDACTED]@")
    .replace(/([?&][^=&\s]*(?:token|key|secret|password)[^=&\s]*=)[^&\s]+/gi, "$1[REDACTED]");
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
  // context 里的 message（多为 error.message）改名 detail，不许覆盖日志标题
  const { message: detail, ...rest } = redact(context) as Record<string, unknown>;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...rest,
    detail,
  });
  (level === "error" ? console.error : console.log)(line);
}
