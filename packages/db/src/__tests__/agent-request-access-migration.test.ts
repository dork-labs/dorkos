import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const migrationDir = new URL('../../drizzle/', import.meta.url).pathname;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder that stops just before the named migration. */
function foldersBefore(tag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'agent-request-access-'));
  tempDirs.push(folder);
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const target = journal.entries.find((entry) => entry.tag === tag);
  expect(target).toBeDefined();
  const entries = journal.entries.filter((entry) => entry.idx < target!.idx);
  for (const entry of entries) {
    copyFileSync(join(migrationDir, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

describe('agents ask by level (0127, 0128)', () => {
  it('reads each open request’s named actions by class, then drops the names', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: foldersBefore('0127_agent_request_access') });
      const now = '2026-09-28T00:00:00.000Z';
      sqlite
        .prepare(
          `INSERT INTO connector_provider_instances
             (id, type, mode, display_name, custody, capability_json, execution_config_generation,
              status, created_at, updated_at)
           VALUES ('provider-1', 'test', 'byo', 'Test', 'self-host', '{}', 1, 'available', ?, ?)`
        )
        .run(now, now);
      const revision = sqlite.prepare(
        `INSERT INTO connector_operation_revisions
           (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
            capability_classification, input_schema_json, discovered_at)
         VALUES (?, 'provider-1', 'gmail', ?, '1', ?, ?, '{}', ?)`
      );
      revision.run('revision-read', 'GMAIL_FETCH_EMAILS', 'hash-read', 'read', now);
      revision.run('revision-send', 'GMAIL_SEND_EMAIL', 'hash-send', 'write', now);
      revision.run('revision-delete', 'GMAIL_DELETE_MESSAGE', 'hash-delete', 'destructive', now);
      const review = sqlite.prepare(
        `INSERT INTO connector_review_requests
           (id, action_kind, action_version, requester_kind, requester_id, target_kind, target_id,
            action_payload_json, state, expires_at, idempotency_key, created_at)
         VALUES (?, 'agent_connection_request', 1, 'agent', 'agent-1', 'service', 'gmail', ?,
           'pending', ?, ?, ?)`
      );
      const request = sqlite.prepare(
        `INSERT INTO connector_agent_requests
           (id, review_request_id, agent_id, session_id, service_slug, requested_operations_json,
            requested_events_json, reason, resume_state, resume_token, created_at)
         VALUES (?, ?, 'agent-1', 'session-1', 'gmail', ?, '[]', 'Mail', 'pending', ?, ?)`
      );
      for (const [id, operations] of [
        ['asks-read', '["GMAIL_FETCH_EMAILS"]'],
        ['asks-send', '["GMAIL_FETCH_EMAILS","GMAIL_SEND_EMAIL"]'],
        ['asks-unknown', '["gmail.invented"]'],
        ['asks-delete', '["GMAIL_DELETE_MESSAGE"]'],
      ] as const) {
        const legacyAction = JSON.stringify({
          kind: 'agent_connection_request',
          reason: 'Mail',
          requestedEvents: [],
          requestedOperations: JSON.parse(operations),
          serviceSlug: 'gmail',
          version: 1,
        });
        review.run(`review-${id}`, legacyAction, now, `key-${id}`, now);
        request.run(id, `review-${id}`, operations, `token-${id}`, now);
      }

      migrate(db, { migrationsFolder: migrationDir });

      expect(
        sqlite
          .prepare('SELECT id, requested_access FROM connector_agent_requests ORDER BY id')
          .all()
      ).toEqual([
        // A delete is in no level (ADR 260928-121730); the widest level is the
        // nearest one to ask the person for, and they still decide.
        { id: 'asks-delete', requested_access: 'read-write' },
        { id: 'asks-read', requested_access: 'read' },
        { id: 'asks-send', requested_access: 'read-write' },
        // A guessed name matches no action; Read is the level that asks least.
        { id: 'asks-unknown', requested_access: 'read' },
      ]);
      const columns = sqlite
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all('connector_agent_requests')
        .map((column) => (column as { name: string }).name);
      expect(columns).not.toContain('requested_operations_json');

      // The stored action and context carry the level too, and name no action.
      const reviews = sqlite
        .prepare(
          'SELECT id, action_payload_json, review_context_json FROM connector_review_requests ORDER BY id'
        )
        .all() as Array<{ id: string; action_payload_json: string; review_context_json: string }>;
      expect(reviews).toHaveLength(4);
      for (const row of reviews)
        expect(row.action_payload_json).not.toContain('requestedOperations');
      const send = reviews.find((row) => row.id === 'review-asks-send')!;
      // Canonical form: keys in sorted order, as the service writes them.
      expect(send.action_payload_json).toBe(
        '{"access":"read-write","kind":"agent_connection_request","reason":"Mail","requestedEvents":[],"serviceSlug":"gmail","version":1}'
      );
      expect(JSON.parse(send.review_context_json)).toEqual({
        access: 'read-write',
        reason: 'Mail',
        requestedEvents: [],
        serviceSlug: 'gmail',
      });
    } finally {
      sqlite.close();
    }
  });
});
