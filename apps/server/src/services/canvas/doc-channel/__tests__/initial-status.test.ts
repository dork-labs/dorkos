/** Initial status replay, transaction failure and accounting proofs over migrated SQLite. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@dorkos/db';
import type { CanvasChannelRoute, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { batchFixture, NOW, type BatchFixture } from './batch-fixtures.js';
import { DocChannelIngest } from '../ingest.js';
import { appendInitialDocStatuses } from '../initial-status.js';
import { replayDocChannel } from '../replay.js';
import { retainDocHistory } from '../retention.js';
import { selectBatchSlice } from '../coalescer.js';
import type { DocIngestLimits } from '../current/accounting.js';

const dbs: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function fixture(file?: string) {
  const f = batchFixture(file);
  dbs.push(f.db);
  return f;
}
function route(id = 'route'): CanvasChannelRoute {
  return {
    id,
    on: 'task.*',
    to: 'agent:owner',
    turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
    coalescibleTypes: ['task.toggle'],
  };
}
function configure(f: BatchFixture, routes: CanvasChannelRoute[], approve = true) {
  f.grants.configure(f.documentId, { routes }, f.actor);
  if (approve)
    for (const item of routes) {
      const result = f.grants.grant(
        { documentId: f.documentId, routeId: item.id, expiresAt: '2026-10-02T00:00:00.000Z' },
        f.actor
      );
      expect(result.kind).toBe('granted');
    }
}
function authority(f: BatchFixture) {
  return (tx: Parameters<Parameters<BatchFixture['store']['transaction']>[0]>[0]) => {
    const current = f.authority.requireCurrent(f.documentId, f.actor);
    return {
      documentId: f.documentId,
      scope: current.scope,
      documentLabel: 'Private title NEVER in statuses',
      provenance: { private: 'Private provenance NEVER in statuses' },
      routes: f.grants.getCurrentRoutes(f.documentId, 'task.toggle', f.actor, tx),
    };
  };
}
function event(): PageEvent {
  return { v: 1 as const, id: randomUUID(), type: 'task.toggle', payload: { secret: 'PRIVATE' } };
}
function ingest(f: BatchFixture, input = event(), limits: Partial<DocIngestLimits> = {}) {
  return new DocChannelIngest(f.store, () => new Date(NOW), limits).accept(input, authority(f));
}
function rows(f: BatchFixture) {
  return f.db.$client.prepare('SELECT * FROM canvas_doc_events ORDER BY doc_seq').all() as {
    event_id: string;
    doc_seq: number;
    direction: string;
    type: string;
    payload: string;
    provenance: string;
    envelope_bytes: number;
  }[];
}
function statuses(f: BatchFixture) {
  return rows(f).filter((row) => row.type === 'event.status');
}
function snapshot(f: BatchFixture) {
  return Object.fromEntries(
    ['canvas_doc_channels', 'canvas_doc_events', 'canvas_doc_deliveries', 'canvas_doc_batches'].map(
      (table) => [table, f.db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]
    )
  );
}

describe('initial document status acceptance', () => {
  it('records real granted pending outcomes with separate identities and private-field-free replay', () => {
    const f = fixture();
    const input = event();
    const result = ingest(f, input);
    expect(result.receipt).toEqual({ id: input.id, status: 'recorded', docSeq: 1 });
    const status = statuses(f)[0]!;
    expect(status).toMatchObject({ doc_seq: 2, direction: 'system', type: 'event.status' });
    expect(status.event_id).not.toBe(input.id);
    expect(JSON.parse(status.payload)).toEqual({
      eventId: input.id,
      routeId: 'route',
      status: 'pending',
      batchId: result.deliveries[0]!.batchId,
    });
    expect(JSON.parse(status.provenance)).toEqual({ source: 'doc-channel-service' });
    expect(status.payload).not.toContain('PRIVATE');
    expect(f.store.listDeliveries(f.documentId, status.event_id)).toEqual([]);
    const replay = replayDocChannel(f.store, authority(f));
    expect(replay.events.map((frame) => frame.docSeq)).toEqual([1, 2]);
    expect(replay.events[1]!.event.type).toBe('event.status');
    expect(replay.highWatermark).toBe(2);
  });
  it('records the actual saved refusal reason for a declared ungranted route', () => {
    const f = fixture();
    configure(f, [route('ungranted')], false);
    const result = ingest(f);
    expect(result.deliveries[0]).toMatchObject({ status: 'saved', reason: 'ROUTE_UNAPPROVED' });
    expect(JSON.parse(statuses(f)[0]!.payload)).toEqual({
      eventId: result.receipt.id,
      routeId: 'ungranted',
      status: 'saved',
      reason: 'ROUTE_UNAPPROVED',
    });
    expect(f.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
      n: 0,
    });
  });
  it.each(['log', 'agent:owner'] as const)('records no_turn for genuine %s declarations', (to) => {
    const f = fixture();
    const resolve = f.authority.resolveTarget;
    f.authority.resolveTarget = (input) =>
      input.route.to === 'log'
        ? { agentId: null, sessionId: null, runtime: null, agentPath: null, scope: input.scope }
        : resolve(input);
    configure(f, [{ ...route(), to, turn: { mode: 'none' } }], false);
    const result = ingest(f);
    expect(JSON.parse(statuses(f)[0]!.payload)).toEqual({
      eventId: result.receipt.id,
      routeId: 'route',
      status: 'routed',
      reason: 'no_turn',
    });
    expect(f.db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_batches').get()).toEqual({
      n: 0,
    });
  });
  it('records waiting when joining an existing waiting batch without postponing its deadline', () => {
    const f = fixture();
    const first = ingest(f);
    const batchId = first.deliveries[0]!.batchId!;
    const before = f.store.getBatch(batchId)!;
    f.db.$client
      .prepare("UPDATE canvas_doc_batches SET status='waiting' WHERE batch_id=?")
      .run(batchId);
    const second = ingest(f);
    expect(JSON.parse(statuses(f)[1]!.payload)).toEqual({
      eventId: second.receipt.id,
      routeId: 'route',
      status: 'waiting',
      batchId,
    });
    expect(f.store.getBatch(batchId)!.dueAt).toBe(before.dueAt);
  });
  it('records generation refusal without disturbing the prior original batch', () => {
    const f = fixture();
    const first = ingest(f);
    const batchId = first.deliveries[0]!.batchId!;
    f.db.$client
      .prepare('UPDATE canvas_doc_batches SET grant_revision=grant_revision+1 WHERE batch_id=?')
      .run(batchId);
    const before = f.store.getBatch(batchId)!;
    const second = ingest(f);
    expect(JSON.parse(statuses(f)[1]!.payload)).toEqual({
      eventId: second.receipt.id,
      routeId: 'route',
      status: 'saved',
      reason: 'route_generation_changed',
    });
    expect(f.store.getBatch(batchId)).toEqual(before);
  });
  it('orders all sixteen statuses by route identity while capacity charges the original once', () => {
    const f = fixture();
    configure(
      f,
      Array.from({ length: 16 }, (_, i) => route(`r${String(15 - i).padStart(2, '0')}`))
    );
    const input = event();
    const result = ingest(f, input, { pendingEvents: 1 });
    expect(result.deliveries).toHaveLength(16);
    expect(statuses(f).map((row) => JSON.parse(row.payload).routeId)).toEqual(
      Array.from({ length: 16 }, (_, i) => `r${String(i).padStart(2, '0')}`)
    );
    expect(statuses(f).map((row) => row.doc_seq)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 2)
    );
    const before = snapshot(f);
    expect(ingest(f, input, { pendingEvents: 1 }).receipt.status).toBe('duplicate');
    expect(snapshot(f)).toEqual(before);
    expect(() => ingest(f, event(), { pendingEvents: 1 })).toThrow('DOC_EVENT_BACKLOG_FULL');
  });
  it('appends no synthetic route status when no declaration matches', () => {
    const f = fixture();
    configure(f, [{ ...route(), on: 'other.*' }], false);
    const result = ingest(f);
    expect(result.deliveries).toEqual([]);
    expect(statuses(f)).toEqual([]);
    expect(f.store.getChannel(f.documentId)!.nextDocSeq).toBe(2);
  });
  it('counts sixty originals despite sixty system statuses and keeps duplicate/conflict handling atomic', () => {
    const f = fixture();
    configure(f, [route('saved')], false);
    const input = event();
    ingest(f, input);
    for (let i = 1; i < 60; i++) ingest(f);
    expect(rows(f)).toHaveLength(120);
    const before = snapshot(f);
    expect(ingest(f, input).receipt).toEqual({ id: input.id, status: 'duplicate', docSeq: 1 });
    expect(() => ingest(f, { ...input, payload: { secret: 'changed' } })).toThrow(
      'DOC_EVENT_ID_CONFLICT'
    );
    expect(() => ingest(f)).toThrow('DOC_EVENT_RATE_LIMIT');
    expect(snapshot(f)).toEqual(before);
  });
  it('preserves status UUIDs, original sequence and duplicate receipts across FILE database reopen', () => {
    const folder = mkdtempSync(join(tmpdir(), 'doc-initial-status-'));
    folders.push(folder);
    const file = join(folder, 'events.sqlite');
    const f = fixture(file);
    const input = event();
    const first = ingest(f, input);
    const before = rows(f);
    f.db.$client.close();
    dbs.splice(dbs.indexOf(f.db), 1);
    const db = createDb(file);
    const reopened = batchFixture(
      file,
      null,
      { db, documentId: f.documentId, grantId: f.grantId },
      'boot-2'
    );
    dbs.push(db);
    expect(ingest(reopened, input).receipt).toEqual({ ...first.receipt, status: 'duplicate' });
    expect(rows(reopened)).toEqual(before);
    expect(replayDocChannel(reopened.store, authority(reopened)).events).toHaveLength(2);
  });
  it.each(['a', 'b', 'c'])(
    'rolls back ALL original/route/sequence mutations on %s status SQL failure',
    (id) => {
      const f = fixture();
      configure(
        f,
        ['c', 'b', 'a'].map((name) => route(name))
      );
      const before = snapshot(f);
      f.db.$client.exec(`CREATE TRIGGER fail_initial BEFORE INSERT ON canvas_doc_events
      WHEN NEW.type='event.status' AND json_extract(NEW.payload,'$.routeId')='${id}'
      BEGIN SELECT RAISE(ABORT,'initial status failure'); END`);
      expect(() => ingest(f)).toThrow('DOC_EVENT_STORAGE_FAILURE');
      expect(snapshot(f)).toEqual(before);
    }
  );
  it('rolls back superseding, batch mutation and envelope backfill when a later status fails', () => {
    const f = fixture();
    configure(
      f,
      ['a', 'b'].map((name) => route(name))
    );
    const first = { ...event(), coalesceKey: 'checkbox' };
    ingest(f, first);
    f.db.$client
      .prepare('UPDATE canvas_doc_events SET envelope_bytes=0 WHERE event_id=?')
      .run(first.id);
    const before = snapshot(f);
    f.db.$client.exec(`CREATE TRIGGER fail_initial BEFORE INSERT ON canvas_doc_events
      WHEN NEW.type='event.status' AND json_extract(NEW.payload,'$.routeId')='b'
      BEGIN SELECT RAISE(ABORT,'initial status failure'); END`);
    expect(() => ingest(f, { ...event(), coalesceKey: 'checkbox' })).toThrow(
      'DOC_EVENT_STORAGE_FAILURE'
    );
    expect(snapshot(f)).toEqual(before);
  });
  it('rolls back a late sequence exhaustion after earlier status allocation', () => {
    const f = fixture();
    configure(
      f,
      ['a', 'b'].map((name) => route(name))
    );
    f.db.$client
      .prepare('UPDATE canvas_doc_channels SET next_doc_seq=? WHERE document_id=?')
      .run(Number.MAX_SAFE_INTEGER - 2, f.documentId);
    const before = snapshot(f);
    expect(() => ingest(f)).toThrow();
    expect(snapshot(f)).toEqual(before);
  });
  it('includes status rows in bounded retention while preserving a pending original and honest replay reset', () => {
    const f = fixture();
    const input = event();
    const result = ingest(f, input);
    retainDocHistory(f.store, NOW, { documentBytes: 1, installationBytes: 1 });
    expect(statuses(f)).toEqual([]);
    expect(f.store.getEvent(f.documentId, input.id)!.payload).toEqual(input.payload);
    expect(f.store.listDeliveries(f.documentId, input.id)).toEqual(result.deliveries);
    const replay = replayDocChannel(f.store, authority(f));
    expect(replay.resetRequired).toBe(true);
    expect(replay.retentionFloor).toBe(3);
    expect(
      replay.receipts.some((receipt) => receipt.id === input.id && receipt.payloadAvailable)
    ).toBe(true);
    const before = snapshot(f);
    expect(ingest(f, input).receipt.status).toBe('duplicate');
    expect(snapshot(f)).toEqual(before);
  });
  it('rolls retention back when removing a status fails', () => {
    const f = fixture();
    ingest(f);
    const before = snapshot(f);
    f.db.$client.exec(`CREATE TRIGGER fail_status_delete BEFORE DELETE ON canvas_doc_events
      WHEN OLD.type='event.status' BEGIN SELECT RAISE(ABORT,'retention status failure'); END`);
    expect(() => retainDocHistory(f.store, NOW, { documentBytes: 1 })).toThrow();
    expect(snapshot(f)).toEqual(before);
  });
  it('renders only original inputs despite interleaved durable status sequences', () => {
    const f = fixture();
    const first = ingest(f);
    const second = ingest(f);
    const batch = f.store.getBatch(first.deliveries[0]!.batchId!)!;
    const slice = f.store.transaction((tx) =>
      selectBatchSlice(f.store, tx, batch, 100, 'Private title')
    );
    expect(slice.context.events.map((item) => item.id)).toEqual([
      first.receipt.id,
      second.receipt.id,
    ]);
    expect(slice.context.events.map((item) => item.docSeq)).toEqual([1, 3]);
    expect(slice.context.events.some((item) => item.type === 'event.status')).toBe(false);
  });
  it('keeps a 101-original batch slice bounded and preserves its original deadline', () => {
    const f = fixture();
    let at = Date.parse(NOW);
    const receiver = new DocChannelIngest(f.store, () => new Date(at));
    const inputs = [];
    for (let i = 0; i < 101; i++) {
      inputs.push(receiver.accept(event(), authority(f)));
      at += 2000;
    }
    const batch = f.store.getBatch(inputs[0]!.deliveries[0]!.batchId!)!;
    expect(batch.dueAt).toBe(new Date(Date.parse(NOW) + 1000).toISOString());
    const slice = f.store.transaction((tx) =>
      selectBatchSlice(f.store, tx, batch, 100, 'Private title')
    );
    expect(slice.context.events).toHaveLength(100);
    expect(slice.context.events.map((item) => item.id)).toEqual(
      inputs.slice(0, 100).map((item) => item.receipt.id)
    );
    expect(slice.overflowIds).toEqual([inputs[100]!.receipt.id]);
    expect(rows(f)).toHaveLength(202);
    expect(new Set(statuses(f).map((row) => row.event_id)).size).toBe(101);
  });
  it('keeps the rolling-hour started-turn charge while retaining away initial statuses', async () => {
    const f = fixture();
    const input = ingest(f);
    const accepted = f.admission.admit(input.deliveries[0]!.batchId!);
    const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
    expect(f.admission.acceptance.claim(accepted.receipt.id, prepared)).toMatchObject({
      dispatchAttemptId: expect.any(String),
    });
    f.admission.acceptance.markTurnStarted(accepted.receipt.id, 1);
    f.admission.acceptance.settle(accepted.receipt.id, 'ok');
    const before = f.db.$client
      .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
      .get(accepted.receipt.id);
    retainDocHistory(f.store, NOW, { documentBytes: 1, installationBytes: 1 });
    expect(statuses(f)).toEqual([]);
    expect(f.store.getEvent(f.documentId, input.receipt.id)).toBeUndefined();
    expect(f.store.getBatch(accepted.receipt.sourceId)).toMatchObject({
      status: 'turn_done',
      admissionReceiptId: accepted.receipt.id,
    });
    expect(
      f.db.$client
        .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
        .get(accepted.receipt.id)
    ).toEqual(before);
  });
  it.each([
    'too-many',
    'duplicate',
    'wrong-original',
    'identifier',
    'reason',
    'private-reason',
    'status',
    'batch',
  ])('refuses the entire malformed %s initial snapshot before any status write', (defect) => {
    const f = fixture();
    const result = ingest(f);
    const original = f.store.getEvent(f.documentId, result.receipt.id)!;
    const delivery = result.deliveries[0]!;
    const invalid = { ...delivery };
    if (defect === 'wrong-original') invalid.eventId = randomUUID();
    if (defect === 'identifier') invalid.routeId = 'x'.repeat(201);
    if (defect === 'reason') invalid.reason = 'x'.repeat(1001);
    if (defect === 'private-reason') invalid.reason = 'PRIVATE DIAGNOSTIC';
    if (defect === 'status') invalid.status = 'failed';
    if (defect === 'batch') invalid.batchId = null;
    const deliveries =
      defect === 'too-many'
        ? Array.from({ length: 17 }, (_, i) => ({ ...delivery, routeId: `r${i}` }))
        : defect === 'duplicate'
          ? [delivery, delivery]
          : [
              delivery,
              { ...invalid, routeId: defect === 'identifier' ? invalid.routeId : 'second' },
            ];
    const before = snapshot(f);
    expect(() =>
      f.store.transaction((tx) => appendInitialDocStatuses(f.store, tx, original, deliveries, NOW))
    ).toThrow('Invalid initial document status snapshot.');
    expect(snapshot(f)).toEqual(before);
  });
});
