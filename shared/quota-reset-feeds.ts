export const quotaResetFeeds = {
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude",
  "grok-bot": "Grok Bot",
} as const;

export type QuotaResetProvider = keyof typeof quotaResetFeeds;

export function isQuotaResetProvider(value: unknown): value is QuotaResetProvider {
  return typeof value === "string" && Object.hasOwn(quotaResetFeeds, value);
}

export function quotaResetSource(provider: QuotaResetProvider): string {
  return `https://aihot.news/${provider}-reset`;
}
