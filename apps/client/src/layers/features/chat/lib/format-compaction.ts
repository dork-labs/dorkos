/**
 * Formatting helpers for context-compaction rows (live `CompactBoundaryRow` and
 * the durable `compaction` history message).
 *
 * @module features/chat/lib/format-compaction
 */
import type { CompactMetadata } from '@dorkos/shared/types';

/** Format a token count compactly (e.g. 50115 -> "50.1k", 840 -> "840"). */
export function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Build the durable compaction-row label from boundary metadata, e.g.
 * "Context compacted · 50.1k tokens · manual". Degrades gracefully to a bare
 * "Context compacted" when the transcript recorded no metadata.
 *
 * @param meta - Compaction metadata from the transcript's boundary record.
 */
export function formatCompactionLabel(meta?: CompactMetadata): string {
  const segments = ['Context compacted'];
  if (meta?.preTokens !== undefined) segments.push(`${formatTokenCount(meta.preTokens)} tokens`);
  if (meta?.trigger) segments.push(meta.trigger);
  return segments.join(' · ');
}
