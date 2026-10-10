/** Protected-key accounting preserves retention authority without scanning retained events. */
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, sql, type Db, type DbTransaction } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import {
  DOC_INGEST_LIMITS,
  checkIngestCapacity,
  protectedCapacityQuery,
  protectedEventSql,
} from '../current/accounting.js';
import { DocIngestRefusal } from '../ingest-types.js';

const NOW = '2026-10-01T12:00:00.000Z';
const OLD = '2026-10-01T10:00:00.000Z';
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});
function fixture() {
  const db = createDb(':memory:');
  databases.push(db);
  runMigrations(db);
  return { db, store: new DocChannelStore(db) };
}
function seedDocument(store: DocChannelStore, documentId: string, bytes: number) {
  store.initialize({ documentId, scope: 'session:s1', createdAt: OLD, updatedAt: OLD });
  store.insertGrant({
    grantId: documentId,
    documentId,
    routeId: 'route',
    normalizedRoute: {},
    routeHash: 'hash',
    declarationHash: 'hash',
    approvedBy: 'fixture',
    approvalEvidence: {},
    allowedTypes: ['task.*'],
    limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    createdAt: OLD,
  });
  for (const [eventId, size] of [
    ['shared-id', bytes],
    ['unlinked-id', 100000],
  ] as const)
    store.appendEvent({
      documentId,
      eventId,
      direction: 'upstream',
      type: 'task.toggle',
      payload: { checked: true },
      envelopeHash: 'hash',
      envelopeBytes: size,
      receivedAt: OLD,
      provenance: {},
    });
}
function seedReferences(
  db: Db,
  documentId: string,
  delivery: string,
  batch: string,
  member: boolean
) {
  const batchId = `batch:${documentId}`;
  db.$client
    .prepare(
      'INSERT INTO canvas_doc_batches (batch_id,document_id,scope,route_id,grant_id,grant_revision,generation,input_event_ids,effective_payload,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?)'
    )
    .run(
      batchId,
      documentId,
      'session:s1',
      'route',
      documentId,
      'generation',
      JSON.stringify(member ? ['shared-id', 'unlinked-id'] : ['unlinked-id']),
      '{}',
      OLD,
      batch,
      OLD,
      OLD
    );
  // Duplicate routes must not charge an original twice. The active batch also
  // names an event with no matching delivery, which must remain unprotected.
  for (const routeId of ['route', 'another-route'])
    db.$client
      .prepare(
        'INSERT INTO canvas_doc_deliveries (document_id,event_id,route_id,batch_id,status,updated_at) VALUES (?,?,?,?,?,?)'
      )
      .run(documentId, 'shared-id', routeId, batchId, delivery, OLD);
}
function originalUsage(tx: DbTransaction, documentId: string) {
  return tx.get<{ count: number; bytes: number }>(sql`SELECT count(*) AS count,
    coalesce(sum(envelope_bytes),0) AS bytes FROM canvas_doc_events e
    WHERE e.document_id=${documentId} AND ${protectedEventSql}`)!;
}

