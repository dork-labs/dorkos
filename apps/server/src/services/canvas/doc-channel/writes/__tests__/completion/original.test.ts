import { fixture, originalInput, fixedCompletion, seedOriginalBatch } from './harness.js';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canvasDocEvents, canvasDocBatches, eq, sql } from '@dorkos/db';
import { projectVerifiedCheckbox } from '../../completion.js';

it('completes the actual original log-route effect, status and terminal receipt in one A-owned transaction', async () => {
  const h = await fixture(),
    row = await h.replace();
  const input = await originalInput(h, row),
    notify = vi.fn(() => undefined);
  const complete = fixedCompletion(h, notify);
  const receipt = complete.complete(input);
  expect(receipt).toEqual({
    status: 'changed',
    fileVersion: row.afterHash,
    receipt: { id: row.eventId, status: 'recorded', docSeq: 1 },
  });
  const original = h.http.channels.getEvent(row.documentId, row.eventId)!;
  expect(original.provenance).toEqual(projectVerifiedCheckbox(row).provenance);
  expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([
    expect.objectContaining({
      routeId: 'checkbox',
      status: 'routed',
      reason: 'no_turn',
      batchId: null,
    }),
  ]);
  const status = h.db
    .select()
    .from(canvasDocEvents)
    .where(sql`${canvasDocEvents.documentId}=${row.documentId} AND ${canvasDocEvents.docSeq}=2`)
    .get()!;
  expect(status.payload).toEqual({
    eventId: row.eventId,
    routeId: 'checkbox',
    status: 'routed',
    reason: 'no_turn',
  });
  expect(h.http.channels.getChannel(row.documentId)!.nextDocSeq).toBe(3);
  expect(h.http.channels.getWriteIntent(row.intentId)!.status).toBe('committed');
  expect(notify).toHaveBeenCalledExactlyOnceWith(row.documentId);
});
it.each([false, true])(
  'joins an original %s waiting batch without changing its generation or deadline',
  async (waiting) => {
    const h = await fixture(true),
      row = await h.replace();
    const prior = await seedOriginalBatch(h, row, waiting),
      before = h.http.channels.getChannel(row.documentId)!;
    const receipt = fixedCompletion(h).complete(await originalInput(h, row));
    const batch = h.http.channels.getBatch(prior.batch.batchId)!;
    expect(batch).toMatchObject({
      batchId: prior.batch.batchId,
      generation: prior.batch.generation,
      dueAt: prior.batch.dueAt,
      status: prior.batch.status,
      createdAt: prior.batch.createdAt,
      grantId: prior.batch.grantId,
      grantRevision: prior.batch.grantRevision,
      inputEventIds: [prior.id, row.eventId],
    });
    const delivery = h.http.channels.listDeliveries(row.documentId, row.eventId)[0]!;
    expect(delivery).toMatchObject({
      batchId: batch.batchId,
      status: waiting ? 'waiting' : 'pending',
      reason: null,
    });
    const status = h.db
      .select()
      .from(canvasDocEvents)
      .where(
        sql`${canvasDocEvents.documentId}=${row.documentId} AND ${canvasDocEvents.docSeq}=${before.nextDocSeq + 1}`
      )
      .get()!;
    expect(status.payload).toEqual({
      eventId: row.eventId,
      routeId: 'checkbox',
      status: waiting ? 'waiting' : 'pending',
      batchId: batch.batchId,
    });
    expect(receipt.receipt.docSeq).toBe(before.nextDocSeq);
    expect(h.http.channels.getChannel(row.documentId)!.nextDocSeq).toBe(before.nextDocSeq + 2);
  }
);
it('rolls the original event, outbox and terminal back when an initial status trigger refuses', async () => {
  const h = await fixture(true),
    row = await h.replace(),
    before = h.http.channels.getChannel(row.documentId)!;
  const input = await originalInput(h, row),
    notify = vi.fn(() => undefined);
  h.db.run(
    sql`CREATE TRIGGER refuse_checkbox_status BEFORE INSERT ON canvas_doc_events WHEN NEW.type='event.status' BEGIN SELECT RAISE(ABORT,'original status failure'); END`
  );
  expect(() => fixedCompletion(h, notify).complete(input)).toThrow();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([]);
  expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
  expect(h.db.select().from(canvasDocBatches).all()).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});

it('the fixed exit audit rolls back a correlated waiting delivery with a mismatched pending batch', async () => {
  const h = await fixture(true),
    row = await h.replace(),
    prior = await seedOriginalBatch(h, row, true);
  const before = h.http.channels.getChannel(row.documentId)!,
    input = await originalInput(h, row),
    complete = fixedCompletion(h);
  expect(() =>
    h.authority.transaction((tx) => {
      complete.completeInTransaction(input, tx);
      tx.update(canvasDocBatches)
        .set({ status: 'pending' })
        .where(eq(canvasDocBatches.batchId, prior.batch.batchId))
        .run();
    })
  ).toThrow('correlated outbox');
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.getBatch(prior.batch.batchId)).toEqual(prior.batch);
  expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
});
it('caught common status failure still poisons the A-owned scope and cannot commit a fabricated terminal', async () => {
  const h = await fixture(),
    row = await h.replace(),
    input = await originalInput(h, row),
    complete = fixedCompletion(h);
  h.db.run(
    sql`CREATE TRIGGER refuse_checkbox_status BEFORE INSERT ON canvas_doc_events WHEN NEW.type='event.status' BEGIN SELECT RAISE(ABORT,'original status failure'); END`
  );
  expect(() =>
    h.authority.transaction((tx) => {
      try {
        complete.completeInTransaction(input, tx);
      } catch {
        /* Caller cannot forgive the private failure latch. */
      }
    })
  ).toThrow();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  expect(h.http.channels.getChannel(row.documentId)!.nextDocSeq).toBe(1);
});

