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

/**
 * Format a session cost for the status line, bounded by magnitude.
 *
 * A cost is the one value in the line that can grow without limit, and the item
 * that draws it is rigid — it cannot truncate its way out of a figure too wide
 * for its slot, so a wide enough figure pushes the whole cluster past its box.
 * Bounding the characters instead of the magnitude is the shape of that mistake:
 * a limit written for labels admits `$99999.99` long after the row has run out of
 * room (DOR-461 review).
 *
 * So the figure gets shorter as the number gets bigger, the same way
 * {@link formatTokens} already handles the other unbounded quantity in this
 * slice. Anything below a billion dollars renders in seven characters, and the
 * exact amount is always in the Session panel.
 *
 * @param usd - Session cost in dollars.
 */
export function formatCost(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  return `$${usd.toFixed(2)}`;
}
