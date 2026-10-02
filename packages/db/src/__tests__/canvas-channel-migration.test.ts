import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  canvasDocBatches,
  canvasDocChannels,
  canvasDocDeliveries,
  canvasDocEvents,
  canvasDocGrants,
  canvasDocIdentityIntents,
  canvasDocWriteIntents,
  createDb,
  eq,
  runMigrations,
  sessionMessageAcceptanceReceipts,
} from '../index';
import type { Db } from '../index';

const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const now = '2026-10-01T12:00:00.000Z';
const handles: Db[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dorkos-doc-channel-'));
  directories.push(directory);
  return directory;
}

function database(filename = ':memory:', fullMigration = true): Db {
  const db = createDb(filename);
  handles.push(db);
  if (fullMigration) runMigrations(db);
  return db;
}

function seedChannel(db: Db, documentId = 'doc-a'): void {
  db.insert(canvasDocChannels)
    .values({ documentId, scope: 'session:s1', createdAt: now, updatedAt: now })
    .run();
}

function seedEvent(db: Db, documentId = 'doc-a', eventId = 'event-a', docSeq = 1): void {
  db.insert(canvasDocEvents)
    .values({
      documentId,
      eventId,
      docSeq,
      direction: 'upstream',
      type: 'app.changed',
      payload: { value: '☃' },
      envelopeHash: 'hash',
      receivedAt: now,
      provenance: { transport: 'frame' },
    })
    .run();
}

function seedGrant(db: Db, documentId = 'doc-a'): string {
  const grantId = `grant-${documentId}`;
  db.insert(canvasDocGrants)
    .values({
      grantId,
      documentId,
      routeId: 'route-a',
      normalizedRoute: { target: 'agent:owner' },
      routeHash: 'route-hash',
      declarationHash: 'declaration-hash',
      approvedBy: 'owner',
      approvalEvidence: { approved: true },
      limits: { envelopeBytes: 16384, eventsPerMinute: 100, turnsPerHour: 10 },
      allowedTypes: ['app.changed'],
      createdAt: now,
    })
    .run();
  return grantId;
}

