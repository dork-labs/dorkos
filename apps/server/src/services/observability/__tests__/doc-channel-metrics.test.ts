/** Committed retained-state observations over actual migrated temporary SQLite files. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canvasDocBatches,
  canvasDocGrants,
  createDb,
  eq,
  sessionMessageAcceptanceReceipts,
  sql,
  type Db,
} from '@dorkos/db';
import { batchFixture, FROM, NOW } from '../../canvas/doc-channel/__tests__/batch-fixtures.js';
import { appendDocStatus } from '../../canvas/doc-channel/status.js';
import { retainDocHistory } from '../../canvas/doc-channel/retention.js';
import { logger } from '../../../lib/logger.js';
import { DocChannelMetrics, DocChannelMetricsUnavailableError } from '../doc-channel-metrics.js';

const directories: string[] = [];
const databases: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(manifest?: object) {
  const directory = mkdtempSync(join(tmpdir(), 'doc-channel-metrics-'));
  directories.push(directory);
  const file = join(directory, 'state.sqlite');
  let at = Date.parse(NOW);
  const now = () => new Date(at);
  if (manifest) {
    mkdirSync(join(directory, '.dork'));
    writeFileSync(join(directory, '.dork', 'app.json'), JSON.stringify(manifest));
  }
  const f = batchFixture(
    file,
    manifest ? directory : null,
    undefined,
    'boot-1',
    'claude-code',
    now
  );
  databases.push(f.db);
  return {
    f,
    file,
    directory,
    now,
    advance: (ms: number) => {
      at += ms;
    },
    metrics: new DocChannelMetrics(f.db, { now }),
  };
}
async function accept(h: ReturnType<typeof fixture>) {
  h.f.input({ text: 'PRIVATE_PAYLOAD_SECRET' });
  const accepted = h.f.admission.admit(h.f.batchId());
  const prepared = await h.f.admission.acceptance.prepare(accepted.receipt.id);
  return { ...accepted, prepared };
}
async function settle(h: ReturnType<typeof fixture>) {
  const accepted = await accept(h);
  h.f.admission.acceptance.claim(accepted.receipt.id, accepted.prepared);
  h.advance(123);
  h.f.admission.acceptance.markTurnStarted(accepted.receipt.id, 1);
  h.advance(987);
  h.f.admission.acceptance.settle(accepted.receipt.id, 'ok');
  return accepted;
}

it('counts current batches rather than original inputs or repeated status rows, with honest unclaimed age', async () => {
  const h = fixture();
  h.f.input({ text: 'PRIVATE_PAYLOAD_SECRET' });
  h.f.input({ text: 'SECOND_PRIVATE_INPUT' });
  const batch = h.f.store.getBatch(h.f.batchId())!;
  h.f.store.transaction((tx) => {
    expect(
      h.f.store.transitionBatch(
        {
          batchId: batch.batchId,
          generation: batch.generation,
          attempt: batch.attempt,
          expectedStatus: 'pending',
          status: 'waiting',
          updatedAt: NOW,
        },
        tx
      )
    ).toBe(true);
    for (let i = 0; i < 3; i++)
      appendDocStatus(
        h.f.store,
        tx,
        h.f.documentId,
        { status: 'waiting', secret: 'STATUS_PAYLOAD_SECRET' },
        NOW
      );
  });
  h.advance(30_000);
  const waiting = h.metrics.readCommittedSnapshot();
  expect(waiting).toMatchObject({
    window: 'retained_current_state',
    batchesByStatus: { waiting: 1 },
    unclaimedWaitingBatches: 1,
    oldestUnclaimedWaitMs: 30_000,
    inDoubtBatches: 0,
  });
  expect(h.metrics.readCommittedSnapshot()).toEqual(waiting);
  const accepted = h.f.admission.admit(batch.batchId);
  expect(h.metrics.readCommittedSnapshot().oldestUnclaimedWaitMs).toBe(0);
  h.advance(456);
  expect(h.metrics.readCommittedSnapshot()).toMatchObject({
    batchesByStatus: { accepted: 1 },
    unclaimedWaitingBatches: 1,
    oldestUnclaimedWaitMs: 456,
  });
  const prepared = await h.f.admission.acceptance.prepare(accepted.receipt.id);
  h.f.admission.acceptance.claim(accepted.receipt.id, prepared);
  expect(h.metrics.readCommittedSnapshot()).toMatchObject({
    batchesByStatus: { dispatching: 1 },
    unclaimedWaitingBatches: 0,
    oldestUnclaimedWaitMs: null,
  });
});

it('never observes or increments speculative native or nested transactions, including rollback', async () => {
  const h = fixture();
  const accepted = await accept(h);
  const before = h.metrics.readCommittedSnapshot();
  h.f.db.$client.exec('BEGIN');
  try {
    h.f.db.update(canvasDocBatches).set({ status: 'in_doubt' }).run();
    expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
    expect(
      h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'authority' })
    ).toBeUndefined();
  } finally {
    h.f.db.$client.exec('ROLLBACK');
  }
  expect(h.metrics.readCommittedSnapshot()).toEqual(before);
  expect(() =>
    h.f.db.transaction((tx) => {
      tx.update(canvasDocGrants).set({ revokedAt: NOW }).run();
      tx.update(canvasDocBatches).set({ status: 'cancelled' }).run();
      tx.update(sessionMessageAcceptanceReceipts).set({ state: 'cancelled' }).run();
      tx.transaction(() => {
        expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
        h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
      });
      throw new Error('owning rollback');
    })
  ).toThrow('owning rollback');
  expect(h.metrics.readCommittedSnapshot()).toEqual(before);
  expect(h.f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
});

it('reads exact correlated projected-start latency in integer milliseconds without incrementing on reads', async () => {
  const h = fixture();
  const accepted = await settle(h);
  const latency = { samples: 1, sumMs: 987, maxMs: 987, invalidSamples: 0 };
  expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency).toEqual(latency);
  expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency).toEqual(latency);
  for (const changes of [
    { sourceKind: 'connector_event' as const },
    { sourceId: 'UNRELATED_SOURCE_SECRET' },
    { sourceGeneration: 'UNRELATED_GENERATION_SECRET' },
  ]) {
    h.f.db
      .update(sessionMessageAcceptanceReceipts)
      .set(changes)
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .run();
    expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency).toEqual({
      samples: 0,
      sumMs: null,
      maxMs: null,
      invalidSamples: 0,
    });
    h.f.db
      .update(sessionMessageAcceptanceReceipts)
      .set({
        sourceKind: accepted.receipt.sourceKind,
        sourceId: accepted.receipt.sourceId,
        sourceGeneration: accepted.receipt.sourceGeneration,
      })
      .run();
  }
  for (const settledAt of [null, 'MALFORMED_TIMESTAMP_SECRET', NOW]) {
    h.f.db.update(sessionMessageAcceptanceReceipts).set({ settledAt }).run();
    expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency).toEqual({
      samples: 0,
      sumMs: null,
      maxMs: null,
      invalidSamples: 1,
    });
  }
});

it('retains uncertainty for a closed tombstone and restores gauges across actual file restart', async () => {
  const h = fixture();
  const accepted = await accept(h);
  h.f.admission.acceptance.claim(accepted.receipt.id, accepted.prepared);
  h.f.admission.acceptance.markOutcomeUnknown(accepted.receipt.id, 'PRIVATE_REFUSAL_REASON_SECRET');
  h.f.canvas.close(FROM, h.f.documentId);
  h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'conflict' });
  h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
  const before = h.metrics.readCommittedSnapshot();
  expect(before.inDoubtBatches).toBe(1);
  expect(before.revokedGrants).toBe(1);
  h.f.db.$client.close();
  const db = createDb(h.file);
  databases.push(db);
  const restarted = new DocChannelMetrics(db, { now: h.now });
  const after = restarted.readCommittedSnapshot();
  expect({ ...after, requestAttempts: before.requestAttempts }).toEqual(before);
  expect(after.requestAttempts.rejectedRequestsByClass.conflict).toBe(0);
  expect(after.requestAttempts.replayRetentionResetResponses).toBe(0);
  expect(after.requestAttempts.sinceBoot).toBe(h.now().toISOString());
  expect(restarted.readCommittedSnapshot()).toEqual(after);
});

it('counts one revoked durable grant after duplicate revocation', () => {
  const h = fixture();
  h.f.grants.revoke(h.f.documentId, h.f.grantId, h.f.actor);
  h.f.grants.revoke(h.f.documentId, h.f.grantId, h.f.actor);
  expect(h.metrics.readCommittedSnapshot().revokedGrants).toBe(1);
  expect(h.metrics.readCommittedSnapshot().revokedGrants).toBe(1);
});

it('reports retained samples rather than a fictitious lifetime total after pruning', async () => {
  const h = fixture();
  await settle(h);
  expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency.samples).toBe(1);
  h.advance(3600_000);
  retainDocHistory(h.f.store, h.now().toISOString(), {
    ageMs: 1,
    documentBytes: 1,
    installationBytes: 1,
  });
  expect(h.metrics.readCommittedSnapshot()).toMatchObject({
    window: 'retained_current_state',
    correlatedTurnLatency: { samples: 0, sumMs: null, maxMs: null },
  });
});

it('keeps labels fixed, returned counters detached, duplicates successful and repeated reset requests honest', () => {
  const h = fixture();
  h.metrics.recordHttpResult('ingest', { kind: 'success' });
  h.metrics.recordHttpResult('ingest', { kind: 'success' });
  h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'rate_backlog' });
  h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'rate_backlog' });
  h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
  h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
  h.metrics.recordHttpResult('receipt', { kind: 'success' });
  const snapshot = h.metrics.readCommittedSnapshot();
  expect(snapshot.requestAttempts.rejectedRequestsByClass.rate_backlog).toBe(2);
  expect(snapshot.requestAttempts.replayRetentionResetResponses).toBe(2);
  snapshot.requestAttempts.rejectedRequestsByClass.rate_backlog = 90;
  snapshot.batchesByStatus.pending = 90;
  expect(
    h.metrics.readCommittedSnapshot().requestAttempts.rejectedRequestsByClass.rate_backlog
  ).toBe(2);
  expect(h.metrics.readCommittedSnapshot().batchesByStatus.pending).toBe(0);
  // Runtime misuse cannot create high-cardinality keys even when TypeScript is bypassed.
  expect(() =>
    h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'PAYLOAD_SECRET' } as never)
  ).toThrow(RangeError);
  expect(() => h.metrics.recordHttpResult('PAYLOAD_SECRET' as never, { kind: 'success' })).toThrow(
    RangeError
  );
  expect(() => h.metrics.recordHttpResult('ingest', { kind: 'retention_reset' })).toThrow(
    RangeError
  );
});

it('maps corrupt state to a fixed unknown bucket, rejects invalid wait time and storage failures without exposing evidence', () => {
  const h = fixture();
  h.f.input({ text: 'PRIVATE_PAYLOAD_SECRET' });
  h.f.db.run(sql`UPDATE canvas_doc_batches SET status='CORRUPT_STATUS_SECRET'`);
  expect(h.metrics.readCommittedSnapshot().batchesByStatus.unknown).toBe(1);
  h.f.db.run(sql`UPDATE canvas_doc_batches SET status='pending',created_at='CORRUPT_TIME_SECRET'`);
  expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
  h.f.db.run(sql`UPDATE canvas_doc_batches SET created_at=${NOW}`);
  const serialized = JSON.stringify(h.metrics.readCommittedSnapshot());
  for (const value of [
    h.f.documentId,
    h.f.grantId,
    h.f.batchId(),
    'PRIVATE_PAYLOAD_SECRET',
    'CORRUPT_STATUS_SECRET',
    'CORRUPT_TIME_SECRET',
    '/agents/one',
    FROM,
  ])
    expect(serialized).not.toContain(value);
  const prepare = vi.spyOn(h.f.db.$client, 'prepare').mockImplementation(() => {
    throw new Error('SQL_ERROR_PATH_SECRET');
  });
  expect(() => h.metrics.readCommittedSnapshot()).toThrow('Document metrics are not available.');
  prepare.mockRestore();
  h.f.db.$client.close();
  expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
});

it('reads independently committed manifest suspension even when subsequent ingestion rolls back', () => {
  const original = { v: 1, types: { 'task.toggle': { type: 'object' } } };
  const h = fixture(original);
  const manifestFile = join(h.directory, '.dork', 'app.json');
  writeFileSync(manifestFile, JSON.stringify({ ...original, limits: { eventsPerMinute: 1 } }));
  h.f.grants.refreshAuthority(h.f.documentId, h.f.actor);
  expect(() =>
    h.f.store.transaction((tx) => {
      h.f.grants.validateEventPayload(h.f.documentId, 'task.toggle', 'invalid', h.f.actor, tx);
    })
  ).toThrow('INVALID_DECLARED_PAYLOAD');
  expect(h.metrics.readCommittedSnapshot().revokedGrants).toBe(1);
  writeFileSync(manifestFile, JSON.stringify(original));
  h.f.grants.refreshAuthority(h.f.documentId, h.f.actor);
  expect(h.metrics.readCommittedSnapshot().revokedGrants).toBe(1);
});

it('saturates both attempt counters, ignores a closed producer, and never logs observations', () => {
  const h = fixture();
  // Seed the actual private accumulator at the unreachable-loop boundary; invoke the real producer.
  const accumulator = h.metrics as unknown as { rejected: Record<string, number>; resets: number };
  accumulator.rejected.authority = Number.MAX_SAFE_INTEGER - 1;
  accumulator.resets = Number.MAX_SAFE_INTEGER - 1;
  const logs = ['info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(logger, method as 'info').mockImplementation(() => {})
  );
  for (let i = 0; i < 3; i++) {
    h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'authority' });
    h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
  }
  expect(h.metrics.readCommittedSnapshot().requestAttempts).toMatchObject({
    rejectedRequestsByClass: { authority: Number.MAX_SAFE_INTEGER },
    replayRetentionResetResponses: Number.MAX_SAFE_INTEGER,
  });
  expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
  h.f.db.$client.close();
  h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'other' });
  expect(accumulator.rejected.other).toBe(0);
});

it.each([
  ['pending', '2026-10-01T24:01:00.000Z'],
  ['waiting', '2026-10-01T24:01:00.000Z'],
  ['accepted', '2026-10-01T24:01:00.000Z'],
  ['pending', '2026-13-01T00:00:00.000Z'],
  ['pending', '2026-10-32T00:00:00.000Z'],
  ['waiting', '2026-13-01T00:00:00.000Z'],
  ['waiting', '2026-10-32T00:00:00.000Z'],
  ['accepted', '2026-13-01T00:00:00.000Z'],
  ['accepted', '2026-10-32T00:00:00.000Z'],
] as const)(
  'refuses mixed valid and invalid %s wait dates (%s), including file restart',
  (status, invalidDate) => {
    const h = fixture();
    h.f.input();
    const batchId = h.f.batchId();
    h.metrics.recordHttpResult('ingest', { kind: 'refused', reason: 'authority' });
    // Retain a second, valid waiting row: MIN must not silently ignore the invalid original.
    const original = h.f.db.$client
      .prepare('SELECT * FROM canvas_doc_batches WHERE batch_id=?')
      .get(batchId) as Record<string, unknown>;
    const valid = { ...original, batch_id: 'valid-other-route', route_id: 'other-route' };
    const columns = Object.keys(valid);
    h.f.db.$client
      .prepare(
        `INSERT INTO canvas_doc_batches (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(valid));
    if (status === 'accepted') h.f.admission.admit(batchId);
    else if (status === 'waiting')
      h.f.db
        .update(canvasDocBatches)
        .set({ status })
        .where(eq(canvasDocBatches.batchId, batchId))
        .run();
    const before = h.metrics.readCommittedSnapshot();
    expect(before.unclaimedWaitingBatches).toBe(2);
    expect(before.oldestUnclaimedWaitMs).toBe(0);
    if (status === 'accepted')
      h.f.db.update(sessionMessageAcceptanceReceipts).set({ acceptedAt: invalidDate }).run();
    else
      h.f.db
        .update(canvasDocBatches)
        .set({ createdAt: invalidDate })
        .where(eq(canvasDocBatches.batchId, batchId))
        .run();
    expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
    h.f.db.$client.exec('BEGIN');
    try {
      expect(() => h.metrics.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
      h.metrics.recordHttpResult('receipt', { kind: 'refused', reason: 'other' });
      h.metrics.recordHttpResult('replay', { kind: 'retention_reset' });
    } finally {
      h.f.db.$client.exec('ROLLBACK');
    }
    expect(() => h.metrics.readCommittedSnapshot()).toThrow('Document metrics are not available.');
    // Repair only to observe that failed reads/native speculative attempts changed no counters.
    if (status === 'accepted')
      h.f.db.update(sessionMessageAcceptanceReceipts).set({ acceptedAt: NOW }).run();
    else
      h.f.db
        .update(canvasDocBatches)
        .set({ createdAt: NOW })
        .where(eq(canvasDocBatches.batchId, batchId))
        .run();
    expect(h.metrics.readCommittedSnapshot()).toEqual(before);
    if (status === 'accepted')
      h.f.db.update(sessionMessageAcceptanceReceipts).set({ acceptedAt: invalidDate }).run();
    else
      h.f.db
        .update(canvasDocBatches)
        .set({ createdAt: invalidDate })
        .where(eq(canvasDocBatches.batchId, batchId))
        .run();
    h.f.db.$client.close();
    const db = createDb(h.file);
    databases.push(db);
    const restarted = new DocChannelMetrics(db, { now: h.now });
    expect(() => restarted.readCommittedSnapshot()).toThrow(DocChannelMetricsUnavailableError);
  }
);

it.each(['turnStartedAt', 'settledAt'] as const)(
  'counts impossible hour24 in %s as an invalid latency sample across file restart',
  async (column) => {
    const h = fixture();
    await settle(h);
    h.f.db
      .update(sessionMessageAcceptanceReceipts)
      .set({ [column]: '2026-10-01T24:01:00.000Z' })
      .run();
    const expected = { samples: 0, sumMs: null, maxMs: null, invalidSamples: 1 };
    expect(h.metrics.readCommittedSnapshot().correlatedTurnLatency).toEqual(expected);
    h.f.db.$client.close();
    const db = createDb(h.file);
    databases.push(db);
    expect(
      new DocChannelMetrics(db, { now: h.now }).readCommittedSnapshot().correlatedTurnLatency
    ).toEqual(expected);
  }
);
