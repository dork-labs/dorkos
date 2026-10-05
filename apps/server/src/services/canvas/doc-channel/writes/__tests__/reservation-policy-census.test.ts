/** Complete sole-ledger scans over migrated FILE SQLite and genuine consumed approvals. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvals,
  canvasDocGrants,
  canvasDocIdentityIntents,
  canvasDocWriteIntents,
  eq,
  createDb,
} from '@dorkos/db';
import { rawByteHash } from '../checkbox-bytes.js';
import { preEffectCheckboxConflict } from '../checkbox-evidence.js';
import { completionFixture } from './completion-fixtures.js';
import {
  scanCheckboxReservationPolicies,
  resolveCheckboxSqlScope,
} from '../reservation-policy-census.js';
import { CheckboxReservationCensusError } from '../intent-reservations.js';
import type { DocWriteIntentRow } from '../../store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const h = await completionFixture();
  cleanups.push(h.cleanup);
  return h;
}
function copy(row: DocWriteIntentRow, ordinal: number): DocWriteIntentRow {
  const next = structuredClone(row);
  next.intentId = `intent-${String(ordinal).padStart(5, '0')}`;
  next.eventId = randomUUID();
  const input = { ...(next.input as object), eventId: next.eventId };
  next.input = input;
  next.envelopeHash = rawByteHash(Buffer.from(JSON.stringify(input)));
  next.evidence = {
    ...(next.evidence as object),
    tempPath: join(next.resolvedCwd, `.dork-checkbox-${next.intentId}.tmp`),
  };
  return next;
}

describe('original checkbox reservation policy census', () => {
  it('finishes more than two keyset pages and counts log reservations as rate only', async () => {
    const h = await fixture();
    h.http.channels.transaction((tx) => {
      for (let index = 0; index < 205; index++)
        tx.insert(canvasDocWriteIntents).values(copy(h.prepared, index)).run();
    });
    const summary = h.http.channels.transaction((tx) =>
      scanCheckboxReservationPolicies(tx, { documentId: h.prepared.documentId })
    );
    expect(summary.raw.validated).toBe(205);
    expect(summary.raw.installation.originals).toBe(205);
    expect(summary.installation).toEqual({ rateUnits: 205, originals: 0, bytes: 0 });
    expect(summary.document).toEqual(summary.installation);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it('validates original grant policy on the final page even when all R1 row shapes are valid', async () => {
    const h = await fixture();
    h.http.channels.transaction((tx) => {
      for (let index = 0; index < 205; index++) {
        const row = copy(h.prepared, index);
        if (index === 204) {
          const evidence = row.evidence as { authority: { grantRevision: number } };
          row.evidence = { ...evidence, authority: { ...evidence.authority, grantRevision: 2 } };
        }
        tx.insert(canvasDocWriteIntents).values(row).run();
      }
    });
    expect(() =>
      h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, {
          documentId: h.prepared.documentId,
          eventId: h.prepared.eventId,
        })
      )
    ).toThrow(CheckboxReservationCensusError);
    expect(h.http.channels.getChannel(h.prepared.documentId)?.nextDocSeq).toBe(1);
  });

  it('does not decide vacancy before a corrupt last page is checked', async () => {
    const h = await fixture();
    h.http.channels.transaction((tx) => {
      for (let index = 0; index < 205; index++)
        tx.insert(canvasDocWriteIntents).values(copy(h.prepared, index)).run();
      tx.update(canvasDocWriteIntents)
        .set({ status: 'failed' })
        .where(eq(canvasDocWriteIntents.intentId, 'intent-00204'))
        .run();
    });
    expect(() =>
      h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, {
          documentId: h.prepared.documentId,
          eventId: randomUUID(),
        })
      )
    ).toThrow(CheckboxReservationCensusError);
  });

  it('retains opaque terminal conflict UUID without pretending it has an event projection', async () => {
    const h = await fixture();
    const request = { ...h.input, expectedFileVersion: 'opaque-server-version' };
    const built = preEffectCheckboxConflict(
      request,
      h.approved,
      rawByteHash(Buffer.from(JSON.stringify(request))),
      new Date().toISOString()
    );
    h.http.channels.insertWriteIntent(built.intent);
    const summary = h.http.channels.transaction((tx) =>
      scanCheckboxReservationPolicies(tx, {
        documentId: h.input.documentId,
        eventId: h.input.eventId,
        routeId: 'checkbox',
      })
    );
    expect(summary.raw.matchingIntent?.status).toBe('conflict');
    expect(summary.matching).toBeNull();
    expect(summary.installation.rateUnits).toBe(0);
  });

  it('keeps expired and revoked original policy held but rejects altered original revision', async () => {
    const h = await fixture();
    h.http.channels.insertWriteIntent(h.prepared);
    h.db
      .update(canvasDocGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(canvasDocGrants.grantId, h.approved.grantId))
      .run();
    const future = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(h.granted.grant.expiresAt!) + 86400000);
    try {
      expect(
        h.http.channels.transaction((tx) =>
          scanCheckboxReservationPolicies(tx, {
            documentId: h.input.documentId,
            eventId: h.input.eventId,
          })
        ).document.rateUnits
      ).toBe(1);
    } finally {
      future.mockRestore();
    }
    h.db
      .update(canvasDocGrants)
      .set({ revision: 2 })
      .where(eq(canvasDocGrants.grantId, h.approved.grantId))
      .run();
    expect(() =>
      h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, { documentId: h.input.documentId })
      )
    ).toThrow(CheckboxReservationCensusError);
  });

  it('actual approval purge remains unavailable across file reopen and cannot use copied evidence', async () => {
    const h = await fixture();
    h.http.channels.insertWriteIntent(h.prepared);
    h.approvals.purgeExpired();
    const grant = h.http.channels.getGrant(h.approved.grantId)!;
    // The real service keeps currently unexpired rows; force the actual retained original past its purge boundary.
    h.db
      .update(approvals)
      .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(approvals.id, grant.approvalId!))
      .run();
    h.approvals.purgeExpired();
    expect(
      h.db.select().from(approvals).where(eq(approvals.id, grant.approvalId!)).get()
    ).toBeUndefined();
    const second = createDb(h.file);
    try {
      expect(() =>
        second.transaction((tx) =>
          scanCheckboxReservationPolicies(tx, { documentId: h.input.documentId })
        )
      ).toThrow(CheckboxReservationCensusError);
    } finally {
      second.$client.close();
    }
    expect(h.http.channels.getGrant(h.approved.grantId)?.approvalEvidence).toEqual(
      grant.approvalEvidence
    );
  });

  it('validates target and scope through global aliases rather than a document-filtered shortcut', async () => {
    const h = await fixture();
    const now = new Date().toISOString();
    h.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'global-alias',
        documentId: h.input.documentId,
        fromScope: 'session:old',
        toScope: 'session:new',
        sourceId: 'source',
        sourceGeneration: 'generation',
        evidence: {},
        status: 'applied',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:old'))).toBe(
      'session:new'
    );
    h.db
      .update(canvasDocIdentityIntents)
      .set({ status: 'in_doubt' })
      .where(eq(canvasDocIdentityIntents.intentId, 'global-alias'))
      .run();
    expect(() =>
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:old'))
    ).toThrow(CheckboxReservationCensusError);
  });

  it('refuses unknown initial scopes and applied unknown alias tails without releasing held policy', async () => {
    const h = await fixture();
    const now = new Date().toISOString();
    h.http.channels.insertWriteIntent(h.prepared);
    for (const scope of ['', ':bad', 'future:owner', 'session:', 'room:'])
      expect(() => h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, scope))).toThrow(
        CheckboxReservationCensusError
      );
    expect(
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'room:actual-room'))
    ).toBe('room:actual-room');
    expect(
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:actual-session'))
    ).toBe('session:actual-session');
    h.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'unknown-tail',
        documentId: h.input.documentId,
        fromScope: 'session:old',
        toScope: ':bad',
        sourceId: 'source',
        sourceGeneration: 'generation',
        evidence: {},
        status: 'applied',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const target of [':bad', 'future:owner', '', 'room:', 'session:']) {
      h.db
        .update(canvasDocIdentityIntents)
        .set({ toScope: target })
        .where(eq(canvasDocIdentityIntents.intentId, 'unknown-tail'))
        .run();
      expect(() =>
        h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:old'))
      ).toThrow(CheckboxReservationCensusError);
    }
    h.db
      .update(canvasDocIdentityIntents)
      .set({ toScope: 'session:canonical' })
      .where(eq(canvasDocIdentityIntents.intentId, 'unknown-tail'))
      .run();
    expect(h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:old'))).toBe(
      'session:canonical'
    );
    expect(
      h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, { documentId: h.input.documentId })
      ).document.rateUnits
    ).toBe(1);
  });

  it('rejects accessor requests without invoking their getter', async () => {
    const h = await fixture();
    let reads = 0;
    const requested = Object.defineProperty({}, 'documentId', {
      enumerable: true,
      get() {
        reads++;
        return h.input.documentId;
      },
    });
    expect(() =>
      h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, requested as { documentId: string })
      )
    ).toThrow(CheckboxReservationCensusError);
    expect(reads).toBe(0);
  });

  it('refuses the 1025th global alias row, conflicting targets and cycles', async () => {
    const h = await fixture();
    const now = new Date().toISOString();
    h.http.channels.transaction((tx) => {
      for (let i = 0; i < 1025; i++)
        tx.insert(canvasDocIdentityIntents)
          .values({
            intentId: `fan-${i}`,
            documentId: h.input.documentId,
            fromScope: 'session:old',
            toScope: 'session:new',
            sourceId: 'source',
            sourceGeneration: 'generation',
            evidence: {},
            status: 'applied',
            createdAt: now,
            updatedAt: now,
          })
          .run();
    });
    expect(() =>
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:old'))
    ).toThrow(CheckboxReservationCensusError);
    h.db.delete(canvasDocIdentityIntents).run();
    for (const [id, from, to] of [
      ['a', 'session:a', 'session:b'],
      ['b', 'session:a', 'session:c'],
    ])
      h.db
        .insert(canvasDocIdentityIntents)
        .values({
          intentId: id!,
          documentId: h.input.documentId,
          fromScope: from!,
          toScope: to!,
          sourceId: 'source',
          sourceGeneration: 'generation',
          evidence: {},
          status: 'applied',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    expect(() =>
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:a'))
    ).toThrow(CheckboxReservationCensusError);
    h.db.delete(canvasDocIdentityIntents).where(eq(canvasDocIdentityIntents.intentId, 'b')).run();
    h.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'cycle',
        documentId: h.input.documentId,
        fromScope: 'session:b',
        toScope: 'session:a',
        sourceId: 'source',
        sourceGeneration: 'generation',
        evidence: {},
        status: 'applied',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() =>
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:a'))
    ).toThrow(CheckboxReservationCensusError);
  });

  it('permits a terminal lookup after 1024 moves and refuses the 1025th move', async () => {
    const h = await fixture();
    const now = new Date().toISOString();
    h.http.channels.transaction((tx) => {
      for (let i = 0; i < 1024; i++)
        tx.insert(canvasDocIdentityIntents)
          .values({
            intentId: `alias-${i}`,
            documentId: h.input.documentId,
            fromScope: `session:${i}`,
            toScope: `session:${i + 1}`,
            sourceId: 'source',
            sourceGeneration: 'generation',
            evidence: {},
            status: 'applied',
            createdAt: now,
            updatedAt: now,
          })
          .run();
    });
    expect(h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:0'))).toBe(
      'session:1024'
    );
    h.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'one-too-many',
        documentId: h.input.documentId,
        fromScope: 'session:1024',
        toScope: 'session:1025',
        sourceId: 'source',
        sourceGeneration: 'generation',
        evidence: {},
        status: 'applied',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() =>
      h.http.channels.transaction((tx) => resolveCheckboxSqlScope(tx, 'session:0'))
    ).toThrow(CheckboxReservationCensusError);
  });
});
