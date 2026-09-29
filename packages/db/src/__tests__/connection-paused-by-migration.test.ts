/**
 * Upgrade to 0126: every paused account learns who paused it, an account a
 * finished "Sign in again" left paused is given back, and refused hosted
 * commands learn why they were refused.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../index.js';

const NOW = '2026-09-28T12:00:00.000Z';

describe('0126 connection paused_by migration', () => {
  let directory: string;
  let db: ReturnType<typeof createDb>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'paused-by-upgrade-'));
    const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    mkdirSync(join(directory, 'meta'));
    const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 125);
    for (const entry of journal.entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
    writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
    db = createDb(':memory:');
    migrate(db, { migrationsFolder: directory });
    db.$client
      .prepare(
        `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, status, execution_config_digest,
          created_at, updated_at)
         VALUES ('instance', 'composio', 'byo', 'composio', 'managed', '{}', 'available',
          'key-digest-a', ?, ?)`
      )
      .run(NOW, NOW);
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function account(id: string, enabled: 0 | 1, lifecycle = 'connected', updatedAt = NOW) {
    db.$client
      .prepare(
        `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, status,
          lifecycle_state, enabled, created_at, updated_at)
         VALUES (?, 'instance', ?, 'gmail', ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, `ref-${id}`, id, lifecycle, enabled, NOW, updatedAt);
  }

  function reconnect(connectionId: string, state: string, wasPaused: 0 | 1, createdAt = NOW) {
    db.$client
      .prepare(
        `INSERT INTO connector_authentication_flows
         (id, owner_kind, owner_id, idempotency_key, request_hash, provider_instance_id,
          execution_config_generation, toolkit, reconnect_connection_id, reconnect_was_paused,
          state, created_at, expires_at, updated_at)
         VALUES (?, 'local_install', 'owner', ?, 'hash', 'instance', 1, 'gmail', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `flow-${connectionId}-${state}-${createdAt}`,
        `key-${connectionId}-${state}-${createdAt}`,
        connectionId,
        wasPaused,
        state,
        createdAt,
        createdAt,
        createdAt
      );
  }

  function row(id: string) {
    return db.$client
      .prepare('SELECT enabled, paused_by AS pausedBy FROM connections WHERE id = ?')
      .get(id);
  }

  it('gives back an account an ended sign-in left paused, and keeps every other pause', () => {
    account('abandoned', 0);
    reconnect('abandoned', 'expired', 0);
    account('failed', 0);
    reconnect('failed', 'failed', 0);
    account('owner-before-sign-in', 0);
    reconnect('owner-before-sign-in', 'failed', 1);
    account('running', 0);
    reconnect('running', 'pending', 0);
    account('owner', 0);
    account('superseded', 0);
    reconnect('superseded', 'expired', 0, '2026-09-28T10:00:00.000Z');
    reconnect('superseded', 'connected', 1, '2026-09-28T11:00:00.000Z');
    // The sign-in failed, then the owner resumed and later paused it again:
    // the pause is theirs, whatever the old flow says.
    account('owner-paused-after', 0, 'connected', '2026-09-28T13:00:00.000Z');
    reconnect('owner-paused-after', 'failed', 0);
    // Paused by the owner while a sign-in was still running.
    account('owner-paused-during', 0, 'connected', '2026-09-28T13:00:00.000Z');
    reconnect('owner-paused-during', 'pending', 0);
    account('working', 1);
    account('closed', 0, 'disconnected');

    runMigrations(db);

    expect(row('abandoned')).toEqual({ enabled: 1, pausedBy: null });
    expect(row('failed')).toEqual({ enabled: 1, pausedBy: null });
    expect(row('owner-before-sign-in')).toEqual({ enabled: 0, pausedBy: 'owner' });
    expect(row('running')).toEqual({ enabled: 0, pausedBy: 'sign_in' });
    expect(row('owner')).toEqual({ enabled: 0, pausedBy: 'owner' });
    expect(row('superseded')).toEqual({ enabled: 0, pausedBy: 'owner' });
    expect(row('owner-paused-after')).toEqual({ enabled: 0, pausedBy: 'owner' });
    expect(row('owner-paused-during')).toEqual({ enabled: 0, pausedBy: 'owner' });
    expect(row('working')).toEqual({ enabled: 1, pausedBy: null });
    expect(row('closed')).toEqual({ enabled: 0, pausedBy: null });
    const columns = db.$client
      .prepare("SELECT name FROM pragma_table_info('connector_authentication_flows')")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).not.toContain('reconnect_was_paused');
  });

  it('re-arms only own-key cleanups that never failed, and leaves the rest for the person', () => {
    db.$client
      .prepare(
        `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, status, created_at, updated_at)
         VALUES ('managed', 'dorkos-managed', 'managed', 'managed', 'managed', '{}', 'available', ?, ?)`
      )
      .run(NOW, NOW);
    const insert = db.$client.prepare(
      `INSERT INTO connections
       (id, provider_instance_id, external_account_ref, toolkit, label, status,
        lifecycle_state, enabled, external_cleanup_state, created_at, updated_at)
       VALUES (?, ?, ?, 'gmail', 'x', 'active', 'disconnected', 0, 'failed', ?, ?)`
    );
    insert.run('own-key', 'instance', 'ref-own', NOW, NOW);
    insert.run('dorkos-account', 'managed', 'ref-managed', NOW, NOW);
    db.$client
      .prepare(
        `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, status,
          lifecycle_state, enabled, external_cleanup_state, created_at, updated_at)
         VALUES ('own-key-unknown', 'instance', 'ref-unknown', 'gmail', 'x', 'active',
          'disconnected', 0, 'unknown', ?, ?)`
      )
      .run(NOW, NOW);
    db.$client
      .prepare(
        `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, status,
          lifecycle_state, enabled, external_cleanup_state, created_at, updated_at)
         VALUES ('own-key-pending', 'instance', 'ref-pending', 'gmail', 'x', 'active',
          'disconnected', 0, 'pending', ?, ?)`
      )
      .run(NOW, NOW);

    db.$client
      .prepare(
        `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, status, created_at, updated_at)
         VALUES ('raw', 'mcp', 'byo', 'mcp', 'external', '{}', 'available', ?, ?)`
      )
      .run(NOW, NOW);
    insert.run('raw-failed', 'raw', 'ref-raw', NOW, NOW);

    runMigrations(db);

    const state = (id: string) =>
      db.$client
        .prepare(
          'SELECT external_cleanup_state AS state, external_cleanup_key AS key FROM connections WHERE id = ?'
        )
        .get(id);
    // Raw MCP keeps no sign-in: its disconnect was local and is done.
    expect(state('raw-failed')).toEqual({ state: 'not_required', key: null });
    // Never failed: tried again through the key the instance last worked with.
    expect(state('own-key-pending')).toEqual({ state: 'pending', key: 'key-digest-a' });
    // A try already failed, or none was recorded: the key may have changed, so
    // a retry could read "not found" as done. The person removes it instead.
    expect(state('own-key')).toEqual({ state: 'unknown', key: null });
    expect(state('own-key-unknown')).toEqual({ state: 'unknown', key: null });
    // The hosted side said its own cleanup failed; that stays its word.
    expect(state('dorkos-account')).toEqual({ state: 'failed', key: null });
  });

  it('names why each refused hosted command was refused', () => {
    account('managed', 1);
    const insert = db.$client.prepare(
      `INSERT INTO connector_managed_authority_outbox
       (command_id, connection_id, provider_instance_id, execution_config_generation, owner_kind,
        owner_id, managed_connection_id, scope_kind, subject_id, scope_version, request_hash,
        request_json, state, safe_reason, created_at, updated_at)
       VALUES (?, 'managed', 'instance', 1, 'local_install', 'owner', 'ref', 'agent_grants', ?, 1,
        'hash', '{}', ?, ?, ?, ?)`
    );
    insert.run('unlinked', 'a', 'rejected', 'This instance is no longer linked.', NOW, NOW);
    insert.run('gone', 'b', 'rejected', 'The managed connection is no longer available.', NOW, NOW);
    insert.run('waiting', 'c', 'pending', 'This instance is no longer linked.', NOW, NOW);

    runMigrations(db);

    const codes = Object.fromEntries(
      db.$client
        .prepare(
          'SELECT command_id AS id, rejection_code AS code FROM connector_managed_authority_outbox'
        )
        .all()
        .map((entry) => [(entry as { id: string }).id, (entry as { code: string | null }).code])
    );
    expect(codes).toEqual({
      unlinked: 'unauthorized',
      gone: 'connection_unavailable',
      waiting: null,
    });
  });
});
