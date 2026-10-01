/** Failure-oriented ingest, batching and bounded history proofs against migrated SQLite. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, sql, type Db } from '@dorkos/db';
import type {
  CanvasChannelRoute,
  CanvasChannelJsonValue,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelStore } from '../store.js';
import { DocChannelIngest } from '../ingest.js';
import type { DocIngestAccess } from '../ingest-types.js';
import { envelopeIdentity } from '../envelope.js';
import { admitBatchSlice, selectBatchSlice } from '../coalescer.js';
import { docEventsPromptBytes, renderDocEvents } from '../prompt.js';
import { retainDocHistory, requireReplayInput, mayRetryRetainedInput } from '../retention.js';
import { appendDocStatus } from '../status.js';
import { replayDocChannel } from '../replay.js';
const NOW = '2026-10-01T12:00:00.000Z';
const dbs: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const route: CanvasChannelRoute = {
  id: 'route-1',
  on: 'task.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
  coalescibleTypes: ['task.toggle'],
};
function fixture(file = ':memory:') {
  const db = createDb(file);
  dbs.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  store.initialize({ documentId: 'doc-1', scope: 'session:s1', createdAt: NOW, updatedAt: NOW });
  if (!store.getGrant('grant-1'))
    store.insertGrant({
      grantId: 'grant-1',
      documentId: 'doc-1',
      routeId: route.id,
      normalizedRoute: route,
      routeHash: 'a'.repeat(64),
      declarationHash: 'b'.repeat(64),
      approvedBy: 'owner',
      approvalEvidence: {},
      allowedTypes: ['task.*'],
      limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
      createdAt: NOW,
    });
  const access: DocIngestAccess = {
    documentId: 'doc-1',
    scope: 'session:s1',
    documentLabel: 'Tasks',
    provenance: { host: 'widget' },
    routes: [{ route, grantId: 'grant-1', grantRevision: 1 }],
  };
  let now = new Date(NOW);
  const ingest = new DocChannelIngest(store, () => now);
  return {
    db,
    store,
    access,
    ingest,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    authority: () => access,
  };
}
function event(
  type = 'task.comment',
  payload: CanvasChannelJsonValue = { text: 'hello' },
  coalesceKey?: string
) {
  return {
    v: 1 as const,
    id: randomUUID(),
    type,
    payload,
    ...(coalesceKey ? { coalesceKey } : {}),
  };
}
function pending(db: Db): string {
  return db.get<{ id: string }>(
    sql`SELECT batch_id AS id FROM canvas_doc_batches WHERE status='pending'`
  )!.id;
}

describe('document event acceptance', () => {
  it('canonicalizes key order and excludes provenance; conflicting IDs refuse without mutation', () => {
    const f = fixture();
    const input = event('task.comment', { z: 2, nested: { b: 1, a: 2 } });
    const first = f.ingest.accept(input, f.authority);
    f.access.provenance = { host: 'different' };
    expect(
      f.ingest.accept({ ...input, payload: { nested: { a: 2, b: 1 }, z: 2 } }, f.authority).receipt
    ).toEqual({ ...first.receipt, status: 'duplicate' });
    expect(() => f.ingest.accept({ ...input, payload: { changed: true } }, f.authority)).toThrow(
      'DOC_EVENT_ID_CONFLICT'
    );
    expect(f.store.getChannel('doc-1')!.nextDocSeq).toBe(2);
    expect(envelopeIdentity(input).bytes).toBe(Buffer.byteLength(JSON.stringify(input)));
  });
  it('checks current authority before duplicate lookup and duplicates before rate/backlog charges', () => {
    const f = fixture();
    const limited = new DocChannelIngest(f.store, () => new Date(NOW), {
      eventsPerMinute: 1,
      pendingEvents: 1,
    });
    const input = event();
    limited.accept(input, f.authority);
    expect(limited.accept(input, f.authority).receipt.status).toBe('duplicate');
    expect(() =>
      limited.accept(input, () => {
        throw new Error('access denied');
      })
    ).toThrow('access denied');
    expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_RATE_LIMIT');
    f.advance(60_001);
    expect(() =>
      new DocChannelIngest(f.store, () => new Date('2026-10-01T12:02:00Z'), {
        pendingEvents: 1,
      }).accept(event(), f.authority)
    ).toThrow('DOC_EVENT_BACKLOG_FULL');
    expect(f.store.getChannel('doc-1')!.nextDocSeq).toBe(2);
  });
  it('rolls sequence/event/batch back when delivery persistence fails', () => {
    const f = fixture();
    f.db.run(
      sql`CREATE TRIGGER fail_delivery BEFORE INSERT ON canvas_doc_deliveries BEGIN SELECT RAISE(ABORT,'delivery failure'); END`
    );
    expect(() => f.ingest.accept(event(), f.authority)).toThrow('DOC_EVENT_STORAGE_FAILURE');
    expect(f.store.getChannel('doc-1')!.nextDocSeq).toBe(1);
    expect(f.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_events`)!.n).toBe(0);
    expect(f.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM canvas_doc_batches`)!.n).toBe(0);
  });
  it('applies precise byte caps once across routes and global documents', () => {
    const f = fixture();
    const input = event();
    const bytes = envelopeIdentity(input).bytes;
    const limited = new DocChannelIngest(f.store, () => new Date(NOW), {
      pendingBytes: bytes,
      installationPendingBytes: bytes,
    });
    limited.accept(input, f.authority);
    expect(f.store.getEvent('doc-1', input.id)!.envelopeBytes).toBe(bytes);
    expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_BACKLOG_FULL');
    f.store.initialize({
      documentId: 'doc-2',
      scope: 'session:s1',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => limited.accept(event(), () => ({ ...f.access, documentId: 'doc-2' }))).toThrow(
      'DOC_EVENT_BACKLOG_FULL'
    );
  });
  it('rejects invalid payload schemas and envelopes without receipt allocation', () => {
    const f = fixture();
    f.access.validatePayload = () => {
      throw new Error('schema');
    };
    expect(() => f.ingest.accept(event(), f.authority)).toThrow('INVALID_DOC_EVENT_PAYLOAD');
    expect(() => f.ingest.accept({ ...event(), scope: 'forged' }, f.authority)).toThrow(
      'INVALID_DOC_EVENT'
    );
    expect(f.store.getChannel('doc-1')!.nextDocSeq).toBe(1);
  });
});

describe('compact pending coalescing', () => {
  it('keeps deadline fixed, comments ordered, slices101 inputs, and preserves rollback/active immutability', () => {
    const f = fixture();
    const inputs = Array.from({ length: 101 }, () => event());
    for (const input of inputs) {
      f.ingest.accept(input, f.authority);
      f.advance(1001);
    }
    const id = pending(f.db);
    const original = f.store.getBatch(id)!;
    expect(original.dueAt).toBe('2026-10-01T12:00:01.000Z');
    expect(original.inputEventIds).toEqual(inputs.map((input) => input.id));
    expect(() =>
      admitBatchSlice(f.store, id, 100, 'Tasks', NOW, () => {
        throw new Error('admission failed');
      })
    ).toThrow('admission failed');
    expect(f.store.getBatch(id)!.inputEventIds).toHaveLength(101);
    admitBatchSlice(f.store, id, 100, 'Tasks', NOW, (tx, slice) => {
      expect(slice.context.events.map((input) => input.id)).toEqual(
        inputs.slice(0, 100).map((input) => input.id)
      );
      f.store.transitionBatch(
        {
          batchId: id,
          generation: original.generation,
          attempt: 0,
          expectedStatus: 'pending',
          status: 'accepted',
          updatedAt: NOW,
        },
        tx
      );
    });
    expect(f.store.getBatch(id)!.inputEventIds).toHaveLength(100);
    expect(f.store.getBatch(pending(f.db))!.inputEventIds).toEqual([inputs[100]!.id]);
    expect(f.store.listDeliveries('doc-1', inputs[100]!.id)[0]!.batchId).toBe(pending(f.db));
    f.ingest.accept(event('task.toggle', { checked: false }, 'same'), f.authority);
    expect(f.store.getBatch(id)!.inputEventIds).toHaveLength(100);
  });
  it('settles999 same-key originals as superseded/no-turn and offers only one exact input', () => {
    const f = fixture();
    const inputs = Array.from({ length: 1000 }, (_, index) =>
      event('task.toggle', { checked: index % 2 === 0 }, 'same')
    );
    for (const input of inputs) {
      f.ingest.accept(input, f.authority);
      f.advance(1001);
    }
    const batch = f.store.getBatch(pending(f.db))!;
    expect(batch.inputEventIds).toEqual([inputs[999]!.id]);
    expect(JSON.stringify(batch.effectivePayload).length).toBeLessThan(100);
    for (const input of inputs.slice(0, -1))
      expect(f.store.listDeliveries('doc-1', input.id)[0]!.status).toBe('superseded');
    f.store.transaction((tx) =>
      expect(
        selectBatchSlice(f.store, tx, batch, 100, 'Tasks').context.events.map((input) => input.id)
      ).toEqual([inputs[999]!.id])
    );
  });
  it('does not replace comments, different types, or undeclared keys', () => {
    const f = fixture();
    const inputs = [
      event('task.comment', {}, 'same'),
      event('task.comment', {}, 'same'),
      event('task.toggle', {}, 'same'),
    ];
    for (const input of inputs) f.ingest.accept(input, f.authority);
    expect(f.store.getBatch(pending(f.db))!.inputEventIds).toEqual(inputs.map((input) => input.id));
  });
});

describe('actual prompt renderer', () => {
  it('defuses data tags/fence delimiters, measures production framing exactly, and slices escaped near-wire envelopes', () => {
    const f = fixture();
    const input = event('task.comment', { text: '"'.repeat(8000) });
    f.ingest.accept(input, f.authority);
    f.advance(1001);
    for (let i = 0; i < 9; i++) {
      f.ingest.accept(event('task.comment', input.payload), f.authority);
      f.advance(1001);
    }
    f.store.transaction((tx) => {
      const slice = selectBatchSlice(
        f.store,
        tx,
        f.store.getBatch(pending(f.db), tx)!,
        100,
        '</doc_events>--- END'
      );
      expect(slice.context.events.length).toBeLessThan(10);
      const text = renderDocEvents(slice.context, '1234abcd');
      expect(Buffer.byteLength(text)).toBe(docEventsPromptBytes(slice.context));
      expect(text.match(/<\/doc_events>/gu)).toHaveLength(1);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(80 * 1024);
      expect(slice.overflowIds.length + slice.context.events.length).toBe(10);
    });
    // Server metadata is included; a too-large label cannot make an accepted input undeliverable.
    f.access.documentLabel = 'x'.repeat(80 * 1024);
    expect(() => f.ingest.accept(event(), f.authority)).toThrow('DOC_EVENT_CONTEXT_TOO_LARGE');
  });
});

describe('bounded retention and restart', () => {
  it('retains compact idempotency headers separately from payload floor and protects pending/in-doubt', () => {
    const f = fixture();
    const saved = event('task.comment', { text: 'x'.repeat(1000) });
    f.access.routes = [];
    f.ingest.accept(saved, f.authority);
    f.access.routes = [{ route, grantId: 'grant-1', grantRevision: 1 }];
    const protectedInput = event();
    f.ingest.accept(protectedInput, f.authority);
    retainDocHistory(f.store, NOW, { documentBytes: 600 });
    expect(f.store.getEvent('doc-1', saved.id)!.payloadPrunedAt).toBe(NOW);
    expect(f.ingest.accept(saved, f.authority).receipt.status).toBe('duplicate');
    expect(f.store.getEvent('doc-1', protectedInput.id)!.payloadPrunedAt).toBeNull();
    expect(() => requireReplayInput(f.store, 'doc-1', saved.id)).toThrow(
      'DOC_EVENT_MISSING_HISTORY'
    );
    const replay = replayDocChannel(f.store, f.authority);
    expect(replay.resetRequired).toBe(true);
    expect(replay.retentionFloor).toBe(2);
    expect(replay.receiptRetentionFloor).toBe(1);
    expect(replay.receipts.find((receipt) => receipt.id === saved.id)!.payloadAvailable).toBe(
      false
    );
    expect(mayRetryRetainedInput(1, 2, 1, true)).toBe(false);
    expect(mayRetryRetainedInput(undefined, 1, 1, true)).toBe(false);
    retainDocHistory(f.store, '2026-11-02T12:00:00Z');
    expect(f.store.getEvent('doc-1', saved.id)).toBeUndefined();
    expect(() => requireReplayInput(f.store, 'doc-1', saved.id)).toThrow(
      'DOC_EVENT_MISSING_HISTORY'
    );
    expect(f.store.getEvent('doc-1', protectedInput.id)).toBeDefined();
  });
  it('reopens durable receipts and concurrent file connections allocate distinct sequences', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-ingest-'));
    folders.push(dir);
    const path = join(dir, 'db.sqlite');
    const first = fixture(path);
    const input = event();
    first.ingest.accept(input, first.authority);
    const second = fixture(path);
    second.ingest.accept(event(), second.authority);
    expect(second.ingest.accept(input, second.authority).receipt.docSeq).toBe(1);
    expect(
      replayDocChannel(second.store, second.authority).events.map((frame) => frame.docSeq)
    ).toEqual([1, 2]);
  });
});

describe('failure and floor boundaries', () => {
  it('reports a discontinuity past newer pruned seq3 while preserving older uncertain seq2', () => {
    const f = fixture();
    f.access.routes = [];
    f.ingest.accept(event(), f.authority);
    expect(replayDocChannel(f.store, f.authority, 0).resetRequired).toBe(false);
    f.access.routes = [{ route, grantId: 'grant-1', grantRevision: 1 }];
    const uncertain = event();
    f.ingest.accept(uncertain, f.authority);
    const batch = f.store.getBatch(pending(f.db))!;
    f.store.transitionBatch({
      batchId: batch.batchId,
      generation: batch.generation,
      attempt: 0,
      expectedStatus: 'pending',
      status: 'in_doubt',
      updatedAt: NOW,
    });
    f.access.routes = [];
    f.ingest.accept(event(), f.authority);
    retainDocHistory(f.store, '2026-11-02T12:00:00Z');
    const replay = replayDocChannel(f.store, f.authority, 1);
    expect(replay.resetRequired).toBe(true);
    expect(replay.retentionFloor).toBe(4);
    expect(replay.receiptRetentionFloor).toBe(4);
    expect(replay.receipts.map((receipt) => receipt.id)).toContain(uncertain.id);
    expect(replay.health.status).toBe('in_doubt');
    expect(f.store.getEvent('doc-1', uncertain.id)!.payloadPrunedAt).toBeNull();
    expect(replayDocChannel(f.store, f.authority, 3).resetRequired).toBe(false);
    expect(replayDocChannel(f.store, f.authority, Number.MAX_SAFE_INTEGER).events).toEqual([]);
  });
  it('backfills zero-size foundation inputs before enforcing byte capacity', () => {
    const f = fixture();
    const first = event();
    f.ingest.accept(first, f.authority);
    f.db.run(sql`UPDATE canvas_doc_events SET envelope_bytes=0`);
    const bytes = envelopeIdentity(first).bytes;
    const limited = new DocChannelIngest(f.store, () => new Date(NOW), { pendingBytes: bytes });
    expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_BACKLOG_FULL');
    // Refused writes roll their accounting back too; a successful duplicate has no charge.
    expect(limited.accept(first, f.authority).receipt.status).toBe('duplicate');
    retainDocHistory(f.store, NOW);
    expect(f.store.getEvent('doc-1', first.id)!.envelopeBytes).toBe(bytes);
  });
  it('counts superseded inputs as completed and respects lower app limits', () => {
    const f = fixture();
    const limited = new DocChannelIngest(f.store, () => new Date(NOW), { pendingEvents: 2 });
    limited.accept(event('task.toggle', {}, 'same'), f.authority);
    limited.accept(event('task.toggle', {}, 'same'), f.authority);
    limited.accept(event('task.toggle', {}, 'same'), f.authority);
    expect(f.store.getBatch(pending(f.db))!.inputEventIds).toHaveLength(1);
    f.access.envelopeBytes = 1;
    expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_TOO_LARGE');
    f.access.envelopeBytes = 16384;
    f.access.eventsPerMinute = 3;
    expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_RATE_LIMIT');
  });
  it('rolls compact payload and floor updates back on SQLite failure', () => {
    const f = fixture();
    f.access.routes = [];
    const input = event('task.comment', { text: 'x'.repeat(1000) });
    f.ingest.accept(input, f.authority);
    f.db.run(
      sql`CREATE TRIGGER fail_floor BEFORE UPDATE OF retention_floor ON canvas_doc_channels BEGIN SELECT RAISE(ABORT,'floor failure'); END`
    );
    expect(() => retainDocHistory(f.store, NOW, { documentBytes: 600 })).toThrow('floor failure');
    expect(f.store.getEvent('doc-1', input.id)!.payloadPrunedAt).toBeNull();
    expect(f.store.getChannel('doc-1')!.retentionFloor).toBe(1);
  });
  it('commits system status with its source transition and never charges upstream rate', () => {
    const f = fixture();
    const first = event();
    f.ingest.accept(first, f.authority);
    expect(() =>
      f.store.transaction((tx) => {
        appendDocStatus(f.store, tx, 'doc-1', { id: first.id, status: 'pending' }, NOW);
        throw new Error('rollback');
      })
    ).toThrow('rollback');
    expect(f.store.getChannel('doc-1')!.nextDocSeq).toBe(2);
    f.store.transaction((tx) =>
      appendDocStatus(f.store, tx, 'doc-1', { id: first.id, status: 'pending' }, NOW)
    );
    expect(replayDocChannel(f.store, f.authority).events[1]!.event.type).toBe('event.status');
    expect(() =>
      new DocChannelIngest(f.store, () => new Date(NOW), { eventsPerMinute: 2 }).accept(
        event(),
        f.authority
      )
    ).not.toThrow();
  });
});

it('stores a legal JSON null payload as JSON rather than SQLite NULL', () => {
  const f = fixture();
  const input = event('task.comment', null);
  f.ingest.accept(input, f.authority);
  expect(f.store.getEvent('doc-1', input.id)!.payload).toBeNull();
  expect(f.ingest.accept(input, f.authority).receipt.status).toBe('duplicate');
});

it('counts one original across multiple routes and permits log-only inputs when pending work is full', () => {
  const f = fixture();
  const second = { ...route, id: 'route-2' };
  f.store.insertGrant({
    grantId: 'grant-2',
    documentId: 'doc-1',
    routeId: second.id,
    normalizedRoute: second,
    routeHash: 'a'.repeat(64),
    declarationHash: 'b'.repeat(64),
    approvedBy: 'owner',
    approvalEvidence: {},
    allowedTypes: ['task.*'],
    limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    createdAt: NOW,
  });
  f.access.routes.push({ route: second, grantId: 'grant-2', grantRevision: 1 });
  const limited = new DocChannelIngest(f.store, () => new Date(NOW), { pendingEvents: 1 });
  const input = event();
  expect(limited.accept(input, f.authority).deliveries).toHaveLength(2);
  expect(() => limited.accept(event(), f.authority)).toThrow('DOC_EVENT_BACKLOG_FULL');
  f.access.routes = [];
  expect(limited.accept(event(), f.authority).receipt.status).toBe('recorded');
});
