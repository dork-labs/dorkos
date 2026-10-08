import type { ModelUsage } from './contracts.js';
/** Retain only numeric counts actually reported by a raw provider event. */
export function reportedUsage(event: unknown, result: Partial<ModelUsage>): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const usage =
    e.usage ??
    (e.message as Record<string, unknown> | undefined)?.usage ??
    (e.response as Record<string, unknown> | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return;
  const u = usage as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  for (const [target, keys] of [
    ['inputTokens', ['prompt_tokens', 'input_tokens']],
    ['outputTokens', ['completion_tokens', 'output_tokens']],
    ['cacheReadTokens', ['cache_read_input_tokens']],
    ['cacheWriteTokens', ['cache_creation_input_tokens']],
  ] as const) {
    for (const key of keys) {
      const value = number(u[key]);
      if (value !== undefined) result[target] = value;
    }
  }
  const details = (u.input_tokens_details ?? u.prompt_tokens_details) as
    Record<string, unknown> | undefined;
  const cached = number(details?.cached_tokens);
  if (cached !== undefined) result.cacheReadTokens = cached;
}
