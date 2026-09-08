import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDb,
  runMigrations,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
} from '../index.js';

const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const migrationTag = '0091_oval_talon';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function indexColumns(db: ReturnType<typeof createDb>, indexName: string): string[] {
  return db.$client
    .prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
    .all(indexName)
    .map((column) => (column as { name: string }).name);
}

function receiptValues(id: string, queueMessageId: string) {
  return {
    id,
    sourceKind: 'connector_agent_request' as const,
    sourceId: 'request-1',
    sourceGeneration: 'generation-1',
    queueMessageId,
    sessionId: 'session-1',
    agentId: 'agent-1',
    originRuntime: 'claude-code',
    originAgentPath: '/agents/researcher',
    originAuthorityDigest: 'sha256:authority',
    state: 'accepted' as const,
    acceptedAt: '2026-09-07T12:00:00.000Z',
  };
}

describe('private session acceptance schema', () => {
  it('keeps an immutable source receipt after its queue row is deleted', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    db.insert(sessionMessageQueue)
      .values({
        id: 'message-1',
        sessionId: 'session-1',
        position: 1_000,
        content: '[Private connection update]',
        disposition: 'queue',
        clientId: 'system:connector-agent-request',
        enqueuedAt: 1,
      })
      .run();
    db.insert(sessionMessageAcceptanceReceipts)
      .values(receiptValues('receipt-1', 'message-1'))
      .run();

    db.delete(sessionMessageQueue).run();

    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toMatchObject([
      {
        id: 'receipt-1',
        queueMessageId: 'message-1',
        sourceId: 'request-1',
        sourceGeneration: 'generation-1',
      },
    ]);
    expect(() =>
      db
        .insert(sessionMessageAcceptanceReceipts)
        .values(receiptValues('receipt-2', 'message-2'))
        .run()
    ).toThrow();
    expect(indexColumns(db, 'session_message_acceptance_session_idx')).toEqual([
      'session_id',
      'state',
      'accepted_at',
    ]);
    db.$client.close();
  });

  it('upgrades a populated P3 request without changing its review or resume identity', () => {
    const folder = mkdtempSync(join(tmpdir(), 'p6-acceptance-upgrade-'));
    tempDirs.push(folder);
    mkdirSync(join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const target = journal.entries.find((entry) => entry.tag === migrationTag);
    expect(target).toBeDefined();
    const entries = journal.entries.filter((entry) => entry.idx < target!.idx);
    for (const entry of entries)
      copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: folder });
      sqlite
        .prepare(
          `INSERT INTO connector_review_requests
            (id, action_kind, action_version, requester_kind, requester_id, agent_id, session_id,
             authority_binding_digest, target_kind, target_id, action_payload_json, state, expires_at,
             idempotency_key, created_at)
           VALUES ('review-1', 'agent_connection_request', 1, 'agent', 'agent-1', 'agent-1',
             'session-1', 'sha256:authority', 'service', 'gmail', '{}', 'pending',
             '2026-09-08T00:00:00.000Z', 'request-1', '2026-09-07T00:00:00.000Z')`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO connector_agent_requests
            (id, review_request_id, agent_id, session_id, service_slug, requested_operations_json,
             requested_events_json, reason, resume_state, resume_token, created_at)
           VALUES ('request-1', 'review-1', 'agent-1', 'session-1', 'gmail', '["read"]', '[]',
             'Read new mail', 'pending', 'opaque-resume-token', '2026-09-07T00:00:00.000Z')`
        )
        .run();

      migrate(db, { migrationsFolder: migrationDir });

      expect(
        sqlite
          .prepare(
            'SELECT id, review_request_id, resume_state, resume_token, source_generation FROM connector_agent_requests'
          )
          .get()
      ).toEqual({
        id: 'request-1',
        review_request_id: 'review-1',
        resume_state: 'pending',
        resume_token: 'opaque-resume-token',
        source_generation: null,
      });
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
