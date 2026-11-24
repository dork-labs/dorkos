import { fixture, heldIngest } from './harness.js';
import { expect, it, vi } from 'vitest';
import { canvasDocGrants, eq } from '@dorkos/db';
import {
  createCheckboxCompletion,
  projectVerifiedCheckbox,
  type CheckboxTransactionalIngest,
} from '../../completion.js';
import { envelopeIdentity } from '../../../envelope.js';

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
      }) as unknown as import('../../completion.js').OriginalCheckboxCompletionAccess['requireOriginalCompletionAccess'],
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
