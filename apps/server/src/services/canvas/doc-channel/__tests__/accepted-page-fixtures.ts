/** Real protected receipts for page-boundary tests, without unrelated tab-per-receipt setup. */
import { randomUUID } from 'node:crypto';
import { canvasDocChannels, eq, type SessionMessageAcceptanceReceipt } from '@dorkos/db';
import type { BatchFixture } from './batch-fixtures.js';
import { NOW, FROM } from './batch-fixtures.js';
import { DocChannelIngest } from '../ingest.js';

/** Every route uses actual grant, ingest, source consumption and shared queue admission. */
export function addAcceptedReceiptPage(
  f: BatchFixture,
  count: number
): SessionMessageAcceptanceReceipt[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 105)
    throw new RangeError('Invalid accepted page fixture count');
  const receipts: SessionMessageAcceptanceReceipt[] = [];
  for (let start = 0; start < count; start += 4) {
    const size = Math.min(4, count - start);
    const doc = f.canvas.open(
      FROM,
      'agent-1',
      { type: 'markdown', title: `Accepted page ${start}`, content: `Body ${start}` },
      { pinned: true }
    );
    f.db
      .update(canvasDocChannels)
      .set({ openerAgentId: 'agent-1' })
      .where(eq(canvasDocChannels.documentId, doc.id))
      .run();
    const routes = Array.from({ length: size }, (_, index) => ({
      id: `page-route-${start + index}`,
      on: 'task.*',
      to: 'agent:owner' as const,
      turn: { mode: 'immediate' as const, maxBatch: 100 },
    }));
    f.grants.configure(doc.id, { routes }, f.actor);
    for (const route of routes)
      f.grants.grant(
        { documentId: doc.id, routeId: route.id, expiresAt: '2026-10-02T00:00:00.000Z' },
        f.actor
      );
    const input = new DocChannelIngest(f.store, () => new Date(NOW)).accept(
      { v: 1, id: randomUUID(), type: 'task.changed', payload: { start } },
      (tx) => ({
        documentId: doc.id,
        scope: FROM,
        documentLabel: doc.title,
        provenance: {},
        routes: f.grants.getCurrentRoutes(doc.id, 'task.changed', f.actor, tx),
      })
    );
    if (input.deliveries.length !== size)
      throw new Error('Accepted page fixture did not route every granted input');
    for (const delivery of input.deliveries) {
      if (!delivery.batchId) throw new Error('Accepted page fixture lacks a batch');
      // Pagination needs real protected source/queue acceptance, not slice-selection coverage.
      // Each declared route has exactly this one input, below its actual maxBatch ceiling.
      const batch = f.store.getBatch(delivery.batchId)!;
      const ref = {
        kind: 'document_event_batch' as const,
        batchId: batch.batchId,
        sourceGeneration: batch.generation,
      };
      f.admission.source.refresh(ref);
      receipts.push(f.admission.acceptance.accept(ref).receipt);
    }
  }
  return receipts;
}
