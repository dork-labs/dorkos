/** The checkbox completion fixture for these suites, cleaned up after every test, and the original-batch builders. */
import { afterEach, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CanvasChannelRouteSchema } from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelIngest } from '../../../ingest.js';
import { DOC_INGEST_LIMITS } from '../../../current/accounting.js';
import { canvasDocuments, eq } from '@dorkos/db';
import {
  createOriginalCheckboxCompletion,
  type CheckboxTransactionalIngest,
} from '../../completion.js';
import { completionFixture } from '../completion-fixtures.js';

export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
export async function fixture(agentRoute = false) {
  const h = await completionFixture(agentRoute);
  cleanups.push(h.cleanup);
  return h;
}
export function heldIngest(h: Awaited<ReturnType<typeof fixture>>): CheckboxTransactionalIngest {
  return {
    requireTransaction: h.requireTransaction,
    requireCheckboxPreparedAdmissionInTransaction: () => {
      throw new Error('Shared reservation seam held');
    },
    acceptVerifiedCheckboxInTransaction: () => {
      throw new Error('Shared ingest seam held');
    },
  };
}

export async function originalInput(
  h: Awaited<ReturnType<typeof fixture>>,
  row: import('../../../store.js').DocWriteIntentRow
) {
  return {
    intentId: row.intentId,
    subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
    freshSnapshot: await h.authority.refreshRecoveryCurrent(row, h.approved),
  };
}
export function fixedCompletion(
  h: Awaited<ReturnType<typeof fixture>>,
  notifyCommitted: (documentId: string) => undefined = () => undefined
) {
  return createOriginalCheckboxCompletion({
    authority: h.authority,
    store: h.http.channels,
    policyLimits: DOC_INGEST_LIMITS,
    notifyCommitted,
  });
}
export async function seedOriginalBatch(
  h: Awaited<ReturnType<typeof fixture>>,
  row: import('../../../store.js').DocWriteIntentRow,
  waiting: boolean
) {
  await h.http.authorization.require(row.documentId, h.actor, true);
  h.grants.refreshAuthority(row.documentId, h.actor);
  const id = randomUUID();
  const result = new DocChannelIngest(h.http.channels).accept(
    { v: 1, id, type: 'md.comment', payload: { existing: true } },
    (tx) => {
      const access = h.http.authorization.requireCurrent(row.documentId, h.actor, true, tx);
      const grant = h.grants.revalidateGrant(row.documentId, row.grantId!, h.actor, tx);
      const physical = tx
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, row.documentId))
        .get()!;
      return {
        documentId: row.documentId,
        scope: access.scope,
        documentLabel: physical.title,
        provenance: { fixture: 'verified_existing_input' },
        routes: [
          {
            route: CanvasChannelRouteSchema.parse(grant.normalizedRoute),
            grantId: grant.grantId,
            grantRevision: grant.revision,
          },
        ],
      };
    }
  );
  const delivery = result.deliveries[0]!;
  if (waiting)
    h.http.channels.transaction((tx) => {
      const batch = h.http.channels.getBatch(delivery.batchId!, tx)!;
      expect(
        h.http.channels.transitionBatch(
          {
            batchId: batch.batchId,
            generation: batch.generation,
            attempt: batch.attempt,
            expectedStatus: 'pending',
            status: 'waiting',
            updatedAt: batch.updatedAt,
          },
          tx
        )
      ).toBe(true);
      expect(
        h.http.channels.updateDelivery(
          {
            documentId: row.documentId,
            eventId: id,
            routeId: delivery.routeId,
            expectedStatus: 'pending',
            changes: { status: 'waiting' },
          },
          tx
        )
      ).toBe(true);
    });
  return { id, batch: h.http.channels.getBatch(delivery.batchId!)! };
}
