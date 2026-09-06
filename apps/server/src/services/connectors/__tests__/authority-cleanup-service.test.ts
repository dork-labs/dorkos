import { describe, expect, it } from 'vitest';
import {
  approvals,
  connections,
  connectorProviderInstances,
  connectorReconciliationAgents,
  connectorReconciliationPreviews,
  connectorReviewRequests,
  connectorRuntimeBindings,
  createDb,
  eq,
  runMigrations,
} from '@dorkos/db';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorAuthorityCleanupService } from '../authority-cleanup-service.js';

const NOW = '2026-09-06T12:00:00.000Z';
const CLEANED = '2026-09-06T12:01:00.000Z';

describe('ConnectorAuthorityCleanupService', () => {
  it('revokes only the exact removed agent/connection authority', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    db.insert(connectorProviderInstances)
      .values({
        id: 'provider-a',
        type: 'fake',
        mode: 'byo',
        displayName: 'Fake',
        custody: 'managed',
        capabilityJson: '{}',
        status: 'available',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    for (const connectionId of ['connection-a', 'connection-b']) {
      db.insert(connections)
        .values({
          id: connectionId,
          providerInstanceId: 'provider-a',
          externalAccountRef: `private-${connectionId}`,
          toolkit: 'gmail',
          label: connectionId,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }

    const scopes = [
      { suffix: 'target', agentId: 'agent-a', connectionId: 'connection-a' },
      { suffix: 'other-connection', agentId: 'agent-a', connectionId: 'connection-b' },
      { suffix: 'other-agent', agentId: 'agent-b', connectionId: 'connection-a' },
    ];
    for (const scope of scopes) {
      db.insert(approvals)
        .values({
          id: `approval-${scope.suffix}`,
          tokenHash: `token-${scope.suffix}`,
          capabilityId: 'connectors.execute',
          capabilityTitle: 'Run connector operation',
          tier: 'destructive',
          inputHash: `input-${scope.suffix}`,
          authorityBindingDigest: `authority-${scope.suffix}`,
          connectorOwnerKind: 'local_install',
          connectorOwnerId: 'install-a',
          connectorAgentId: scope.agentId,
          connectorSessionId: `session-${scope.suffix}`,
          connectorConnectionId: scope.connectionId,
          connectorOperationRevisionId: 'revision-a',
          summary: 'Run one connector operation.',
          state: 'pending',
          createdAt: NOW,
          expiresAt: '2026-09-06T14:00:00.000Z',
        })
        .run();
      db.insert(connectorReviewRequests)
        .values({
          id: `review-${scope.suffix}`,
          actionKind: 'pause',
          actionVersion: 1,
          requesterKind: 'program',
          requesterId: `program-${scope.suffix}`,
          ownerKind: 'local_install',
          ownerId: 'install-a',
          agentId: scope.agentId,
          sessionId: `session-${scope.suffix}`,
          connectionId: scope.connectionId,
          providerInstanceId: 'provider-a',
          executionConfigGeneration: 1,
          authorityBindingDigest: `authority-${scope.suffix}`,
          actionHash: `action-${scope.suffix}`,
          targetKind: 'connection',
          targetId: scope.connectionId,
          actionPayloadJson: '{}',
          state: 'pending',
          expiresAt: '2026-09-06T14:00:00.000Z',
          idempotencyKey: `idempotency-${scope.suffix}`,
          createdAt: NOW,
        })
        .run();
      db.insert(connectorReconciliationPreviews)
        .values({
          id: `preview-${scope.suffix}`,
          ownerKind: 'local_install',
          ownerId: 'install-a',
          connectionId: scope.connectionId,
          providerInstanceId: 'provider-a',
          bootEpoch: 'boot-a',
          executionConfigGeneration: 1,
          completeRevisionSetHash: `revisions-${scope.suffix}`,
          createdAt: NOW,
          expiresAt: '2026-09-06T12:10:00.000Z',
        })
        .run();
      db.insert(connectorReconciliationAgents)
        .values({ previewId: `preview-${scope.suffix}`, agentId: scope.agentId })
        .run();
      db.insert(connectorRuntimeBindings)
        .values({
          id: `binding-${scope.suffix}`,
          tokenHash: `binding-token-${scope.suffix}`,
          bootEpoch: 'boot-a',
          ownerKind: 'local_install',
          ownerId: 'install-a',
          runtime: 'opencode',
          canonicalSessionId: `session-${scope.suffix}`,
          agentId: scope.agentId,
          agentPath: `/agents/${scope.agentId}`,
          canonicalCwd: '/project',
          createdAt: NOW,
          expiresAt: '2026-09-06T14:00:00.000Z',
        })
        .run();
    }
    db.insert(connectorReviewRequests)
      .values({
        id: 'review-unknown-outcome',
        actionKind: 'pause',
        actionVersion: 1,
        requesterKind: 'program',
        requesterId: 'program-unknown',
        ownerKind: 'local_install',
        ownerId: 'install-a',
        connectionId: 'connection-a',
        providerInstanceId: 'provider-a',
        executionConfigGeneration: 1,
        targetKind: 'connection',
        targetId: 'connection-a',
        actionPayloadJson: '{}',
        state: 'approved',
        expiresAt: '2026-09-06T14:00:00.000Z',
        idempotencyKey: 'idempotency-unknown',
        createdAt: NOW,
        resolvedAt: NOW,
        resolutionSummary: 'applying:old-boot',
      })
      .run();

    const cleanup = new ConnectorAuthorityCleanupService({
      db,
      now: () => new Date(CLEANED),
    });
    cleanup.revokeAgentConnection({
      agentId: 'agent-a',
      connectionId: ConnectionIdSchema.parse('connection-a'),
      reason: 'agent_connection_removed',
    });

    expect(
      db.select().from(approvals).where(eq(approvals.id, 'approval-target')).get()
    ).toMatchObject({ state: 'denied', decidedAt: CLEANED, consumedAt: CLEANED });
    expect(
      db.select().from(approvals).where(eq(approvals.id, 'approval-other-connection')).get()
    ).toMatchObject({ state: 'pending', consumedAt: null });
    expect(
      db.select().from(approvals).where(eq(approvals.id, 'approval-other-agent')).get()
    ).toMatchObject({ state: 'pending', consumedAt: null });

    expect(
      db
        .select()
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, 'review-target'))
        .get()
    ).toMatchObject({
      state: 'expired',
      resolvedAt: CLEANED,
      authorityRevokedAt: CLEANED,
      authorityRevokeReason: 'agent_connection_removed',
    });
    expect(
      db
        .select()
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, 'review-other-connection'))
        .get()?.authorityRevokedAt
    ).toBeNull();

    expect(
      db
        .select()
        .from(connectorReconciliationPreviews)
        .all()
        .map((row) => row.id)
        .sort()
    ).toEqual(['preview-other-agent', 'preview-other-connection']);
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-target'))
        .get()?.revokedAt
    ).toBeNull();
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-other-connection'))
        .get()?.revokedAt
    ).toBeNull();

    cleanup.revokeConnection({
      connectionId: ConnectionIdSchema.parse('connection-a'),
      reason: 'connection_removed',
    });
    expect(
      db
        .select()
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, 'review-unknown-outcome'))
        .get()
    ).toMatchObject({
      state: 'approved',
      resolutionSummary: 'applying:old-boot',
      resolutionJson: null,
      authorityRevokedAt: CLEANED,
    });
    expect(
      db.select().from(approvals).where(eq(approvals.id, 'approval-other-agent')).get()
    ).toMatchObject({ state: 'denied', consumedAt: CLEANED });
    expect(
      db
        .select()
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, 'review-other-agent'))
        .get()
    ).toMatchObject({
      state: 'expired',
      authorityRevokedAt: CLEANED,
      authorityRevokeReason: 'connection_removed',
    });
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-other-agent'))
        .get()?.revokedAt
    ).toBeNull();

    cleanup.revokeAgent({ agentId: 'agent-a', reason: 'agent_removed' });
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-target'))
        .get()
    ).toMatchObject({ revokedAt: CLEANED, revokeReason: 'agent_removed' });
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-other-connection'))
        .get()
    ).toMatchObject({ revokedAt: CLEANED, revokeReason: 'agent_removed' });
    expect(
      db
        .select()
        .from(connectorRuntimeBindings)
        .where(eq(connectorRuntimeBindings.id, 'binding-other-agent'))
        .get()?.revokedAt
    ).toBeNull();
  });
});
