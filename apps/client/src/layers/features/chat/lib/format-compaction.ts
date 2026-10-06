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
 * The label for a summary the AGENT asked for (DOR-2732), e.g. "Summarized at
 * 89% (asked by the agent)". The same words on the live row and the reopened
 * conversation, so the two cannot disagree.
 *
 * @param contextPercent - How full the conversation was when the agent asked;
 *   omitted from the label when the session never reported a reading.
 */
export function agentCompactionLabel(contextPercent?: number): string {
  return contextPercent === undefined
    ? 'Summarized (asked by the agent)'
    : `Summarized at ${contextPercent}% (asked by the agent)`;
}

/**
 * Build the durable compaction-row label from boundary metadata, e.g.
 * "Context compacted · 50.1k tokens · manual". Degrades gracefully to a bare
 * "Context compacted" when the transcript recorded no metadata.
 *
 * @param meta - Compaction metadata from the transcript's boundary record.
 */
export function formatCompactionLabel(meta?: CompactMetadata): string {
  if (meta?.requestedBy === 'agent') return agentCompactionLabel(meta.contextPercent);
  const segments = ['Context compacted'];
  if (meta?.preTokens !== undefined) segments.push(`${formatTokenCount(meta.preTokens)} tokens`);
  if (meta?.trigger) segments.push(meta.trigger);
  return segments.join(' · ');
}
