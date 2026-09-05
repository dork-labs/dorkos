/**
 * Humanized labels for dead-letter rejection reason codes.
 *
 * `AggregatedDeadLetter.reason` is a wire enum (`hop_limit`, `ttl_expired`,
 * `cycle_detected`, `budget_exhausted`) — the raw code a person should never
 * have to read, since it is the one field on the attention sheet that says
 * why a message failed (DOR-1755). Shared by every surface that shows a
 * reason so there is exactly one map to keep in sentence case.
 */
export const DEAD_LETTER_REASON_LABEL: Record<string, string> = {
  hop_limit: 'Hop limit',
  ttl_expired: 'TTL expired',
  cycle_detected: 'Cycle detected',
  budget_exhausted: 'Budget exhausted',
};

/** Fallback label for a reason code this map does not recognize. */
export const DEAD_LETTER_REASON_FALLBACK = 'Unknown reason';

/** Turn a raw dead-letter reason code into its display label. */
export function deadLetterReasonLabel(reason: string): string {
  return DEAD_LETTER_REASON_LABEL[reason] ?? DEAD_LETTER_REASON_FALLBACK;
}