it.each(['removed_prior', 'extra_input', 'payload', 'generation', 'deadline'] as const)(
  'rolls back joined original batch %s tampering at the fixed exit',
  async (tamper) => {
    const h = await fixture(true),
      row = await h.replace(),
      prior = await seedOriginalBatch(h, row, true);
    const before = h.http.channels.getChannel(row.documentId)!,
      input = await originalInput(h, row),
      complete = fixedCompletion(h);
    expect(() =>
      h.authority.transaction((tx) => {
        complete.completeInTransaction(input, tx);
        const changes =
          tamper === 'removed_prior'
            ? { inputEventIds: [row.eventId] }
            : tamper === 'extra_input'
              ? { inputEventIds: [prior.id, row.eventId, randomUUID()] }
              : tamper === 'payload'
                ? { effectivePayload: { eventIds: [row.eventId] } }
                : tamper === 'generation'
                  ? { generation: randomUUID() }
                  : { dueAt: new Date(Date.parse(prior.batch.dueAt) + 1).toISOString() };
        tx.update(canvasDocBatches)
          .set(changes)
          .where(eq(canvasDocBatches.batchId, prior.batch.batchId))
          .run();
      })
    ).toThrow(tamper === 'generation' || tamper === 'deadline' ? 'batch identity' : 'batch inputs');
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getBatch(prior.batch.batchId)).toEqual(prior.batch);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([]);
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
  }
);

it('retains the genuinely created original batch and generation without a prior batch', async () => {
  const h = await fixture(true),
    row = await h.replace(),
    input = await originalInput(h, row),
    complete = fixedCompletion(h);
  const receipt = complete.complete(input);
  const delivery = h.http.channels.listDeliveries(row.documentId, row.eventId)[0]!;
  const batch = h.http.channels.getBatch(delivery.batchId!)!;
  expect(batch).toMatchObject({
    documentId: row.documentId,
    scope: h.scope,
    routeId: 'checkbox',
    grantId: row.grantId,
    grantRevision: h.approved.grantRevision,
    inputEventIds: [row.eventId],
    effectivePayload: { eventIds: [row.eventId] },
    status: 'pending',
    attempt: 0,
    admissionReceiptId: null,
  });
  expect(receipt.receipt).toEqual({ id: row.eventId, status: 'recorded', docSeq: 1 });
  expect(h.http.channels.getWriteIntent(row.intentId)!.status).toBe('committed');
  expect(h.http.channels.getChannel(row.documentId)!.nextDocSeq).toBe(3);
});

it('rolls back a new valid UUID generation changed after original completion', async () => {
  const h = await fixture(true),
    row = await h.replace(),
    before = h.http.channels.getChannel(row.documentId)!;
  const input = await originalInput(h, row),
    complete = fixedCompletion(h);
  let createdGeneration: string | undefined;
  expect(() =>
    h.authority.transaction((tx) => {
      complete.completeInTransaction(input, tx);
      const delivery = h.http.channels.listDeliveries(row.documentId, row.eventId, tx)[0]!;
      const batch = h.http.channels.getBatch(delivery.batchId!, tx)!;
      createdGeneration = batch.generation;
      const changed = randomUUID();
      expect(changed).not.toBe(createdGeneration);
      tx.update(canvasDocBatches)
        .set({ generation: changed })
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .run();
    })
  ).toThrow('created batch identity');
  expect(createdGeneration).toBeDefined();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([]);
  expect(h.db.select().from(canvasDocBatches).all()).toEqual([]);
  expect(h.db.select().from(canvasDocEvents).all()).toEqual([]);
  expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
});

it('does not bless a new generation changed by an initial-status SQL trigger', async () => {
  const h = await fixture(true),
    row = await h.replace(),
    before = h.http.channels.getChannel(row.documentId)!;
  const changed = randomUUID(),
    input = await originalInput(h, row),
    complete = fixedCompletion(h);
  h.db.run(
    sql.raw(
      `CREATE TRIGGER change_original_generation AFTER INSERT ON canvas_doc_events WHEN NEW.type='event.status' BEGIN UPDATE canvas_doc_batches SET generation='${changed}' WHERE document_id=NEW.document_id; END`
    )
  );
  expect(() => complete.complete(input)).toThrow('created batch identity');
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([]);
  expect(h.db.select().from(canvasDocBatches).all()).toEqual([]);
  expect(h.db.select().from(canvasDocEvents).all()).toEqual([]);
  expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
});
