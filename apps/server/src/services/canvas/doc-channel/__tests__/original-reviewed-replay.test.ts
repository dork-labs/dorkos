import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canvasDocBatches,
  canvasDocChannels,
  canvasDocDeliveries,
  canvasDocEvents,
  canvasDocuments,
  eq,
  and,
} from '@dorkos/db';
import { authorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
import {
  submitCurrentDocEvent,
  replayServiceOriginalExpiredDocBatch,
  readServiceOriginalDocManagement,
} from '../service.js';

async function retainedExpiredWork() {
  const h = await authorityFixture(false, false, true, 'md.*');
  try {
    const physical = h.db
      .select()
      .from(canvasDocuments)
      .where(eq(canvasDocuments.id, h.input.documentId))
      .get()!;
    const channel = h.db
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, h.input.documentId))
      .get()!;
    const condition = { expectedGeneration: docDocumentGeneration(physical, channel) };
    const event = {
      v: 1 as const,
      id: randomUUID(),
      type: 'md.comment',
      payload: { text: 'retained original' },
    };
    await submitCurrentDocEvent(h.http.service, h.input.documentId, event, h.actor, condition);
    const batch = h.db
      .select()
      .from(canvasDocBatches)
      .where(eq(canvasDocBatches.documentId, h.input.documentId))
      .get()!;
    expect(batch.inputEventIds).toEqual([event.id]);
    // Exercise review eligibility against a persisted expiration state, not a forged admission/permit.
    h.db.transaction((tx) => {
      tx.update(canvasDocBatches)
        .set({ status: 'expired' })
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .run();
      tx.update(canvasDocDeliveries)
        .set({ status: 'expired' })
        .where(eq(canvasDocDeliveries.batchId, batch.batchId))
        .run();
    });
    return {
      h,
      event,
      batch,
      request: {
        documentId: h.input.documentId,
        expectedGeneration: condition.expectedGeneration,
        eventId: randomUUID(),
        batchId: batch.batchId,
        expectedBatchGeneration: batch.generation,
        grantId: h.granted.grant.grantId,
      },
    };
  } catch (cause) {
    // Cleanup is attempted, but a later cleanup failure cannot replace this original setup failure.
    try {
      await h.cleanup();
    } catch {}
    throw cause;
  }
}

describe('original explicit expired session review', () => {
  it('creates only one new generation from original IDs and recovers the same operation without repeating it', async () => {
    const { h, event, batch, request } = await retainedExpiredWork();
    try {
      const original = h.db
        .select()
        .from(canvasDocEvents)
        .where(
          and(
            eq(canvasDocEvents.documentId, request.documentId),
            eq(canvasDocEvents.eventId, event.id)
          )
        )
        .get()!;
      h.http.channels.getBatch = () => {
        throw new Error('Reflected batch reader used');
      };
      h.http.grants.revalidateGrant = () => {
        throw new Error('Reflected grant validator used');
      };
      const review = await readServiceOriginalDocManagement(
        h.http.service,
        request.documentId,
        h.actor
      );
      expect(review.reviews.find((row) => row.batchId === request.batchId)).toMatchObject({
        batchGeneration: request.expectedBatchGeneration,
        replayAvailable: true,
        replayUnavailableReason: null,
      });
      const first = await replayServiceOriginalExpiredDocBatch(h.http.service, request, h.actor);
      expect(first.status).toBe('pending');
      expect(first.previousBatchId).toBe(batch.batchId);
      expect(first.batchId).not.toBe(batch.batchId);
      expect(first.generation).not.toBe(batch.generation);
      const next = h.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.batchId, first.batchId))
        .get()!;
      expect(next.inputEventIds).toEqual([event.id]);
      expect(next.status).toBe('pending');
      const duplicate = await replayServiceOriginalExpiredDocBatch(
        h.http.service,
        request,
        h.actor
      );
      expect(duplicate).toEqual({ ...first, status: 'duplicate' });
      const consumed = await readServiceOriginalDocManagement(
        h.http.service,
        request.documentId,
        h.actor
      );
      expect(consumed.reviews.find((row) => row.batchId === request.batchId)?.replayAvailable).toBe(
        false
      );
      expect(
        h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, request.documentId))
          .all()
      ).toHaveLength(2);
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(
            and(
              eq(canvasDocEvents.documentId, request.documentId),
              eq(canvasDocEvents.eventId, event.id)
            )
          )
          .get()
      ).toEqual(original);
      await expect(
        replayServiceOriginalExpiredDocBatch(
          h.http.service,
          { ...request, eventId: randomUUID() },
          h.actor
        )
      ).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });
  it('does not let a postcommit listener replace the original generation fence through mutable request DATA', async () => {
    const { h, request } = await retainedExpiredWork();
    let observedTurnover = false;
    const stop = h.http.service.onCommittedInput(() => {
      const physical = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, request.documentId))
        .get()!;
      const nextOpenedAt = new Date(Date.parse(physical.openedAt) + 1).toISOString();
      h.db
        .update(canvasDocuments)
        .set({ openedAt: nextOpenedAt })
        .where(eq(canvasDocuments.id, request.documentId))
        .run();
      const channel = h.db
        .select()
        .from(canvasDocChannels)
        .where(eq(canvasDocChannels.documentId, request.documentId))
        .get()!;
      request.expectedGeneration = docDocumentGeneration(
        { ...physical, openedAt: nextOpenedAt },
        channel
      );
      observedTurnover = true;
    });
    try {
      await expect(
        replayServiceOriginalExpiredDocBatch(h.http.service, request, h.actor)
      ).rejects.toThrow();
      expect(observedTurnover).toBe(true);
      // The actual operation committed once, but its old-generation result is not disclosed as current.
      expect(
        h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, request.documentId))
          .all()
      ).toHaveLength(2);
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.eventId, request.eventId))
          .get()
      ).toBeDefined();
    } finally {
      stop();
      await h.cleanup();
    }
  });
  it.each(['in_doubt', 'turn_started'] as const)('never repeats %s work', async (status) => {
    const { h, request } = await retainedExpiredWork();
    try {
      h.db
        .update(canvasDocBatches)
        .set({ status })
        .where(eq(canvasDocBatches.batchId, request.batchId))
        .run();
      const before = h.db.select().from(canvasDocBatches).all();
      await expect(
        replayServiceOriginalExpiredDocBatch(h.http.service, request, h.actor)
      ).rejects.toThrow();
      expect(h.db.select().from(canvasDocBatches).all()).toEqual(before);
      expect(
        h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.eventId, request.eventId))
          .get()
      ).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});
