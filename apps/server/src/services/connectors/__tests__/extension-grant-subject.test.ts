/**
 * An extension's grant never answers for an agent (DOR-3547). The agent
 * lookup, named-agent and every-agent alike, matches on `subject_type`, so an
 * `extension` row is invisible to it whatever its ids say; the every-agent
 * row beside it is the control that proves the lookup finds rows at all.
 */
import { describe, expect, it } from 'vitest';
import { and, connectionOperationGrants, createDb, eq, isNull, runMigrations } from '@dorkos/db';
import { agentGrantScope } from '../execution/agent-grant-scope.js';

const NOW = '2026-11-08T00:00:00.000Z';

/** A migrated database with one account, one read revision and three grants. */
function seeded() {
  const db = createDb(':memory:');
  runMigrations(db);
  const sqlite = db.$client;
  sqlite
    .prepare(
      `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, execution_config_generation,
          owner_kind, owner_id, status, created_at, updated_at)
       VALUES ('provider-1', 'test', 'byo', 'Test', 'self-host', '{}', 1, 'local_install',
         'install-1', 'available', ?, ?)`
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, status, created_at, updated_at)
       VALUES ('linear', 'provider-1', 'ref', 'linear', 'work', 'active', ?, ?)`
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO connector_operation_revisions
         (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
          capability_classification, input_schema_json, discovered_at)
       VALUES ('rev-read', 'provider-1', 'linear', 'LINEAR_LIST_LINEAR_PROJECTS', '1', 'h', 'read', '{}', ?)`
    )
    .run(NOW);
  const grant = sqlite.prepare(
    `INSERT INTO connection_operation_grants
       (id, subject_type, subject_id, agent_id, extension_id, connection_id,
        operation_revision_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'linear', 'rev-read', 'owner', ?)`
  );
  return { db, grant };
}

/** The grant ids the agent lookup finds for one agent. */
function visibleTo(db: ReturnType<typeof createDb>, agentId: string): string[] {
  const scope = agentGrantScope(db, { agentId, sessionId: undefined, connectionId: 'linear' });
  if (scope.kind !== 'scope') throw new Error(`unexpected denial: ${scope.reason}`);
  return db
    .select({ id: connectionOperationGrants.id })
    .from(connectionOperationGrants)
    .where(
      and(
        eq(connectionOperationGrants.connectionId, 'linear'),
        isNull(connectionOperationGrants.revokedAt),
        scope.subject
      )
    )
    .all()
    .map((row) => row.id)
    .sort();
}

describe('the extension grant subject and the agent lookup', () => {
  it('never lets an extension grant answer for an agent, even one named like it', () => {
    const { db, grant } = seeded();
    grant.run('ext', 'extension', 'flow-owner', null, 'flow-owner', NOW);
    // An agent whose id happens to equal the extension's id.
    expect(visibleTo(db, 'flow-owner')).toEqual([]);
    expect(visibleTo(db, 'agent-1')).toEqual([]);
  });

  it('still finds the every-agent and named-agent rows beside it', () => {
    const { db, grant } = seeded();
    grant.run('ext', 'extension', 'flow-owner', null, 'flow-owner', NOW);
    grant.run('every', 'every_agent', 'every_agent', null, null, NOW);
    grant.run('mine', 'agent', 'agent-1', 'agent-1', null, NOW);
    expect(visibleTo(db, 'agent-1')).toEqual(['every', 'mine']);
    expect(visibleTo(db, 'flow-owner')).toEqual(['every']);
  });
});
