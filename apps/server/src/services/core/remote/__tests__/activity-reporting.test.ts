/**
 * Managed remote access activity reports (DOR-2086 S5): each batch is stored
 * with its Idempotency-Key before it is sent, retried unchanged under the same
 * key after a lost answer or a restart, and a new key only ever comes with new
 * contents. The outbox is bounded and never blocks anything local.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_EVENTS_IDEMPOTENCY_HEADER } from '@dork-labs/cloud-api';
import { createDb, runMigrations, type Db } from '@dorkos/db';

import { ActivityOutbox, OUTBOX_MAX_ROWS, type RemoteEventBatch } from '../activity-outbox.js';
import { ActivitySender, EVENTS_MAX_REFUSALS } from '../activity-sender.js';
import type { CommandLink } from '../command-dispatcher.js';
import { FakeCloud, problem } from './fake-cloud.js';

const EVENTS = '/v1/remote/events';
const INSTANCE = 'inst_0001';
const KEY = REMOTE_EVENTS_IDEMPOTENCY_HEADER.toLowerCase();

let db: Db;
let cloud: FakeCloud;
let keys: number;

/** Timers that never fire on their own: a retry happens when the test flushes. */
const heldTimers = { setTimeout: () => 1, clearTimeout: () => undefined };

function batch(requests: number, reason = 'idle'): RemoteEventBatch {
  return {
    instanceId: INSTANCE,
    activity: [{ at: '2026-10-10T12:05:00.000Z', requests }],
    closeReports: [
      {
        at: '2026-10-10T12:05:00.000Z',
        reason,
        wakeId: 'wk_1',
        openedAt: '2026-10-10T12:00:00.000Z',
        requests,
      },
    ],
  };
}

function outbox(): ActivityOutbox {
  return new ActivityOutbox(db, Date.now, () => `key-${++keys}`);
}

function sender(box: ActivityOutbox, link?: CommandLink): ActivitySender {
  return new ActivitySender(link ?? { context: cloud.capture()!, instanceId: INSTANCE }, {
    outbox: box,
    timers: heldTimers,
    random: () => 0.5,
  });
}

const sent = () => cloud.callsTo('POST', EVENTS);

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  cloud = new FakeCloud();
  keys = 0;
});

afterEach(() => {
  db.$client.close();
});

describe('the outbox', () => {
  it('stores a batch and its key before anything sends it, and never an empty one', () => {
    const box = outbox();
    const stored = box.enqueue(batch(3))!;
    expect(stored.idempotencyKey).toBe('key-1');
    expect(box.pending(INSTANCE)).toEqual([
      { id: stored.id, idempotencyKey: 'key-1', batch: batch(3), attempts: 0 },
    ]);
    expect(box.enqueue({ instanceId: INSTANCE, activity: [], closeReports: [] })).toBeNull();
    expect(box.size()).toBe(1);
  });

  it('refuses a batch the published schema would refuse', () => {
    const box = outbox();
    expect(() => box.enqueue({ ...batch(1), instanceId: '' })).toThrow();
    expect(box.size()).toBe(0);
  });

  it('is bounded: the oldest go first', () => {
    let tick = Date.parse('2026-10-10T00:00:00.000Z');
    const box = new ActivityOutbox(
      db,
      () => (tick += 1_000),
      () => `key-${++keys}`
    );
    for (let i = 0; i < OUTBOX_MAX_ROWS + 5; i += 1) box.enqueue(batch(i + 1));
    expect(box.size()).toBe(OUTBOX_MAX_ROWS);
    const oldest = box.pending(INSTANCE, 1)[0]!;
    expect(oldest.batch.activity[0]!.requests).toBe(6);
  });

  it('drops batches past their age', () => {
    let now = Date.parse('2026-10-01T00:00:00.000Z');
    const box = new ActivityOutbox(
      db,
      () => now,
      () => `key-${++keys}`
    );
    box.enqueue(batch(1));
    now += 8 * 24 * 60 * 60_000;
    expect(box.prune()).toBe(1);
    expect(box.size()).toBe(0);
  });
});

