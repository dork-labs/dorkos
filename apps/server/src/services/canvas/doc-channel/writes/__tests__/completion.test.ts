import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CanvasChannelRouteSchema } from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelIngest } from '../../ingest.js';
import { DOC_INGEST_LIMITS } from '../../accounting.js';
import {
  canvasDocGrants,
  canvasDocEvents,
  canvasDocBatches,
  canvasDocuments,
  eq,
  sql,
} from '@dorkos/db';
import {
  createCheckboxCompletion,
  createOriginalCheckboxCompletion,
  projectVerifiedCheckbox,
  type CheckboxTransactionalIngest,
} from '../completion.js';
import { completionFixture } from './completion-fixtures.js';
import { envelopeIdentity } from '../../envelope.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(agentRoute = false) {
  const h = await completionFixture(agentRoute);
  cleanups.push(h.cleanup);
  return h;
}
function heldIngest(h: Awaited<ReturnType<typeof fixture>>): CheckboxTransactionalIngest {
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
it('projects exact host bytes without reusing the original request hash or disclosing source paths', async () => {
  const h = await fixture();
  const p = projectVerifiedCheckbox(h.prepared);
  expect(p.event).toEqual({
    v: 1,
    id: h.input.eventId,
    type: 'md.task.toggled',
    payload: {
      line: 1,
      done: true,
      textHash: h.input.textHash,
      beforeFileVersion: h.edit.beforeHash,
      afterFileVersion: h.edit.afterHash,
    },
  });
  expect(p.identity).toEqual(envelopeIdentity(p.event));
  expect(p.identity.hash).not.toBe(h.prepared.envelopeHash);
  expect(p.provenance).toEqual({
    transport: 'host',
    producer: 'verified_checkbox',
    intentId: h.prepared.intentId,
  });
  expect(JSON.stringify(p.event)).not.toContain(h.path);
  expect(Object.isFrozen(p.intent.evidence)).toBe(true);
  expect(() => {
    p.event.type = 'app.changed';
  }).toThrow();
});
it('keeps the actual prepared ledger absent when the required reservation seam refuses', async () => {
  const h = await fixture();
  const original = await h.currentAccess(h.prepared);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original,
    ingest: heldIngest(h),
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.admission.requirePreparedAdmission(h.prepared, tx))).toThrow(
    'Shared reservation seam held'
  );
  expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
  expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
});
it('preserves the genuine replaced intent when common ingest is unavailable; no terminal upgrade', async () => {
  const h = await fixture(),
    row = await h.replace();
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(row),
    ingest: heldIngest(h),
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'Shared ingest seam held'
  );
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  expect(h.http.channels.listDeliveries(row.documentId, row.eventId)).toEqual([]);
});
it('checks the genuine current original grant inside the caller transaction, not a replacement grant', async () => {
  const h = await fixture(),
    row = await h.replace();
  const original = await h.currentAccess(row);
  h.db
    .update(canvasDocGrants)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(canvasDocGrants.grantId, row.grantId))
    .run();
  const accept = vi.fn(heldIngest(h).acceptVerifiedCheckboxInTransaction);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original,
    ingest: { ...heldIngest(h), acceptVerifiedCheckboxInTransaction: accept },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow();
  expect(accept).not.toHaveBeenCalled();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it.each(['missing', 'changed', 'prepared', 'legacy'] as const)(
  'rejects %s ownership before delegating completion',
  async (kind) => {
    const h = await fixture(),
      row = await h.replace();
    const intent = structuredClone(row);
    if (kind === 'missing') intent.intentId = 'absent';
    if (kind === 'changed') intent.updatedAt = '2000-01-01T00:00:00.000Z';
    if (kind === 'prepared') intent.status = 'prepared';
    if (kind === 'legacy') intent.evidence = { ...(intent.evidence as object), v: 1 };
    const accept = vi.fn(heldIngest(h).acceptVerifiedCheckboxInTransaction);
    const b = createCheckboxCompletion({
      store: h.http.channels,
      original: await h.currentAccess(row),
      ingest: { ...heldIngest(h), acceptVerifiedCheckboxInTransaction: accept },
      notifyCommitted: () => undefined,
    });
    expect(() => h.transaction((tx) => b.completion.completeVerified(intent, tx))).toThrow();
    expect(accept).not.toHaveBeenCalled();
  }
);
it('rejects a fake receipt without an actual event/outbox and keeps the original ledger', async () => {
  const h = await fixture(),
    row = await h.replace();
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(row),
    ingest: {
      ...heldIngest(h),
      acceptVerifiedCheckboxInTransaction: () => ({
        id: row.eventId,
        status: 'recorded',
        docSeq: 1,
      }),
    },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'durable completion'
  );
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('rejects an async acceptance and retires its captured caller handle before a late write', async () => {
  const h = await fixture(),
    row = await h.replace();
  let late: unknown;
  const bad = async (
    _candidate: unknown,
    _original: unknown,
    tx: import('@dorkos/db').DbTransaction
  ) => {
    await Promise.resolve();
    try {
      h.http.channels.transitionWriteIntent(
        row.intentId,
        'replaced',
        { status: 'committed', errorCode: null, updatedAt: row.updatedAt, evidence: row.evidence },
        tx
      );
    } catch (error) {
      late = error;
    }
    throw new Error('Late rejection');
  };
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(row),
    ingest: {
      ...heldIngest(h),
      acceptVerifiedCheckboxInTransaction:
        bad as unknown as CheckboxTransactionalIngest['acceptVerifiedCheckboxInTransaction'],
    },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'synchronous'
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(late).toBeInstanceOf(Error);
  expect(String(late)).toContain('no longer active');
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('contains throwing and rejecting postcommit hints', async () => {
  const h = await fixture();
  const hint = vi.fn(() => {
    throw new Error('Hint unavailable');
  });
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(h.prepared),
    ingest: heldIngest(h),
    notifyCommitted: hint,
  });
  expect(b.completion.notifyCommitted!(h.input.documentId)).toBeUndefined();
  expect(hint).toHaveBeenCalledOnce();
});
it('refuses a foreign real FILE transaction even while the owning database is separately active', async () => {
  const h = await fixture(),
    foreign = await fixture(),
    row = await h.replace();
  const original = await h.currentAccess(row);
  const requireOriginal = vi.fn(original.requireOriginalCompletionAccess);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: { requireOriginalCompletionAccess: requireOriginal },
    ingest: heldIngest(h),
    notifyCommitted: () => undefined,
  });
  expect(() =>
    h.transaction(() => foreign.transaction((tx) => b.completion.completeVerified(row, tx)))
  ).toThrow('Wrong caller transaction');
  expect(requireOriginal).not.toHaveBeenCalled();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it.each(['route', 'revision', 'reason', 'scope', 'extra'] as const)(
  'refuses %s access substitution after the actual original grant gate',
  async (kind) => {
    const h = await fixture(),
      row = await h.replace(),
      original = await h.currentAccess(row);
    const accept = vi.fn(heldIngest(h).acceptVerifiedCheckboxInTransaction);
    const b = createCheckboxCompletion({
      store: h.http.channels,
      original: {
        requireOriginalCompletionAccess(intent, tx) {
          const access = original.requireOriginalCompletionAccess(intent, tx);
          if (kind === 'route') access.routes[0]!.route.id = 'later-route';
          if (kind === 'revision') access.routes[0]!.grantRevision!++;
          if (kind === 'reason') access.routes[0]!.reason = 'approval_required';
          if (kind === 'scope') access.scope = 'session:unrelated';
          if (kind === 'extra') access.routes.push(access.routes[0]!);
          return access;
        },
      },
      ingest: { ...heldIngest(h), acceptVerifiedCheckboxInTransaction: accept },
      notifyCommitted: () => undefined,
    });
    expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
      'original completion route'
    );
    expect(accept).not.toHaveBeenCalled();
  }
);
it('rolls back actual partial event and docSeq writes when the delegated outbox is absent', async () => {
  const h = await fixture(),
    row = await h.replace();
  const channel = h.http.channels.getChannel(row.documentId)!;
  const convert = await h.conversion(row);
  let observedPartial: { eventId: string; docSeq: number; nextDocSeq: number } | undefined;
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(row),
    ingest: {
      ...heldIngest(h),
      // Deliberately defective delegate: this is a negative atomicity control, not source activation.
      acceptVerifiedCheckboxInTransaction(candidate, _original, tx) {
        expect(candidate.intent).toEqual(row);
        const saved = convert(tx);
        expect(h.http.channels.getEvent(row.documentId, row.eventId, tx)).toEqual(saved);
        observedPartial = {
          eventId: saved.eventId,
          docSeq: saved.docSeq,
          nextDocSeq: h.http.channels.getChannel(row.documentId, tx)!.nextDocSeq,
        };
        return { id: saved.eventId, docSeq: saved.docSeq, status: 'recorded' };
      },
    },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'durable completion'
  );
  expect(observedPartial).toEqual({
    eventId: row.eventId,
    docSeq: channel.nextDocSeq,
    nextDocSeq: channel.nextDocSeq + 1,
  });
  expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  expect(h.http.channels.getChannel(row.documentId)).toEqual(channel);
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('rejects structural reentry before nested delegation', async () => {
  const h = await fixture(),
    row = await h.replace(),
    original = await h.currentAccess(row);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: {
      requireOriginalCompletionAccess(intent, tx) {
        b.completion.completeVerified(intent, tx);
        return original.requireOriginalCompletionAccess(intent, tx);
      },
    },
    ingest: heldIngest(h),
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'already active'
  );
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('preserves the original transient authority failure and owning replaced evidence', async () => {
  const h = await fixture(),
    row = await h.replace();
  const transient = Object.assign(
    new Error('Filesystem unavailable', { cause: new Error('EIO') }),
    { code: 'EIO' }
  );
  const accept = vi.fn(heldIngest(h).acceptVerifiedCheckboxInTransaction);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: {
      requireOriginalCompletionAccess() {
        throw transient;
      },
    },
    ingest: { ...heldIngest(h), acceptVerifiedCheckboxInTransaction: accept },
    notifyCommitted: () => undefined,
  });
  let caught: unknown;
  try {
    h.transaction((tx) => b.completion.completeVerified(row, tx));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(transient);
  expect(accept).not.toHaveBeenCalled();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('rejects an asynchronous original-access port before any acceptance', async () => {
  const h = await fixture(),
    row = await h.replace();
  const accept = vi.fn(heldIngest(h).acceptVerifiedCheckboxInTransaction);
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: {
      requireOriginalCompletionAccess: (async () => {
        await Promise.resolve();
        throw new Error('Deferred refusal');
      }) as unknown as import('../completion.js').OriginalCheckboxCompletionAccess['requireOriginalCompletionAccess'],
    },
    ingest: { ...heldIngest(h), acceptVerifiedCheckboxInTransaction: accept },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.completion.completeVerified(row, tx))).toThrow(
    'synchronous'
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(accept).not.toHaveBeenCalled();
  expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
});
it('rejects an asynchronous prepared-admission port without inserting an intent', async () => {
  const h = await fixture();
  const b = createCheckboxCompletion({
    store: h.http.channels,
    original: await h.currentAccess(h.prepared),
    ingest: {
      ...heldIngest(h),
      requireCheckboxPreparedAdmissionInTransaction: (async () => {
        await Promise.resolve();
        throw new Error('Deferred reservation');
      }) as unknown as CheckboxTransactionalIngest['requireCheckboxPreparedAdmissionInTransaction'],
    },
    notifyCommitted: () => undefined,
  });
  expect(() => h.transaction((tx) => b.admission.requirePreparedAdmission(h.prepared, tx))).toThrow(
    'synchronous'
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeUndefined();
});

async function originalInput(
  h: Awaited<ReturnType<typeof fixture>>,
  row: import('../../store.js').DocWriteIntentRow
) {
  return {
    intentId: row.intentId,
    subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
    freshSnapshot: await h.authority.refreshRecoveryCurrent(row, h.approved),
  };
}
function fixedCompletion(
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
async function seedOriginalBatch(
  h: Awaited<ReturnType<typeof fixture>>,
  row: import('../../store.js').DocWriteIntentRow,
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
