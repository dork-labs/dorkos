/** Consume accepted delivery wakes once, without changing protected receipt identity. */
import {
  and,
  eq,
  isNull,
  lte,
  or,
  canvasDocBatches,
  sessionMessageAcceptanceReceipts,
} from '@dorkos/db';
import { CanvasAppManifestError } from '@dorkos/shared/canvas-app-manifest';
import { PrivateSessionMessageRefusalError } from '../../../session/private-messages/refusal.js';
import { DocChannelArchivedError, DocChannelNotFoundError } from '../authorization.js';
import { DocRouteGrantError } from '../grant-policy.js';
import type { DocBatchPumpOptions } from './pump.js';
/** A scheduler retry is not an authoritative budget hold and cannot postpone runtime dispatch. */
export const DOC_RESUME_RETRY_CODE = 'document_resume_retry';
const RESUME_RETRY_MS = 60000;
/** Refresh each source, then atomically advance its expired wake before postcommit notification. */
export async function consumeAcceptedDocWakes(
  options: Pick<DocBatchPumpOptions, 'db' | 'store' | 'admission' | 'now'>
): Promise<Set<string>> {
  const rows = options.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(
      and(
        eq(sessionMessageAcceptanceReceipts.sourceKind, 'document_event_batch'),
        eq(sessionMessageAcceptanceReceipts.state, 'accepted')
      )
    )
    .all();
  const sessions = new Set<string>();
  for (const receipt of rows) {
    const batch = options.store.getBatch(receipt.sourceId);
    if (
      batch?.status === 'accepted' &&
      batch.leaseUntil &&
      batch.leaseUntil > options.now().toISOString()
    )
      continue;
    try {
      await options.admission.acceptance.prepare(receipt.id);
    } catch (error) {
      // Unavailable storage or blocked identity recovery proves no authority loss. Let the host retry.
      if (!provenRecoveryRefusal(error)) throw error;
      options.admission.acceptance.cancel(receipt.id, 'document_recovery_authority_refused');
      continue;
    }
    // A failed wake write leaves accepted work intact and surfaces to the host's storage retry.
    const sessionId = options.store.transaction((tx) => {
      const current = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
        .get();
      if (
        !current ||
        current.state !== 'accepted' ||
        current.sourceKind !== 'document_event_batch' ||
        current.sourceId !== receipt.sourceId ||
        current.sourceGeneration !== receipt.sourceGeneration
      )
        return undefined;
      const now = options.now().toISOString();
      const changed = tx
        .update(canvasDocBatches)
        .set({
          leaseUntil: new Date(Date.parse(now) + RESUME_RETRY_MS).toISOString(),
          errorCode: DOC_RESUME_RETRY_CODE,
          updatedAt: now,
        })
        .where(
          and(
            eq(canvasDocBatches.batchId, current.sourceId),
            eq(canvasDocBatches.generation, current.sourceGeneration),
            eq(canvasDocBatches.admissionReceiptId, current.id),
            eq(canvasDocBatches.status, 'accepted'),
            or(isNull(canvasDocBatches.leaseUntil), lte(canvasDocBatches.leaseUntil, now))
          )
        )
        .run().changes;
      return changed === 1 ? current.sessionId : undefined;
    });
    if (sessionId) sessions.add(sessionId);
  }
  return sessions;
}

/** Only typed source/authority refusals justify retiring accepted durable work. */
function provenRecoveryRefusal(error: unknown): boolean {
  return (
    error instanceof PrivateSessionMessageRefusalError ||
    error instanceof DocChannelNotFoundError ||
    error instanceof DocChannelArchivedError ||
    error instanceof CanvasAppManifestError ||
    (error instanceof DocRouteGrantError &&
      error.code !== 'AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY' &&
      [403, 404, 409, 422].includes(error.status))
  );
}
