/**
 * Put back, on a reopened conversation, which summaries the AGENT asked for
 * (DOR-2732).
 *
 * An agent that calls `compact_my_session` has its conversation summarized
 * once its turn ends, and the chat says so: "Summarized at 89% (asked by the
 * agent)". The runtime's own transcript cannot answer for the second half. It
 * records that a summary happened, never who asked, so the dispatcher stamps
 * the boundary of the compaction it ran and `'record'` mode keeps that one
 * boundary (`isRecordedEvent`). This overlay reads those rows back.
 *
 * Sibling of `model-substitution-overlay`, with the same never-throws contract
 * and the same subtraction of the OPEN turn's events, which the live stream is
 * already drawing.
 *
 * ## Placement
 *
 * A row TAGS the compaction it belongs to rather than adding one beside it. The
 * transcript's compaction message carries no timestamp of its own, so each one
 * is dated by the last timestamped message before it, and a row claims the
 * latest untagged compaction that sits in the window the agent's summary can
 * be in:
 *
 * - AFTER every message written before the agent asked (`requestedAt`). The
 *   message that carried the request was written before the tool ran, so the
 *   summary comes after it; a person's earlier `/compact` comes before it. Without
 *   this bound, a history whose own row for the agent's summary is missing (a
 *   paged or truncated transcript) would hand the tag to that earlier one.
 * - Dated at or before the row, which is written at the compaction turn's end,
 *   before the next person's message.
 *
 * A history with no compaction message to tag — OpenCode's sidecar store keeps
 * none — gets a compaction row of its own, spliced in by the row's clock, so the
 * line is still drawn where the conversation was summarized.
 *
 * @module services/session/overlays/agent-compaction-overlay
 */
import type { CompactMetadata, HistoryMessage } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore, peekProjector } from '../session-state-projector.js';
import type { RecordedAgentCompaction } from '../session-event-store.js';
import { spliceByCreatedAt } from './splice-by-created-at.js';

/** The `seq` of every agent compaction the open turn is still carrying live. */
function openTurnSeqs(sessionId: string): Set<number> {
  const seqs = new Set<number>();
  for (const event of peekProjector(sessionId)?.peekInProgressTurn() ?? []) {
    if (event.type === 'compact_boundary') seqs.add(event.seq);
  }
  return seqs;
}

/** The metadata one recorded boundary contributes, fields copied only when present. */
function metadataOf(row: RecordedAgentCompaction): CompactMetadata {
  const { event } = row;
  return {
    ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
    ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
    ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    requestedBy: 'agent',
    ...(event.contextPercent !== undefined ? { contextPercent: event.contextPercent } : {}),
  };
}

/**
 * Tag the compactions the agent asked for, and add a compaction row for any
 * that the history has no message for. Returns `messages` by reference when
 * there is nothing to apply.
 *
 * @param messages - History as the runtime assembled it.
 * @param rows - Recorded agent-requested boundaries, in seq order.
 */
export function applyAgentCompactions(
  messages: HistoryMessage[],
  rows: readonly RecordedAgentCompaction[]
): HistoryMessage[] {
  if (rows.length === 0) return messages;
  // Each compaction message, dated by the last timestamp seen before it.
  const candidates: { index: number; datedAt: string }[] = [];
  let lastSeen = '';
  messages.forEach((message, index) => {
    if (message.timestamp !== undefined) lastSeen = message.timestamp;
    if (message.messageType === 'compaction' && message.compactMetadata?.requestedBy !== 'agent') {
      candidates.push({ index, datedAt: lastSeen });
    }
  });

  const tagged = new Map<number, CompactMetadata>();
  const unplaced: RecordedAgentCompaction[] = [];
  for (const row of rows) {
    const askedAfter = lastIndexBefore(messages, row.event.requestedAt);
    const match = candidates.filter(
      (candidate) =>
        !tagged.has(candidate.index) &&
        candidate.index > askedAfter &&
        candidate.datedAt <= row.createdAt
    );
    const target = match.at(-1);
    if (target) {
      tagged.set(target.index, metadataOf(row));
    } else {
      unplaced.push(row);
    }
  }

  const withTags = messages.map((message, index) => {
    const meta = tagged.get(index);
    // The transcript's own token counts win where it has them; the tag is what
    // this overlay adds.
    return meta
      ? { ...message, compactMetadata: { ...meta, ...message.compactMetadata, ...tagOnly(meta) } }
      : message;
  });
  if (unplaced.length === 0) return withTags;
  return spliceByCreatedAt(withTags, unplaced, (row) => ({
    // Deterministic from the seq, so a reload reconciles onto the same row.
    id: `agent-compaction-${row.event.seq}`,
    role: 'user',
    content: '',
    messageType: 'compaction',
    compactMetadata: metadataOf(row),
  }));
}

/**
 * The index of the last timestamped message written before `requestedAt`, or
 * -1 when there is none or the row predates the field (no bound then).
 *
 * @param messages - History as the runtime assembled it.
 * @param requestedAt - When the agent asked (ISO-8601).
 */
function lastIndexBefore(
  messages: readonly HistoryMessage[],
  requestedAt: string | undefined
): number {
  if (requestedAt === undefined) return -1;
  let last = -1;
  messages.forEach((message, index) => {
    if (message.timestamp !== undefined && message.timestamp < requestedAt) last = index;
  });
  return last;
}

/** Just the two fields this overlay owns. */
function tagOnly(meta: CompactMetadata): CompactMetadata {
  return {
    ...(meta.requestedBy !== undefined ? { requestedBy: meta.requestedBy } : {}),
    ...(meta.contextPercent !== undefined ? { contextPercent: meta.contextPercent } : {}),
  };
}

/**
 * Overlay a session's recorded agent-requested compactions onto its history.
 *
 * **Never throws**: a store that cannot be read costs the tags and nothing
 * else, never the conversation.
 *
 * @param sessionId - The canonical id the boundaries were recorded under.
 * @param messages - History as the runtime assembled it.
 */
export function overlayAgentCompactions(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let rows: RecordedAgentCompaction[];
  try {
    const recorded = getSessionEventStore()?.readAgentCompactions(sessionId) ?? [];
    const live = recorded.length > 0 ? openTurnSeqs(sessionId) : new Set<number>();
    rows = live.size === 0 ? recorded : recorded.filter((row) => !live.has(row.event.seq));
  } catch (err) {
    logger.warn('[agent-compactions] could not read recorded compactions', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyAgentCompactions(messages, rows);
}
