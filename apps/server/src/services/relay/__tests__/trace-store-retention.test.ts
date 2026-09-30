/**
 * What the Relay sweep may delete from `relay_traces`, and what it must keep (DOR-2574).
 *
 * The rule itself (how old a delivery span may get) is the sweep's, in `relay-gc.ts`; these
 * pin the store's half: a cutoff deletes exactly the delivery spans sent before it, and each
 * adapter keeps the events its log can show.
 */
import { encodeTime } from 'ulidx';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { relayTraces, type Db } from '@dorkos/db';
import { ADAPTER_EVENTS_KEPT, TraceStore } from '../trace-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-29T12:00:00.000Z');

/** A span whose id is minted the way the store mints one, at the time it was sent. */
function span(
  db: Db,
  at: number,
  opts: {
    n: number;
    kind?: 'delivery' | 'lifecycle';
    adapterId?: string;
    status?: 'sent' | 'delivered';
    id?: string;
  }
) {
  db.insert(relayTraces)
    .values({
      id: opts.id ?? `${encodeTime(at, 10)}${String(opts.n).padStart(16, '0')}`,
      messageId: `m-${opts.kind ?? 'delivery'}-${opts.adapterId ?? ''}-${opts.n}`,
      traceId: opts.adapterId ?? `t-${opts.n}`,
      subject: opts.kind === 'lifecycle' ? 'adapter.connected' : 'relay.agent.x',
      status: opts.status ?? 'delivered',
      kind: opts.kind ?? 'delivery',
      sentAt: new Date(at).toISOString(),
      deliveredAt: opts.status === 'sent' ? null : new Date(at + 5).toISOString(),
      metadata: opts.adapterId
        ? JSON.stringify({ adapterId: opts.adapterId, eventType: 'adapter.connected', message: '' })
        : null,
    })
    .run();
}

function ids(db: Db) {
  return db
    .select({ messageId: relayTraces.messageId })
    .from(relayTraces)
    .all()
    .map((row) => row.messageId)
    .sort();
}

