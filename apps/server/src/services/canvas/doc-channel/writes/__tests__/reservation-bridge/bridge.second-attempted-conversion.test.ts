import { fixture, terminal, recovery } from './harness.js';
import { describe, expect, it } from 'vitest';
import { createDb, canvasDocGrants, eq } from '@dorkos/db';
import { DocChannelStore } from '../../../store.js';
import { DOC_INGEST_LIMITS } from '../../../current/accounting.js';
import { DocCheckboxAuthority } from '../../authority.js';
import {
  createCheckboxReservationBridge,
  retireCheckboxReservationScope,
} from '../../reservation-bridge.js';
import { createOriginalCheckboxCompletion } from '../../completion.js';
import { CheckboxAuthorityCallbackError } from '../../authority-snapshot.js';
import { canvasDocChannels } from '@dorkos/db';

describe('fixed owning checkbox reservation bridge', () => {
  it('a second attempted conversion poisons the entire scope even if caught after the first terminal CAS', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    expect(() =>
      h.authority.transaction((tx) => {
        const event = h.bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, event, h);
        try {
          h.bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* deliberate caller suppression */
        }
      })
    ).toThrow('Only one checkbox conversion');
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  });

  it('cannot clear the private rollback latch with the returned bridge or any caller object', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    expect(() =>
      h.authority.transaction((tx) => {
        const event = h.bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, event, h);
        try {
          h.bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* intentional */
        }
        expect(() => retireCheckboxReservationScope(tx, h.bridge)).toThrow('scope exit is private');
      })
    ).toThrow('Only one checkbox conversion');
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('a separately active file connection cannot lend a stale transaction authority', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    const foreign = createDb(h.file);
    try {
      expect(() =>
        h.authority.transaction(() =>
          foreign.transaction((tx) => h.bridge.convertOwnReservationInTransaction(input, tx))
        )
      ).toThrow('exact active transaction');
    } finally {
      foreign.$client.close();
    }
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('refuses fake, proxy and different-database stores before binding', async () => {
    const h = await fixture();
    const foreign = createDb(h.file);
    try {
      expect(() =>
        createCheckboxReservationBridge(
          h.authority,
          new DocChannelStore(foreign),
          DOC_INGEST_LIMITS
        )
      ).toThrow('mismatch');
      expect(() =>
        createCheckboxReservationBridge(
          h.authority,
          new Proxy(h.http.channels, {}),
          DOC_INGEST_LIMITS
        )
      ).toThrow('mismatch');
      expect(
        () =>
          new DocCheckboxAuthority({ ...h.deps, store: Object.create(DocChannelStore.prototype) })
      ).toThrow('genuine store transaction database');
    } finally {
      foreign.$client.close();
    }
  });

  it('captures real dependency fields without invoking accessors or proxy traps', async () => {
    const h = await fixture();
    let reads = 0;
    const accessor = { ...h.deps };
    Object.defineProperty(accessor, 'db', {
      get() {
        reads++;
        return h.db;
      },
    });
    expect(() => new DocCheckboxAuthority(accessor)).toThrow('own data');
    expect(reads).toBe(0);
    expect(
      () =>
        new DocCheckboxAuthority(
          new Proxy(h.deps, {
            getPrototypeOf() {
              reads++;
              return Object.prototype;
            },
          })
        )
    ).toThrow('own data');
    expect(reads).toBe(0);
  });

  it('refuses revoked current original authority after the actual filesystem refresh', async () => {
    const h = await fixture();
    const row = await h.replace();
    const input = await recovery(h, row);
    h.db
      .update(canvasDocGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(() =>
      h.authority.transaction((tx) => h.bridge.convertOwnReservationInTransaction(input, tx))
    ).toThrow();
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
  });

  it('retires the original snapshot after a first conversion clock writes, rolls back and throws', async () => {
    const h = await fixture();
    const row = await h.replace();
    const before = h.http.channels.getChannel(row.documentId)!;
    const cause = new Error('configured first conversion clock failed after rolled-back SQL');
    let failClock = false;
    const authority = new DocCheckboxAuthority({
      ...h.deps,
      now: () => {
        if (!failClock) return h.deps.now();
        h.db.$client.exec('SAVEPOINT checkbox_clock');
        h.db.$client
          .prepare('UPDATE canvas_doc_grants SET revision=revision+1 WHERE grant_id=?')
          .run(row.grantId);
        h.db.$client.exec('ROLLBACK TO checkbox_clock; RELEASE checkbox_clock');
        throw cause;
      },
    });
    const bridge = createCheckboxReservationBridge(authority, h.http.channels, DOC_INGEST_LIMITS);
    const completion = createOriginalCheckboxCompletion({
      authority,
      store: h.http.channels,
      policyLimits: DOC_INGEST_LIMITS,
      notifyCommitted: () => undefined,
    });
    const input = {
      intentId: row.intentId,
      subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
      freshSnapshot: await authority.refreshRecoveryCurrent(row, h.approved),
    };
    failClock = true;
    let first: unknown;
    try {
      authority.transaction((tx) => bridge.convertOwnReservationInTransaction(input, tx));
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(CheckboxAuthorityCallbackError);
    expect((first as Error).cause).toBe(cause);
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
    failClock = false;
    expect(() =>
      authority.transaction((tx) => {
        const converted = bridge.convertOwnReservationInTransaction(input, tx);
        terminal(tx, row, converted, { ...h, completion });
      })
    ).toThrow('foreign, stale or already consumed');
    expect(h.http.channels.getWriteIntent(row.intentId)).toEqual(row);
    expect(h.http.channels.getChannel(row.documentId)).toEqual(before);
    expect(h.http.channels.getEvent(row.documentId, row.eventId)).toBeUndefined();
  });

  it('preserves the first thrown undefined and rolls back caught callback failure', async () => {
    const h = await fixture();
    const row = await h.replace();
    let failClock = false;
    const authority = new DocCheckboxAuthority({
      ...h.deps,
      now: () => {
        if (failClock) throw undefined;
        return h.deps.now();
      },
    });
    const bridge = createCheckboxReservationBridge(authority, h.http.channels, DOC_INGEST_LIMITS);
    const input = {
      intentId: row.intentId,
      subject: { kind: 'recovery' as const, intent: row, approved: h.approved },
      freshSnapshot: await authority.refreshRecoveryCurrent(row, h.approved),
    };
    failClock = true;
    let returned = false;
    let caught = false;
    let cause: unknown = 'sentinel';
    try {
      authority.transaction((tx) => {
        try {
          bridge.convertOwnReservationInTransaction(input, tx);
        } catch {
          /* undefined remains failure */
        }
        tx.update(canvasDocChannels)
          .set({ stateRev: 99 })
          .where(eq(canvasDocChannels.documentId, row.documentId))
          .run();
      });
      returned = true;
    } catch (error) {
      caught = true;
      cause = error;
    }
    expect(caught).toBe(true);
    expect(cause).toBeUndefined();
    expect(returned).toBe(false);
    expect(h.http.channels.getChannel(row.documentId)?.stateRev).toBe(0);
  });

  it('ordinary event and state UUID paths refuse before sequence or state allocation', async () => {
    const h = await fixture();
    h.http.channels.insertWriteIntent(h.prepared);
    const before = h.http.channels.getChannel(h.input.documentId)!;
    const event = {
      documentId: h.input.documentId,
      eventId: h.input.eventId,
      direction: 'system' as const,
      type: 'state.changed',
      payload: {},
      envelopeHash: 'a'.repeat(64),
      provenance: {},
      receivedAt: new Date().toISOString(),
    };
    expect(() => h.http.channels.appendEvent(event)).toThrow('permanently reserved');
    expect(() =>
      h.http.channels.replaceState({
        documentId: h.input.documentId,
        expectedStateRev: 0,
        state: { changed: true },
        event,
      })
    ).toThrow('permanently reserved');
    expect(h.http.channels.getChannel(h.input.documentId)).toEqual(before);
  });
});