describe('sending', () => {
  it('sends each batch under its own key, and retires it once accepted', async () => {
    cloud.on('POST', EVENTS, { status: 200, body: { accepted: 2 } });
    const box = outbox();
    box.enqueue(batch(1));
    box.enqueue(batch(2));
    await sender(box).flush();
    expect(sent().map((call) => call.headers[KEY])).toEqual(['key-1', 'key-2']);
    expect(sent().map((call) => call.body)).toEqual([batch(1), batch(2)]);
    expect(box.size()).toBe(0);
  });

  it('retries the unchanged batch under the same key after a lost answer', async () => {
    cloud.on('POST', EVENTS, { networkError: true }, { status: 200, body: { accepted: 2 } });
    const box = outbox();
    box.enqueue(batch(4));
    const s = sender(box);
    await s.flush();
    expect(box.size()).toBe(1);
    await s.flush();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.headers[KEY]).toBe(sent()[0]!.headers[KEY]);
    expect(sent()[1]!.body).toEqual(sent()[0]!.body);
    expect(box.size()).toBe(0);
  });

  it('retries under the same key after a restart, from the stored row', async () => {
    cloud.on('POST', EVENTS, {
      status: 503,
      body: { code: 'unavailable', status: 503, title: 'x' },
    });
    const first = outbox();
    first.enqueue(batch(5));
    const before = sender(first);
    await before.flush();
    before.stop();

    // A new process: a new outbox and sender over the same database.
    cloud.on('POST', EVENTS, { status: 200, body: { accepted: 0 } });
    const after = outbox();
    await sender(after).flush();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.headers[KEY]).toBe('key-1');
    expect(sent()[1]!.body).toEqual(batch(5));
    // `{ accepted: 0 }` for a stored, non-empty batch: Cloud already had it.
    expect(after.size()).toBe(0);
  });

  it('a new key only ever comes with new contents', async () => {
    cloud.on('POST', EVENTS, { networkError: true });
    const box = outbox();
    box.enqueue(batch(1));
    const s = sender(box);
    await s.flush();
    await s.flush();
    box.enqueue(batch(2, 'withdrawn'));
    cloud.on('POST', EVENTS, { status: 200, body: { accepted: 2 } });
    await s.flush();
    const byKey = new Map<string, unknown[]>();
    for (const call of sent()) {
      byKey.set(call.headers[KEY]!, [...(byKey.get(call.headers[KEY]!) ?? []), call.body]);
    }
    expect([...byKey.keys()]).toEqual(['key-1', 'key-2']);
    expect(byKey.get('key-1')).toEqual([batch(1), batch(1), batch(1)]);
    expect(byKey.get('key-2')).toEqual([batch(2, 'withdrawn')]);
  });

  it('keeps a refused batch and its key, then lets it go after repeated refusals', async () => {
    cloud.on('POST', EVENTS, problem(400, 'malformed_request'));
    const box = outbox();
    box.enqueue(batch(1));
    const s = sender(box);
    for (let i = 0; i < EVENTS_MAX_REFUSALS - 1; i += 1) await s.flush();
    expect(box.size()).toBe(1);
    expect(new Set(sent().map((call) => call.headers[KEY]))).toEqual(new Set(['key-1']));
    await s.flush();
    expect(box.size()).toBe(0);
    expect(sent()).toHaveLength(EVENTS_MAX_REFUSALS);
  });

  it('retries an outage or a rate limit without giving up, and says when it is stuck', async () => {
    cloud.on('POST', EVENTS, problem(429, 'rate_limited'));
    const box = outbox();
    box.enqueue(batch(1));
    const s = sender(box);
    for (let i = 0; i < EVENTS_MAX_REFUSALS + 3; i += 1) await s.flush();
    expect(box.size()).toBe(1);
    expect(s.stuck).toBe(true);
  });

  it('sends nothing under a link that is no longer current, or for another instance', async () => {
    cloud.on('POST', EVENTS, { status: 200, body: { accepted: 2 } });
    const box = outbox();
    box.enqueue(batch(1));
    const link = { context: cloud.capture()!, instanceId: INSTANCE };
    cloud.unlink();
    await sender(box, link).flush();
    cloud.relink();
    await sender(box, { context: cloud.capture()!, instanceId: 'inst_other' }).flush();
    expect(sent()).toHaveLength(0);
    expect(box.size()).toBe(1);
  });

  it('a stopped sender sends nothing more, and what is owed stays stored', async () => {
    cloud.on('POST', EVENTS, { status: 200, body: { accepted: 2 } });
    const box = outbox();
    box.enqueue(batch(1));
    const s = sender(box);
    s.stop();
    await s.flush();
    expect(sent()).toHaveLength(0);
    expect(box.size()).toBe(1);
  });
});
