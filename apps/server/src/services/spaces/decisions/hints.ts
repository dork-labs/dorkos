/**
 * What the watch-only checks made of reported messages, for the moderation queue: the latest
 * verdict of each check on each message, as a hint beside the report. Read-only, and only ever
 * shown to owners and admins; a hint changes nothing about the message or its author.
 *
 * @module decisions/hints
 */
import type { PoolClient } from 'pg';
import {
  CommunityDecisionRecordSchema,
  type CommunityWireReportCheck,
} from '@dorkos/shared/community-wire';
import { findingOf } from './findings.js';

/**
 * The latest record of each check for each message, by message id. A record that no longer
 * reads (a hand-edited row) is left out rather than shown wrong.
 *
 * @param client - A connection inside the caller's transaction.
 * @param communityId - The space; records of other spaces are never read.
 * @param entryIds - The reported messages.
 */
export async function checkHints(
  client: PoolClient,
  communityId: string,
  entryIds: readonly string[]
): Promise<Map<string, CommunityWireReportCheck[]>> {
  const hints = new Map<string, CommunityWireReportCheck[]>();
  if (entryIds.length === 0) return hints;
  const rows = await client.query<{ subject_id: string; decision: unknown; created_at: Date }>(
    `SELECT DISTINCT ON (subject_id, decision->>'check') subject_id,decision,created_at
     FROM audit_events
     WHERE community_id=$1 AND action LIKE 'decision.%' AND origin='native'
       AND subject_id = ANY($2::text[])
     ORDER BY subject_id, decision->>'check', created_at DESC, id DESC`,
    [communityId, [...new Set(entryIds)]]
  );
  for (const row of rows.rows) {
    const parsed = CommunityDecisionRecordSchema.safeParse(row.decision);
    if (!parsed.success) continue;
    const record = parsed.data;
    const found = findingOf(record.answers);
    const list = hints.get(row.subject_id) ?? [];
    list.push({
      check: record.check,
      modelId: record.modelId,
      verdict: record.verdict,
      finding: found.verdict === 'flagged' ? found.finding : null,
      rule: found.verdict === 'flagged' ? found.rule : null,
      confidence: found.confidence,
      at: row.created_at.toISOString(),
    });
    hints.set(row.subject_id, list);
  }
  return hints;
}
