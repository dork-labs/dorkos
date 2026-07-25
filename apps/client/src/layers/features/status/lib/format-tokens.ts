/**
 * Token-count formatting for the status slice.
 *
 * Slice-private like `lib/status-labels`: it is this slice's presentation rule,
 * shared by the context item's breakdown tooltip and the Session readout so the
 * same figure never reads two different ways in two places.
 *
 * @module features/status/lib/format-tokens
 */

/** Format a token count as a compact human-readable string (e.g. 42.1k, 200k). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
