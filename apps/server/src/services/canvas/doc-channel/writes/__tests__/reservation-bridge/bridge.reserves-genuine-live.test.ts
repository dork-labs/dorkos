import { fixture, terminal, recovery } from './harness.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { canvasDocuments, canvasDocEvents, canvasDocWriteIntents, eq } from '@dorkos/db';
import { DOC_INGEST_LIMITS } from '../../../current/accounting.js';
import { DocIngestRefusal } from '../../../ingest-types.js';
import { scanCheckboxReservationPolicies } from '../../reservation-policy-census.js';
import { rawByteHash } from '../../checkbox-bytes.js';
import { createCheckboxReservationBridge } from '../../reservation-bridge.js';
import { validateCheckboxEvidence } from '../../checkbox-evidence.js';
import type { DocEventRow } from '../../../store.js';

describe('fixed owning checkbox reservation bridge', () => {
  it('reserves a genuine live prepared row without an event, sequence or file effect', async () => {
    const h = await fixture();
    const before = h.http.channels.getChannel(h.input.documentId)!;
    const snapshot = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: snapshot,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toEqual(h.prepared);
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
  });

  it('converts exactly one existing replaced original and audits its exact recorded terminal receipt', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    let appended: DocEventRow | undefined;
    h.authority.transaction((tx) => {
      appended = h.bridge.convertOwnReservationInTransaction(input, tx);
      terminal(tx, row, appended, h);
    });
    const event = h.http.channels.getEvent(row.documentId, row.eventId)!;
    expect(event).toEqual(appended);
    expect(event.type).toBe('md.task.toggled');
    expect(event.provenance).toEqual({
      transport: 'host',
      producer: 'verified_checkbox',
      intentId: row.intentId,
    });
    expect(event.payload).toMatchObject({
      beforeFileVersion: row.beforeHash,
      afterFileVersion: row.afterHash,
    });
    expect(event.envelopeHash).not.toBe(row.envelopeHash);
    expect(
      validateCheckboxEvidence(h.http.channels.getWriteIntent(row.intentId)!).receipt?.status
    ).toBe('changed');
    expect(h.http.channels.getChannel(row.documentId)?.nextDocSeq).toBe(event.docSeq + 2);
  });

  it('credits the exact owning pending-turn row once against independently lowered rate and pending caps', async () => {
    const h = await fixture(true);
    const row = await h.replace();
    const strict = createCheckboxReservationBridge(h.authority, h.http.channels, {
      ...DOC_INGEST_LIMITS,
      pendingEvents: 1,
      pendingBytes: 10000,
      eventsPerMinute: 1,
    });
    const input = await recovery(h, row);
    h.authority.transaction((tx) => {
      const event = strict.convertOwnReservationInTransaction(input, tx);
      terminal(tx, row, event, h);
    });
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeDefined();
  });

  it.each(['eventsPerMinute', 'pendingEvents'] as const)(
    'does not credit another original held row against the lowered %s cap',
    async (cap) => {
      const h = await fixture(true);
      const other = structuredClone(h.prepared);
      other.intentId = 'other-held-original';
      other.eventId = randomUUID();
      other.input = { ...(other.input as object), eventId: other.eventId };
      other.envelopeHash = rawByteHash(Buffer.from(JSON.stringify(other.input)));
      other.evidence = {
        ...(other.evidence as object),
        tempPath: join(other.resolvedCwd, `.dork-checkbox-${other.intentId}.tmp`),
      };
      const row = await h.replace();
      h.http.channels.insertWriteIntent(other);
      const held = h.http.channels.transaction((tx) =>
        scanCheckboxReservationPolicies(tx, {
          documentId: row.documentId,
          eventId: row.eventId,
          routeId: h.approved.routeId!,
        })
      );
      expect(held.document.rateUnits).toBe(2);
      expect(held.document.originals).toBe(2);
      expect(held.route.originals).toBe(2);
      const strict = createCheckboxReservationBridge(h.authority, h.http.channels, {
        ...DOC_INGEST_LIMITS,
        [cap]: 1,
      });
      const input = await recovery(h, row);
      const before = h.http.channels.getChannel(row.documentId)!;
      let refusal: unknown;
      try {
        h.authority.transaction((tx) => strict.convertOwnReservationInTransaction(input, tx));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DocIngestRefusal);
      expect((refusal as DocIngestRefusal).status).toBe(429);
      expect((refusal as DocIngestRefusal).code).toBe(
        cap === 'eventsPerMinute' ? 'DOC_EVENT_RATE_LIMIT' : 'DOC_EVENT_BACKLOG_FULL'
      );
      expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
      expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
      expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
      expect(h.http.channels.getWriteIntent(other.intentId)).toEqual(other);
    }
  );

  it('uses the actual fresh SQL label and rejects oversized pending context before any admission', async () => {
    const h = await fixture(true);
    const label = '😀"</doc_events>--- END '.repeat(30).slice(0, 500);
    h.db
      .update(canvasDocuments)
      .set({ title: label })
      .where(eq(canvasDocuments.id, h.input.documentId))
      .run();
    const fresh = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: fresh,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeDefined();
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
    const invalid = await fixture(true);
    invalid.db
      .update(canvasDocuments)
      .set({ title: '😀'.repeat(501) })
      .where(eq(canvasDocuments.id, invalid.input.documentId))
      .run();
    const second = await invalid.authority.refreshCurrent(
      invalid.input,
      invalid.actor,
      invalid.approved
    );
    expect(() =>
      invalid.authority.transaction((tx) =>
        invalid.bridge.insertPreparedInTransaction(
          {
            candidate: invalid.prepared,
            liveSubject: {
              kind: 'live',
              request: invalid.input,
              actor: invalid.actor,
              approved: invalid.approved,
            },
            freshSnapshot: second,
          },
          tx
        )
      )
    ).toThrow();
    expect(invalid.http.channels.getWriteIntent(invalid.prepared.intentId)).toBeUndefined();
    expect(invalid.http.channels.getChannel(invalid.input.documentId)?.nextDocSeq).toBe(1);
  });

  it('log-only approval holds rate without manufacturing runtime context or a pending slot', async () => {
    const h = await fixture();
    h.db
      .update(canvasDocuments)
      .set({ title: '😀'.repeat(1000) })
      .where(eq(canvasDocuments.id, h.input.documentId))
      .run();
    const fresh = await h.authority.refreshCurrent(h.input, h.actor, h.approved);
    h.authority.transaction((tx) =>
      h.bridge.insertPreparedInTransaction(
        {
          candidate: h.prepared,
          liveSubject: { kind: 'live', request: h.input, actor: h.actor, approved: h.approved },
          freshSnapshot: fresh,
        },
        tx
      )
    );
    expect(h.http.channels.getWriteIntent(h.prepared.intentId)).toBeDefined();
    expect(h.http.channels.getEvent(h.input.documentId, h.input.eventId)).toBeUndefined();
  });

  it('rolls back conversion without the sanctioned terminal projection even when caller catches its own omission', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    const before = h.http.channels.getChannel(row.documentId)!;
    expect(() =>
      h.authority.transaction((tx) => {
        h.bridge.convertOwnReservationInTransaction(input, tx);
      })
    ).toThrow('terminal receipt');
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
  });

  it.each(['timestamp', 'receipt', 'event'] as const)(
    'rolls back a converted original when its final %s evidence is altered',
    async (kind) => {
      const h = await fixture();
      const row = await h.replace();
      const input = await recovery(h, row);
      const before = h.http.channels.getChannel(row.documentId)!;
      expect(() =>
        h.authority.transaction((tx) => {
          const event = h.bridge.convertOwnReservationInTransaction(input, tx);
          terminal(tx, row, event, h);
          if (kind === 'timestamp')
            tx.update(canvasDocWriteIntents)
              .set({ updatedAt: 'not-a-time' })
              .where(eq(canvasDocWriteIntents.intentId, row.intentId))
              .run();
          else if (kind === 'receipt')
            tx.update(canvasDocWriteIntents)
              .set({
                evidence: {
                  ...(row.evidence as object),
                  receipt: {
                    status: 'changed',
                    fileVersion: row.afterHash,
                    receipt: { id: row.eventId, status: 'recorded', docSeq: event.docSeq + 1 },
                  },
                },
              })
              .where(eq(canvasDocWriteIntents.intentId, row.intentId))
              .run();
          else
            tx.update(canvasDocEvents)
              .set({ receivedAt: '2020-01-01T00:00:00.000Z' })
              .where(eq(canvasDocEvents.eventId, row.eventId))
              .run();
        })
      ).toThrow(
        kind === 'timestamp'
          ? ZodError
          : kind === 'receipt'
            ? 'Checkbox terminal projection changed.'
            : 'Checkbox converted event changed before commit.'
      );
      expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
      expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
      expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    }
  );
});