it('matches the retained predicate across statuses, membership, pruning, multiple routes and documents', () => {
  const { db, store } = fixture();
  // Include legacy accepted delivery text, which the retained predicate protects.
  const deliveries = [
    'saved',
    'pending',
    'waiting',
    'accepted',
    'routed',
    'superseded',
    'turn_started',
    'turn_done',
    'failed',
    'expired',
    'cancelled',
    'in_doubt',
  ];
  const batches = [
    'pending',
    'waiting',
    'accepted',
    'dispatching',
    'turn_started',
    'turn_done',
    'failed',
    'expired',
    'cancelled',
    'in_doubt',
  ];
  const documents: string[] = [];
  for (const delivery of deliveries)
    for (const batch of batches)
      for (const member of [true, false])
        for (const pruned of [true, false]) {
          const documentId = `doc:${documents.length}`;
          documents.push(documentId);
          seedDocument(store, documentId, documents.length);
          seedReferences(db, documentId, delivery, batch, member);
          if (pruned)
            db.$client
              .prepare(
                "UPDATE canvas_doc_events SET payload='null',payload_pruned_at=? WHERE document_id=?"
              )
              .run(NOW, documentId);
        }
  db.transaction((tx) => {
    for (const documentId of documents)
      expect(tx.get(protectedCapacityQuery(documentId)), documentId).toEqual(
        originalUsage(tx, documentId)
      );
    const original = tx.get(sql`SELECT coalesce(sum(envelope_bytes),0) AS bytes
      FROM canvas_doc_events e WHERE ${protectedEventSql}`);
    expect(tx.get(protectedCapacityQuery())).toEqual(original);
  });
  expect(documents).toHaveLength(480);
  expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('preserves exact count/document/global byte capacity decisions and performs no writes', () => {
  const { db, store } = fixture();
  for (const [id, bytes] of [
    ['doc-a', 100],
    ['doc-b', 200],
  ] as const) {
    seedDocument(store, id, bytes);
    seedReferences(db, id, 'superseded', 'accepted', true);
  }
  const before = db.$client.prepare('SELECT * FROM canvas_doc_events').all();
  db.transaction((tx) => {
    expect(tx.get(protectedCapacityQuery('absent-doc'))).toEqual({ count: 0, bytes: 0 });
    const usage = originalUsage(tx, 'doc-a');
    const global = tx.get<{ bytes: number }>(
      sql`SELECT coalesce(sum(envelope_bytes),0) AS bytes FROM canvas_doc_events e WHERE ${protectedEventSql}`
    )!.bytes;
    expect(usage).toEqual({ count: 1, bytes: 100 });
    expect(global).toBe(300);
    for (const count of [0, 1, 2])
      for (const bytes of [100, 110, 111])
        for (const installation of [309, 310, 311]) {
          const refused =
            usage.count >= count || usage.bytes + 10 > bytes || global + 10 > installation;
          const limits = {
            ...DOC_INGEST_LIMITS,
            pendingEvents: count,
            pendingBytes: bytes,
            installationPendingBytes: installation,
          };
          let error: unknown;
          try {
            checkIngestCapacity(tx, 'doc-a', NOW, 10, undefined, limits);
          } catch (caught) {
            error = caught;
          }
          if (refused) {
            expect(error).toBeInstanceOf(DocIngestRefusal);
            expect(error).toMatchObject({ code: 'DOC_EVENT_BACKLOG_FULL', status: 429 });
          } else expect(error).toBeUndefined();
        }
    expect(() =>
      checkIngestCapacity(
        tx,
        'doc-a',
        NOW,
        10,
        undefined,
        { ...DOC_INGEST_LIMITS, pendingEvents: 0 },
        false
      )
    ).not.toThrow();
  });
  expect(db.$client.prepare('SELECT * FROM canvas_doc_events').all()).toEqual(before);
});

it('does not borrow an orphaned or another document batch link to protect an inactive delivery', () => {
  const { db, store } = fixture();
  seedDocument(store, 'doc-a', 100);
  seedDocument(store, 'doc-b', 200);
  seedReferences(db, 'doc-a', 'superseded', 'accepted', true);
  seedReferences(db, 'doc-b', 'superseded', 'accepted', true);
  const relink = db.$client.prepare(
    'UPDATE canvas_doc_deliveries SET batch_id=? WHERE document_id=?'
  );
  relink.run(null, 'doc-a');
  // The real composite foreign key also prevents borrowing a batch from
  // another document, even though its input IDs are identical.
  for (const batchId of ['missing-batch', 'batch:doc-b'])
    expect(() => relink.run(batchId, 'doc-a')).toThrow('FOREIGN KEY constraint failed');
  db.transaction((tx) => {
    expect(originalUsage(tx, 'doc-a')).toEqual({ count: 0, bytes: 0 });
    expect(tx.get(protectedCapacityQuery('doc-a'))).toEqual(originalUsage(tx, 'doc-a'));
    expect(tx.get(protectedCapacityQuery())).toEqual({ bytes: 200 });
  });
  db.$client
    .prepare("UPDATE canvas_doc_deliveries SET status='waiting' WHERE document_id=?")
    .run('doc-a');
  db.transaction((tx) => {
    expect(originalUsage(tx, 'doc-a')).toEqual({ count: 1, bytes: 100 });
    expect(tx.get(protectedCapacityQuery('doc-a'))).toEqual(originalUsage(tx, 'doc-a'));
    expect(tx.get(protectedCapacityQuery())).toEqual({ bytes: 300 });
  });
});

it('uses per-input primary-key probes for a large active batch beside retained history', () => {
  const { db, store } = fixture();
  seedDocument(store, 'doc-a', 100);
  seedReferences(db, 'doc-a', 'superseded', 'waiting', true);
  const insert = db.$client.prepare(
    "INSERT INTO canvas_doc_events (document_id,event_id,doc_seq,direction,type,payload,envelope_hash,envelope_bytes,received_at,provenance) VALUES ('doc-a',?,?, 'upstream','task.toggle','{}','hash',100,?,'{}')"
  );
  const delivery = db.$client.prepare(
    "INSERT INTO canvas_doc_deliveries (document_id,event_id,route_id,batch_id,status,updated_at) VALUES ('doc-a',?,'route','batch:doc-a','superseded',?)"
  );
  db.$client.transaction(() => {
    for (let i = 0; i < 2000; i++) {
      insert.run(`retained:${i}`, i + 3, OLD);
      if (i < 1000) delivery.run(`retained:${i}`, OLD);
    }
    db.$client
      .prepare('UPDATE canvas_doc_batches SET input_event_ids=? WHERE batch_id=?')
      .run(
        JSON.stringify([
          'shared-id',
          'unlinked-id',
          ...Array.from({ length: 1000 }, (_, i) => `retained:${i}`),
        ]),
        'batch:doc-a'
      );
  })();
  expect(
    db.$client.prepare('PRAGMA index_info(sqlite_autoindex_canvas_doc_deliveries_1)').all()
  ).toEqual([
    { seqno: 0, cid: 0, name: 'document_id' },
    { seqno: 1, cid: 1, name: 'event_id' },
    { seqno: 2, cid: 2, name: 'route_id' },
  ]);
  db.transaction((tx) => {
    for (const documentId of ['doc-a', undefined]) {
      const plan = tx
        .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${protectedCapacityQuery(documentId)}`)
        .map((row) => row.detail);
      expect(plan).toContainEqual(expect.stringContaining('canvas_doc_deliveries_status_idx'));
      expect(plan).toContainEqual(expect.stringContaining('canvas_doc_batches_due_idx'));
      expect(plan).toContainEqual(
        expect.stringMatching(
          /SEARCH d .*sqlite_autoindex_canvas_doc_deliveries_1 \(document_id=\? AND event_id=\?\)/
        )
      );
      expect(plan).toContainEqual(
        expect.stringMatching(/SEARCH e .*\(document_id=\? AND event_id=\?\)/)
      );
      expect(plan.some((step) => /SCAN e\b/.test(step))).toBe(false);
    }
    expect(tx.get(protectedCapacityQuery('doc-a'))).toEqual({ count: 1001, bytes: 100100 });
    expect(tx.get(protectedCapacityQuery('doc-a'))).toEqual(originalUsage(tx, 'doc-a'));
    expect(tx.get(protectedCapacityQuery())).toEqual({ bytes: 100100 });
  });
});

// The paid SDK process alone is replaced. Authority comes from the real original constructor/FILE DB.
const nativeRetentionSdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      nativeRetentionSdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-retention-source',
        runStreamed: async (prompt: unknown) => {
          nativeRetentionSdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (nativeRetentionSdk.parked)
                await new Promise<void>((resolve) => {
                  nativeRetentionSdk.release = resolve;
                });
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
              };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));
import { nativeCommittedCodexRoomFixture } from '../writes/__tests__/authority-fixtures.js';
function originalNativeRetentionSource(disposition: 'settled' | 'unpulled' = 'settled') {
  nativeRetentionSdk.options.length = 0;
  nativeRetentionSdk.prompts.length = 0;
  nativeRetentionSdk.parked = true;
  nativeRetentionSdk.release = undefined;
  return nativeCommittedCodexRoomFixture(
    {
      options: nativeRetentionSdk.options,
      prompts: nativeRetentionSdk.prompts,
      releaseProducer: () => nativeRetentionSdk.release?.(),
      completeFutureTurns: () => {
        nativeRetentionSdk.parked = false;
      },
    },
    disposition
  );
}

it('counts genuine settled native evidence for retention without charging it as pending backlog', async () => {
  const h = await originalNativeRetentionSource();
  let failed = false,
    first: unknown;
  try {
    expect(
      h.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM room_doc_admission_inputs WHERE document_id=${h.documentId} AND event_id=${h.input.id}`
      )
    ).toEqual({ n: 1 });
    expect(
      h.db.get<{ count: number; bytes: number }>(protectedCapacityQuery(h.documentId))
    ).toEqual({ count: 0, bytes: 0 });
    expect(h.db.get<{ bytes: number }>(protectedCapacityQuery())).toEqual({ bytes: 0 });
    expect(() =>
      h.http.channels.transaction((tx) =>
        checkIngestCapacity(
          tx,
          h.documentId,
          new Date(Date.now() + 61_000).toISOString(),
          1,
          undefined,
          { ...DOC_INGEST_LIMITS, pendingEvents: 1, pendingBytes: 1, installationPendingBytes: 1 }
        )
      )
    ).not.toThrow();
    expect(h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)).toEqual({
      n: 1,
    });
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});