describe('TraceStore retention', () => {
  it('deletes the delivery spans sent before the cutoff, and nothing sent at or after it', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    const cutoff = NOW - 8 * DAY;
    span(db, cutoff - DAY, { n: 1 });
    span(db, cutoff - 1, { n: 2 });
    span(db, cutoff, { n: 3 });
    span(db, cutoff + 1, { n: 4 });
    span(db, NOW, { n: 5 });

    expect(store.pruneDeliverySpans(cutoff, 100)).toBe(2);
    expect(ids(db)).toEqual(['m-delivery--3', 'm-delivery--4', 'm-delivery--5']);
  });

  it('keeps a span sent after the cutoff even when its id sorts before it', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    const cutoff = NOW - 8 * DAY;
    // An id that is not a time-ordered ULID must never make a live span look old.
    span(db, NOW, { n: 1, id: '00000000000000000000000001' });
    expect(store.pruneDeliverySpans(cutoff, 100)).toBe(0);
    expect(ids(db)).toEqual(['m-delivery--1']);
  });

  it('never deletes an adapter event by age, and deletes no more than the limit', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    const cutoff = NOW - 8 * DAY;
    span(db, cutoff - 300 * DAY, { n: 1, kind: 'lifecycle', adapterId: 'tg' });
    for (let n = 2; n <= 6; n++) span(db, cutoff - n * DAY, { n });

    expect(store.pruneDeliverySpans(cutoff, 3)).toBe(3);
    expect(store.pruneDeliverySpans(cutoff, 3)).toBe(2);
    expect(store.pruneDeliverySpans(cutoff, 3)).toBe(0);
    expect(ids(db)).toEqual(['m-lifecycle-tg-1']);
    expect(store.getAdapterEvents('tg')).toHaveLength(1);
  });

  it('reads the pruned range on the primary key, not by scanning the table', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    // Plan the statement the store itself sends, captured from the connection.
    const sent: { sql: string; params: unknown[] }[] = [];
    const prepare = db.$client.prepare.bind(db.$client);
    const client = db.$client as unknown as { prepare: typeof prepare };
    client.prepare = ((source: string) => {
      const statement = prepare(source);
      const run = statement.run.bind(statement);
      (statement as unknown as { run: (...args: unknown[]) => unknown }).run = (
        ...args: unknown[]
      ) => {
        sent.push({ sql: source, params: args });
        return run(...(args as []));
      };
      return statement;
    }) as typeof prepare;
    try {
      store.pruneDeliverySpans(NOW - 8 * DAY, 5000);
    } finally {
      client.prepare = prepare;
    }
    expect(sent).toHaveLength(1);
    const plan = (
      db.$client.prepare(`EXPLAIN QUERY PLAN ${sent[0]!.sql}`).all(...(sent[0]!.params as [])) as {
        detail: string;
      }[]
    )
      .map((row) => row.detail)
      .join('\n');
    expect(plan).toMatch(
      /SEARCH relay_traces USING INDEX sqlite_autoindex_relay_traces_1 \(id<\?\)/
    );
    expect(plan).not.toMatch(/SCAN relay_traces/);
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('leaves a connection event written before kind existed to the event-log cap', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    // Stored as a delivery (migration 0043's default), shown by the event log all the same.
    span(db, NOW - 300 * DAY, { n: 1, kind: 'delivery', adapterId: 'old', status: 'sent' });
    span(db, NOW - 300 * DAY, { n: 2 });
    expect(store.getAdapterEvents('old')).toHaveLength(1);

    expect(store.pruneDeliverySpans(NOW - 8 * DAY, 100)).toBe(1);
    expect(store.capAdapterEvents()).toBe(0);
    expect(store.getAdapterEvents('old')).toHaveLength(1);

    for (let n = 3; n <= ADAPTER_EVENTS_KEPT + 2; n++) {
      span(db, NOW - 10 * DAY + n * 1000, { n, kind: 'lifecycle', adapterId: 'old' });
    }
    // Now the oldest of 501, so the cap takes it, and only it.
    expect(store.capAdapterEvents()).toBe(1);
    expect(store.getSpanByMessageId('m-delivery-old-1')).toBeNull();
    expect(store.getAdapterEvents('old', ADAPTER_EVENTS_KEPT + 5)).toHaveLength(
      ADAPTER_EVENTS_KEPT
    );
  });

  it('keeps the newest events of each adapter its log can show, and no fewer', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    for (let n = 1; n <= ADAPTER_EVENTS_KEPT + 20; n++) {
      span(db, NOW - 400 * DAY + n * 1000, { n, kind: 'lifecycle', adapterId: 'busy' });
    }
    for (let n = 1; n <= 3; n++)
      span(db, NOW - 400 * DAY, { n, kind: 'lifecycle', adapterId: 'quiet' });
    span(db, NOW, { n: 1 });
    const shownBefore = store.getAdapterEvents('busy', ADAPTER_EVENTS_KEPT).map((e) => e.id);

    expect(store.capAdapterEvents()).toBe(20);
    expect(store.getAdapterEvents('busy', ADAPTER_EVENTS_KEPT + 20).map((e) => e.id)).toEqual(
      shownBefore
    );
    expect(store.getAdapterEvents('quiet')).toHaveLength(3);
    expect(store.getSpanByMessageId('m-delivery--1')).not.toBeNull();
    expect(store.capAdapterEvents()).toBe(0);
  });

  it('leaves the delivery metrics of the last day exactly as they were', () => {
    const db = createTestDb();
    const store = new TraceStore(db);
    for (let n = 1; n <= 30; n++) span(db, NOW - n * DAY + 60_000, { n });
    for (let n = 31; n <= 40; n++) span(db, NOW - 3_600_000 - n, { n, status: 'sent' });
    const since = new Date(NOW - DAY).toISOString();
    const before = store.getMetrics({ since });

    store.pruneDeliverySpans(NOW - 8 * DAY, 100);
    expect(store.getMetrics({ since })).toEqual(before);
    expect(before.totalMessages).toBe(11);
  });
});
