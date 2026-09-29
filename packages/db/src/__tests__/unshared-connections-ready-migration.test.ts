import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentConnectionAttachments,
  sessionConnectionOverrides,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  runMigrations,
} from '../index.js';

const NOW = '2026-09-27T00:00:00.000Z';
const MIGRATION = new URL('../../drizzle/0116_unshared_connections_ready.sql', import.meta.url);

/** A pre-upgrade database: every connection still marked for a review. */
function seed() {
  const db = createDb(':memory:');
  runMigrations(db);
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-1',
      type: 'test',
      mode: 'byo',
      displayName: 'Test provider',
      custody: 'self-host',
      capabilityJson: '{}',
      executionConfigGeneration: 1,
      status: 'available',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(connectorOperationRevisions)
    .values({
      id: 'revision-read',
      providerInstanceId: 'provider-1',
      toolkit: 'gmail',
      operationSlug: 'gmail.read',
      toolkitVersion: '1',
      schemaHash: 'hash-read',
      capabilityClassification: 'read',
      inputSchemaJson: '{}',
      discoveredAt: NOW,
    })
    .run();
  for (const id of [
    'never-shared',
    'shared',
    'revoked-only',
    'every-agent',
    'legacy',
    'session-link',
    'detached-link',
    'ready',
  ]) {
    db.insert(connections)
      .values({
        id,
        providerInstanceId: 'provider-1',
        externalAccountRef: `ref-${id}`,
        toolkit: 'gmail',
        label: id,
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: id === 'ready' ? 'ready' : 'migration_needs_reconcile',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  }
  const grant = (
    id: string,
    connectionId: string,
    subject: 'agent' | 'every_agent',
    revokedAt: string | null = null
  ) =>
    db
      .insert(connectionOperationGrants)
      .values({
        id,
        subjectType: subject,
        subjectId: subject === 'agent' ? 'agent-a' : 'every_agent',
        agentId: subject === 'agent' ? 'agent-a' : null,
        connectionId,
        operationRevisionId: 'revision-read',
        createdBy: 'test',
        createdAt: NOW,
        revokedAt,
      })
      .run();
  grant('g-shared', 'shared', 'agent');
  grant('g-revoked', 'revoked-only', 'agent', NOW);
  grant('g-every', 'every-agent', 'every_agent');
  db.insert(agentConnectionAttachments)
    .values({ agentId: 'agent-a', connectionId: 'legacy', attachedAt: NOW })
    .run();
  for (const [connectionId, state] of [
    ['session-link', 'attached'],
    ['detached-link', 'detached'],
  ] as const) {
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: `s-${connectionId}`,
        agentId: 'agent-a',
        connectionId,
        state,
        updatedAt: NOW,
      })
      .run();
  }
  return db;
}

describe('0116 unshared connections become ready', () => {
  it('settles only connections nobody holds access to, and keeps legacy attachments for review', () => {
    const db = seed();
    const sqlite = db.$client;
    try {
      sqlite.exec(readFileSync(MIGRATION, 'utf8'));
      const statuses = Object.fromEntries(
        (
          sqlite
            .prepare('SELECT id, grant_reconciliation_status AS status FROM connections')
            .all() as Array<{ id: string; status: string }>
        ).map((row) => [row.id, row.status])
      );
      expect(statuses).toEqual({
        // Nothing granted, nothing to reconcile.
        'never-shared': 'ready',
        // A revoked grant is no access at all.
        'revoked-only': 'ready',
        // Live access of any kind still needs the owner's review.
        shared: 'migration_needs_reconcile',
        'every-agent': 'migration_needs_reconcile',
        // The legacy migration marks attachments for the owner to re-confirm.
        legacy: 'migration_needs_reconcile',
        // An attached legacy per-session link asks the owner to re-confirm too;
        // a detached one grants nothing.
        'session-link': 'migration_needs_reconcile',
        'detached-link': 'ready',
        ready: 'ready',
      });

      // Running it again changes nothing.
      sqlite.exec(readFileSync(MIGRATION, 'utf8'));
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM connections WHERE grant_reconciliation_status = 'ready'"
          )
          .get()
      ).toEqual({ count: 4 });
    } finally {
      sqlite.close();
    }
  });
});
