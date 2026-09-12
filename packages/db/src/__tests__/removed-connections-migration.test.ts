import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDb } from '../index.js';

describe('removed connections migration', () => {
  it('retains old rows, marks disconnected cleanup unknown, and scopes uniqueness to visible rows', () => {
    const db = createDb(':memory:');
    const sqlite = db.$client;
    try {
      sqlite.exec(`CREATE TABLE connections (id TEXT PRIMARY KEY, provider_instance_id TEXT NOT NULL, external_account_ref TEXT NOT NULL, lifecycle_state TEXT NOT NULL);
        CREATE UNIQUE INDEX connections_instance_external_ref_unique ON connections(provider_instance_id, external_account_ref);
        CREATE TABLE connector_authentication_flows (id TEXT PRIMARY KEY);
        CREATE TABLE connector_managed_authority_outbox (id TEXT PRIMARY KEY);
        INSERT INTO connector_authentication_flows VALUES ('legacy-flow');
        INSERT INTO connections VALUES ('old','provider','account','disconnected'), ('active','provider','other','connected');`);
      sqlite.exec(
        readFileSync(new URL('../../drizzle/0098_removed_connections.sql', import.meta.url), 'utf8')
      );
      expect(
        sqlite
          .prepare(
            'SELECT id, external_cleanup_state, removed_at, cleanup_generation FROM connections ORDER BY id'
          )
          .all()
      ).toEqual([
        {
          id: 'active',
          external_cleanup_state: 'not_required',
          removed_at: null,
          cleanup_generation: 0,
        },
        { id: 'old', external_cleanup_state: 'unknown', removed_at: null, cleanup_generation: 0 },
      ]);
      expect(
        sqlite.prepare('SELECT cleanup_snapshot_json FROM connector_authentication_flows').get()
      ).toEqual({ cleanup_snapshot_json: null });
      expect(() =>
        sqlite.exec(
          "INSERT INTO connections(id,provider_instance_id,external_account_ref,lifecycle_state) VALUES ('new','provider','account','connected')"
        )
      ).toThrow();
      sqlite.exec("UPDATE connections SET removed_at='2026-09-11' WHERE id='old'");
      sqlite.exec(
        "INSERT INTO connections(id,provider_instance_id,external_account_ref,lifecycle_state) VALUES ('new','provider','account','connected')"
      );
      expect(sqlite.prepare('SELECT count(*) AS count FROM connections').get()).toEqual({
        count: 3,
      });
    } finally {
      sqlite.close();
    }
  });
});