function seedBatch(
  db: Db,
  batchId: string,
  status: typeof canvasDocBatches.$inferInsert.status = 'pending',
  documentId = 'doc-a'
): void {
  db.insert(canvasDocBatches)
    .values({
      batchId,
      documentId,
      scope: 'session:s1',
      routeId: 'route-a',
      grantId: `grant-${documentId}`,
      grantRevision: 1,
      generation: 'generation-1',
      inputEventIds: ['event-a'],
      effectivePayload: { value: 1 },
      dueAt: now,
      status,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function schemaSql(db: Db, name: string): string {
  return (
    db.$client.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }
  ).sql;
}

/** Build the actual previous schema, through the journal entry before this addition. */
function previousMigrations(): string {
  const folder = tempDirectory();
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(migrationDir, 'meta/_journal.json'), 'utf8')
  ) as { entries: { idx: number; tag: string }[] };
  const newEntry = journal.entries.find((entry) => entry.tag === '0137_canvas_channel');
  expect(newEntry).toBeDefined();
  journal.entries = journal.entries.filter((entry) => entry.idx < newEntry!.idx);
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(
      path.join(migrationDir, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  return folder;
}

function seedPhysicalDocument(db: Db): void {
  db.$client
    .prepare(
      `INSERT INTO canvas_documents
    (id, scope, content, title, content_type, author_id, rev, last_touched_by,
     last_touched_at, opened_at, last_active_at)
    VALUES ('doc-a','session:s1','{"type":"json","data":{}}','Old document','json','owner',1,'owner',?,?,?)`
    )
    .run(now, now, now);
}

describe('canvas channel production migration', () => {
  it('upgrades populated previous schema without changing documents or admission source kinds', () => {
    const db = database(':memory:', false);
    migrate(db, { migrationsFolder: previousMigrations() });
    seedPhysicalDocument(db);
    for (const sourceKind of ['connector_agent_request', 'connector_event'] as const) {
      db.insert(sessionMessageAcceptanceReceipts)
        .values({
          id: sourceKind,
          sourceKind,
          sourceId: sourceKind,
          sourceGeneration: 'g1',
          queueMessageId: sourceKind,
          sessionId: 's1',
          agentId: 'a1',
          originRuntime: 'claude-code',
          originAgentPath: '/tmp/agent',
          originAuthorityDigest: 'digest',
          state: 'accepted',
          acceptedAt: now,
        })
        .run();
    }
    const document = db.$client.prepare('SELECT * FROM canvas_documents').get();
    const receipts = db.select().from(sessionMessageAcceptanceReceipts).all();
    const receiptSchema = schemaSql(db, 'session_message_acceptance_receipts');
    runMigrations(db);
    expect(db.$client.prepare('SELECT * FROM canvas_documents').get()).toEqual(document);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receipts);
    expect(schemaSql(db, 'session_message_acceptance_receipts')).toBe(receiptSchema);
    expect(sessionMessageAcceptanceReceipts.sourceKind.enumValues).toEqual([
      'connector_agent_request',
      'connector_event',
      'document_event_batch',
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates all query and recovery indexes with the exact partial lifecycle predicates', () => {
    const db = database();
    const expected: Record<string, string[]> = {
      canvas_doc_channels_scope_idx: ['scope', 'closed_at'],
      canvas_doc_events_sequence_unique: ['document_id', 'doc_seq'],
      canvas_doc_events_received_idx: ['document_id', 'received_at'],
      canvas_doc_events_retention_idx: ['received_at', 'document_id', 'doc_seq'],
      canvas_doc_events_unaccounted_idx: ['document_id', 'event_id'],
      canvas_doc_grants_document_id_unique: ['document_id', 'grant_id'],
      canvas_doc_grants_route_idx: ['document_id', 'route_id', 'revoked_at'],
      canvas_doc_batches_document_id_unique: ['document_id', 'batch_id'],
      canvas_doc_batches_pending_unique: ['document_id', 'route_id'],
      canvas_doc_batches_active_unique: ['document_id', 'route_id'],
      canvas_doc_batches_due_idx: ['status', 'due_at'],
      canvas_doc_batches_lease_idx: ['status', 'lease_until'],
      canvas_doc_batches_receipt_idx: ['admission_receipt_id'],
      canvas_doc_deliveries_batch_idx: ['document_id', 'batch_id'],
      canvas_doc_deliveries_status_idx: ['status', 'updated_at'],
      canvas_doc_identity_intents_recovery_idx: ['status', 'updated_at'],
      canvas_doc_write_intents_event_unique: ['document_id', 'event_id'],
      canvas_doc_write_intents_recovery_idx: ['status', 'updated_at'],
      canvas_doc_write_intents_path_idx: ['canonical_path', 'status'],
    };
    const indexes = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name GLOB 'canvas_doc_*' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];
    expect(indexes.map(({ name }) => name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, columns] of Object.entries(expected)) {
      expect(
        (db.$client.prepare(`PRAGMA index_info(${name})`).all() as { name: string }[]).map(
          (column) => column.name
        )
      ).toEqual(columns);
    }
    expect(schemaSql(db, 'canvas_doc_events_unaccounted_idx')).toContain(
      'WHERE "canvas_doc_events"."envelope_bytes"=0 AND "canvas_doc_events"."payload_pruned_at" IS NULL'
    );
    expect(schemaSql(db, 'canvas_doc_batches_pending_unique')).toContain(
      `WHERE "status" in ('pending', 'waiting')`
    );
    expect(schemaSql(db, 'canvas_doc_batches_active_unique')).toContain(
      `WHERE "status" in ('accepted', 'dispatching', 'turn_started', 'in_doubt')`
    );
    for (const name of ['canvas_doc_batches_pending_unique', 'canvas_doc_batches_active_unique']) {
      expect(
        db.$client
          .prepare(
            "SELECT [unique], partial FROM pragma_index_list('canvas_doc_batches') WHERE name=?"
          )
          .get(name)
      ).toEqual({ unique: 1, partial: 1 });
    }
  });

  it('starts with an empty revision-zero state and persists JSON plus recovery evidence across reopen', () => {
    const filename = path.join(tempDirectory(), 'dork.db');
    const db = database(filename);
    seedChannel(db);
    expect(db.select().from(canvasDocChannels).get()).toMatchObject({
      nextDocSeq: 1,
      state: {},
      stateRev: 0,
      retentionFloor: 1,
    });
    seedGrant(db);
    db.insert(canvasDocIdentityIntents)
      .values({
        intentId: 'move',
        documentId: 'doc-a',
        fromScope: 'session:s1',
        toScope: 'session:s2',
        sourceId: 'batch',
        sourceGeneration: 'g1',
        evidence: { receiptId: 'r1' },
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(canvasDocWriteIntents)
      .values({
        intentId: 'write',
        documentId: 'doc-a',
        eventId: 'unaccepted-event',
        envelopeHash: 'hash',
        grantId: 'grant-doc-a',
        sourceIdentity: { sourceKey: 'path:/tmp/note.md' },
        resolvedCwd: '/tmp',
        treeKind: 'worktree',
        canonicalPath: '/tmp/note.md',
        operation: 'checkbox-toggle',
        input: { line: 1, checked: true },
        beforeHash: 'before',
        afterHash: 'after',
        expectedVersion: 'v1',
        evidence: { replaced: true },
        status: 'in_doubt',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(canvasDocWriteIntents)
        .values({ ...db.select().from(canvasDocWriteIntents).get()!, intentId: 'write-duplicate' })
        .run()
    ).toThrow(/UNIQUE/);
    db.$client.close();
    const reopened = database(filename);
    expect(reopened.select().from(canvasDocGrants).get()).toMatchObject({
      routeHash: 'route-hash',
      declarationHash: 'declaration-hash',
      limits: { envelopeBytes: 16384, eventsPerMinute: 100, turnsPerHour: 10 },
      approvalEvidence: { approved: true },
    });
    expect(reopened.select().from(canvasDocIdentityIntents).get()).toMatchObject({
      sourceGeneration: 'g1',
      evidence: { receiptId: 'r1' },
      status: 'pending',
    });
    expect(reopened.select().from(canvasDocWriteIntents).get()).toMatchObject({
      eventId: 'unaccepted-event',
      beforeHash: 'before',
      afterHash: 'after',
      status: 'in_doubt',
    });
    expect(reopened.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('retains superseded input outcomes beside pending input without fabricating acknowledgement', () => {
    const filename = path.join(tempDirectory(), 'dork.db');
    const db = database(filename);
    seedChannel(db);
    seedGrant(db);
    seedEvent(db);
    seedEvent(db, 'doc-a', 'event-b', 2);
    seedBatch(db, 'batch-a');
    db.update(canvasDocBatches)
      .set({ inputEventIds: ['event-a', 'event-b'] })
      .run();
    db.insert(canvasDocDeliveries)
      .values([
        {
          documentId: 'doc-a',
          eventId: 'event-a',
          routeId: 'route-a',
          batchId: 'batch-a',
          status: 'superseded',
          reason: 'coalesced',
          updatedAt: now,
        },
        {
          documentId: 'doc-a',
          eventId: 'event-b',
          routeId: 'route-a',
          batchId: 'batch-a',
          status: 'pending',
          updatedAt: now,
        },
      ])
      .run();
    db.$client.close();

    const reopened = database(filename);
    expect(
      reopened.select().from(canvasDocDeliveries).orderBy(canvasDocDeliveries.eventId).all()
    ).toMatchObject([
      {
        eventId: 'event-a',
        status: 'superseded',
        reason: 'coalesced',
        batchId: 'batch-a',
        turnId: null,
        ackOutcome: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        ackEvidence: null,
      },
      {
        eventId: 'event-b',
        status: 'pending',
        batchId: 'batch-a',
        turnId: null,
        ackOutcome: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        ackEvidence: null,
      },
    ]);
    expect(reopened.select().from(canvasDocBatches).get()).toMatchObject({
      status: 'pending',
      inputEventIds: ['event-a', 'event-b'],
      admissionReceiptId: null,
    });
    expect(reopened.select().from(canvasDocEvents).all()).toHaveLength(2);
    expect(reopened.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('scopes event identities and sequences by document, with rollback of event and sequence together', () => {
    const db = database();
    seedChannel(db);
    seedChannel(db, 'doc-b');
    seedEvent(db);
    seedEvent(db, 'doc-b');
    db.update(canvasDocChannels).set({ nextDocSeq: 2 }).run();
    expect(() => seedEvent(db, 'doc-a', 'event-a', 2)).toThrow(/UNIQUE/);
    expect(() => seedEvent(db, 'doc-a', 'event-b', 1)).toThrow(/UNIQUE/);
    expect(() =>
      db.transaction((tx) => {
        tx.update(canvasDocChannels)
          .set({ nextDocSeq: 3 })
          .where(eq(canvasDocChannels.documentId, 'doc-a'))
          .run();
        tx.insert(canvasDocEvents)
          .values({
            ...db
              .select()
              .from(canvasDocEvents)
              .where(eq(canvasDocEvents.documentId, 'doc-a'))
              .get()!,
            eventId: 'event-b',
            docSeq: 2,
          })
          .run();
        throw new Error('rollback');
      })
    ).toThrow('rollback');
    expect(db.select().from(canvasDocEvents).all()).toHaveLength(2);
    expect(
      db.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, 'doc-a')).get()
        ?.nextDocSeq
    ).toBe(2);
    for (const docSeq of [2, 3]) {
      db.transaction((tx) => {
        const channel = tx
          .select()
          .from(canvasDocChannels)
          .where(eq(canvasDocChannels.documentId, 'doc-a'))
          .get()!;
        expect(channel.nextDocSeq).toBe(docSeq);
        tx.insert(canvasDocEvents)
          .values({
            ...db
              .select()
              .from(canvasDocEvents)
              .where(eq(canvasDocEvents.documentId, 'doc-a'))
              .get()!,
            eventId: `event-${docSeq}`,
            docSeq,
          })
          .run();
        tx.update(canvasDocChannels)
          .set({ nextDocSeq: docSeq + 1 })
          .where(eq(canvasDocChannels.documentId, 'doc-a'))
          .run();
      });
    }
    expect(
      db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.documentId, 'doc-a'))
        .all()
        .map(({ docSeq }) => docSeq)
    ).toEqual([1, 2, 3]);
    expect(
      db.select().from(canvasDocChannels).where(eq(canvasDocChannels.documentId, 'doc-b')).get()
        ?.nextDocSeq
    ).toBe(2);
  });

  it('allows one pending beside one active batch, and frees slots only for terminal lifecycles', () => {
    const db = database();
    seedChannel(db);
    seedChannel(db, 'doc-b');
    seedGrant(db);
    seedGrant(db, 'doc-b');
    seedBatch(db, 'pending');
    seedBatch(db, 'active', 'accepted');
    seedBatch(db, 'other-document', 'pending', 'doc-b');
    expect(() => seedBatch(db, 'waiting', 'waiting')).toThrow(/UNIQUE/);
    for (const status of ['accepted', 'dispatching', 'turn_started', 'in_doubt'] as const)
      expect(() => seedBatch(db, `duplicate-${status}`, status)).toThrow(/UNIQUE/);
    for (const status of ['turn_done', 'failed', 'expired', 'cancelled'] as const)
      expect(() => seedBatch(db, `terminal-${status}`, status)).not.toThrow();
    db.update(canvasDocBatches)
      .set({ status: 'cancelled' })
      .where(eq(canvasDocBatches.batchId, 'pending'))
      .run();
    db.update(canvasDocBatches)
      .set({ status: 'turn_done' })
      .where(eq(canvasDocBatches.batchId, 'active'))
      .run();
    expect(() => seedBatch(db, 'new-pending', 'waiting')).not.toThrow();
    expect(() => seedBatch(db, 'new-active', 'dispatching')).not.toThrow();
  });

  it('rejects cross-document grant, event and batch references and nonexistent admission receipts', () => {
    const db = database();
    for (const id of ['doc-a', 'doc-b']) {
      seedChannel(db, id);
      seedGrant(db, id);
    }
    seedEvent(db);
    seedBatch(db, 'batch-a');
    expect(() =>
      db
        .insert(canvasDocBatches)
        .values({
          ...db.select().from(canvasDocBatches).get()!,
          batchId: 'bad-grant',
          documentId: 'doc-b',
        })
        .run()
    ).toThrow(/FOREIGN KEY/);
    const delivery = {
      documentId: 'doc-b',
      eventId: 'event-a',
      routeId: 'route-a',
      batchId: null,
      status: 'pending' as const,
      updatedAt: now,
    };
    expect(() => db.insert(canvasDocDeliveries).values(delivery).run()).toThrow(/FOREIGN KEY/);
    seedEvent(db, 'doc-b');
    expect(() =>
      db
        .insert(canvasDocDeliveries)
        .values({ ...delivery, batchId: 'batch-a' })
        .run()
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.update(canvasDocBatches).set({ admissionReceiptId: 'nonexistent' }).run()
    ).toThrow(/FOREIGN KEY/);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('retains channel history, receipt outcomes and closure tombstone after physical deletion', () => {
    const db = database();
    seedPhysicalDocument(db);
    seedChannel(db);
    seedEvent(db);
    seedGrant(db);
    seedBatch(db, 'batch-a');
    db.insert(canvasDocDeliveries)
      .values({
        documentId: 'doc-a',
        eventId: 'event-a',
        routeId: 'route-a',
        batchId: 'batch-a',
        status: 'pending',
        updatedAt: now,
      })
      .run();
    db.transaction((tx) => {
      tx.update(canvasDocChannels)
        .set({ closedAt: now, closureEvidence: { reason: 'removed', actor: 'owner' } })
        .run();
      tx.update(canvasDocGrants).set({ revokedAt: now }).run();
      tx.update(canvasDocBatches).set({ status: 'cancelled' }).run();
      tx.update(canvasDocDeliveries).set({ status: 'cancelled', reason: 'document_closed' }).run();
      db.$client.prepare("DELETE FROM canvas_documents WHERE id='doc-a'").run();
    });
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM canvas_documents').get()).toEqual({
      count: 0,
    });
    expect(db.select().from(canvasDocChannels).get()).toMatchObject({
      closedAt: now,
      closureEvidence: { reason: 'removed', actor: 'owner' },
    });
    expect(db.select().from(canvasDocEvents).all()).toHaveLength(1);
    expect(db.select().from(canvasDocGrants).get()?.revokedAt).toBe(now);
    expect(db.select().from(canvasDocBatches).get()?.status).toBe('cancelled');
    expect(db.select().from(canvasDocDeliveries).get()).toMatchObject({
      status: 'cancelled',
      reason: 'document_closed',
    });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});
