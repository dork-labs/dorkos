/** One agent's own hosted access on an account connected through a DorkOS account. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  createDb,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorRegistry } from '../../registry.js';
import { managedAgentAccess } from '../managed-agent-access.js';

const NOW = '2026-09-28T12:00:00.000Z';
const RETRY_AT = '2026-09-28T12:05:00.000Z';
const ACCOUNT = 'hosted-account-a';

describe('managedAgentAccess', () => {
  let db: Db;
  let version = 0;

  /** Record one command as its scope's latest. */
  function command(
    scope: 'agent_grants' | 'every_agent_grants',
    state: 'pending' | 'applied' | 'rejected',
    extra: { safeReason?: string; nextAttemptAt?: string } = {}
  ) {
    version += 1;
    const subjectId = scope === 'agent_grants' ? 'agent-a' : EVERY_AGENT_GRANT_SUBJECT_ID;
    const commandId = `command-${version}`;
    db.insert(connectorManagedAuthorityOutbox)
      .values({
        commandId,
        connectionId: 'connection-a',
        providerInstanceId: 'provider-a',
        executionConfigGeneration: 1,
        ownerKind: 'local_install',
        ownerId: 'install-a',
        managedConnectionId: ACCOUNT,
        scopeKind: scope,
        subjectId,
        scopeVersion: version,
        requestHash: commandId,
        requestJson: '{}',
        state,
        ...extra,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    db.insert(connectorManagedAuthorityScopes)
      .values({
        managedConnectionId: ACCOUNT,
        scopeKind: scope,
        subjectId,
        scopeVersion: version,
        lastCommandId: commandId,
        lastCommandHash: commandId,
        updatedAt: NOW,
      })
      .onConflictDoUpdate({
        target: [
          connectorManagedAuthorityScopes.managedConnectionId,
          connectorManagedAuthorityScopes.scopeKind,
          connectorManagedAuthorityScopes.subjectId,
        ],
        set: { scopeVersion: version, lastCommandId: commandId },
      })
      .run();
  }

  beforeEach(() => {
    version = 0;
    db = createDb(':memory:');
    runMigrations(db);
    new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: 'install-a' },
    }).register(
      new FakeConnectorProvider({
        type: 'dorkos-managed',
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
        custody: 'managed',
      }),
      'material-a',
      'managed'
    );
    db.insert(connections)
      .values({
        id: 'connection-a',
        providerInstanceId: 'provider-a',
        externalAccountRef: ACCOUNT,
        toolkit: 'gmail',
        label: 'Work',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
  });

  const both = { named: true, everyAgent: true };

  it('says still applying, with its reason and when it tries again', () => {
    command('agent_grants', 'pending', {
      safeReason: 'DorkOS’s servers had a problem.',
      nextAttemptAt: RETRY_AT,
    });
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', { named: true, everyAgent: false })).toEqual({
      sync: { status: 'pending', reason: 'DorkOS’s servers had a problem.', retryAt: RETRY_AT },
    });
  });

  it('never passes on a reason without its retry time, or the old generic reason', () => {
    command('agent_grants', 'pending', { safeReason: 'Waiting.' });
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', both).sync).toEqual({ status: 'pending' });
    command('agent_grants', 'pending', {
      safeReason: 'Managed connection synchronization is pending.',
      nextAttemptAt: RETRY_AT,
    });
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', both).sync).toEqual({ status: 'pending' });
  });

  it('lets a change still applying on one scope beat one refused on the other', () => {
    command('agent_grants', 'rejected', { safeReason: 'Refused.' });
    command('every_agent_grants', 'pending');
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', both).sync).toEqual({ status: 'pending' });
    // Only the refused scope gives it the account: refused.
    expect(
      managedAgentAccess(db, ACCOUNT, 'agent-a', { named: true, everyAgent: false }).sync
    ).toEqual({ status: 'failed', reason: 'Refused.' });
  });

  it('is usable through whichever granting scope has something applied', () => {
    command('agent_grants', 'rejected', { safeReason: 'Refused.' });
    command('every_agent_grants', 'applied');
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', both)).toEqual({
      applied: { subject: 'every_agent', scopeVersion: 2 },
      sync: { status: 'ready' },
    });
    // A scope that doesn't give it the account never counts.
    expect(
      managedAgentAccess(db, ACCOUNT, 'agent-a', { named: true, everyAgent: false }).applied
    ).toBeUndefined();
  });

  it('says still applying when nothing was sent yet', () => {
    expect(managedAgentAccess(db, ACCOUNT, 'agent-a', both)).toEqual({
      sync: { status: 'pending' },
    });
  });
});
