import { connectorManagedAuthorityScopes } from '@dorkos/db';
import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorProviderInstances,
  eq,
  connections,
} from '@dorkos/db';
import type { ManagedConnectorAuthorityCommandStatus } from '@dorkos/shared/connector-managed-schemas';
import {
  OWNER,
  PROVIDER_ID,
  CONNECTION_ID,
  MANAGED_CONNECTION_ID,
  statusFor,
  cloudError,
  useManagedAuthoritySyncHarness,
  useRefusedChangesHarness,
  lifecycleChange,
} from './managed-authority-sync-service.fixtures.js';
import { ConnectorLifecycleService } from '../../resources/lifecycle-service.js';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';

/** Refused hosted changes are never a dead end: grants, relinks, closing and disconnecting accounts. */
describe('ManagedAuthoritySyncService', () => {
  const h = useManagedAuthoritySyncHarness();

  describe('refused changes are never a dead end', () => {
    const r = useRefusedChangesHarness(h);

    // DOR-3265: a change waiting for the owner's approval is not applied yet,
    // so it stays pending and the last applied set stands.
    it('keeps a change awaiting the owner’s approval pending, never applied or refused', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => ({
        version: 1 as const,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state: 'awaiting_approval' as const,
        approvalId: '4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e',
        approveUrl: 'https://cloud.example.com/approvals/4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      await expect(h.replace()).resolves.toMatchObject({ applied: false });
      expect(h.db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
        state: 'pending',
        rejectionCode: null,
      });
    });

    it('tries a refused change again when the link kept its key (DOR-2620)', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      h.cloud.isLinked = () => true;
      await h.replace();
      expect(h.db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
        state: 'pending',
        rejectionCode: null,
        nextAttemptAt: expect.any(String),
        safeReason: 'DorkOS’s servers turned the request down.',
      });
    });

    it('sends a change the old link refused again once the account is linked again', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      await h.replace(sync);
      expect(r.grants()).toEqual([
        { operationRevisionId: 'revision-send', revokedAt: expect.any(String) },
      ]);

      // Linked again: the instance's setup moves on, and the hosted side answers.
      h.db
        .update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);

      expect(h.submitted.at(-1)).toMatchObject({
        kind: 'replace_agent_grants',
        agentId: 'agent-a',
        scopeVersion: 2,
        revisions: [expect.objectContaining({ operationSlug: 'gmail.send' })],
      });
      // The access the owner gave now works.
      expect(r.grants()).toEqual([{ operationRevisionId: 'revision-send', revokedAt: null }]);
      // Nothing is left to send again.
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('after a relink, sends what the agent holds now when its access changed since the refusal', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      await h.replace(sync);
      // Later, the agent is deleted: its access here ends without a hosted change.
      h.clock += 60_000;
      h.db
        .update(connectionOperationGrants)
        .set({ revokedAt: new Date(h.clock).toISOString() })
        .where(eq(connectionOperationGrants.agentId, 'agent-a'))
        .run();
      h.db
        .update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      });
      await sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal);
      // Never the old Send again: the deleted agent gets nothing back.
      expect(h.submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
      expect(r.grants().every((grant) => grant.revokedAt !== null)).toBe(true);
    });

    it('never sends a change refused for another reason just because of a relink', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'scope_conflict')
      );
      const sync = h.service();
      await h.replace(sync);
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('settles a refused change with exactly the access the owner was shown, never the refused one', async () => {
      // The owner gave agent-a Send; the hosted side refused. The review shows
      // agent-a with nothing (the refused grant never opened).
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return r.rejected(command, 'scope_conflict');
      });
      const sync = h.service();
      await h.replace(sync);
      const [commandId] = h.db.transaction((tx) =>
        sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
      );
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      });
      await sync.deliverAgentGrantReplacement(commandId!, new AbortController().signal);
      // Confirming "nothing" sends nothing: the refused Send is not granted.
      expect(h.submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
      expect(r.grants().every((grant) => grant.revokedAt !== null)).toBe(true);
    });

    it('closes an account whose connection the hosted side no longer has, with its end unconfirmed', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      const sync = h.service();
      await h.replace(sync);
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        enabled: false,
        closedBecause: 'service_gone',
        // Never "nothing owed": whether the sign-in lives on isn't known.
        externalCleanupState: 'unknown',
      });
      expect(r.grants().every((grant) => grant.revokedAt !== null)).toBe(true);
      // Never sent again, even when the owner confirms.
      expect(
        h.db.transaction((tx) =>
          sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
        )
      ).toEqual([]);
    });

    it('never closes an account because a resume was refused: it asks for a sign-in instead', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      await h.service().transition(lifecycleChange('active'));
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        enabled: false,
        closedBecause: null,
        status: 'expired',
      });
    });

    it('ends the Resume, Sign in again loop: a resume refused again after a sign-in closes it as gone', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      const resume = () => h.service().transition(lifecycleChange('active'));
      await resume();
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
      });
      // The person signs in again; the account reads signed in once more.
      h.db
        .update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.clock += 60_000;
      await resume();
      // Signing in can't fix it: gone, with "connect it again" and its end unconfirmed.
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        closedBecause: 'service_gone',
        externalCleanupState: 'unknown',
      });
    });

    it('never closes a healthy account on its first refusal after an earlier resume applied', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      let refuse = true;
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        refuse ? r.rejected(command, 'connection_unavailable') : statusFor(command)
      );
      const lifecycle = (to: 'active' | 'paused') =>
        h.service().transition({
          connectionId: CONNECTION_ID,
          managedConnectionId: MANAGED_CONNECTION_ID,
          lifecycle: to,
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          owner: OWNER,
          signal: new AbortController().signal,
        });
      // Refused once; the person signs in again; the next resume applies.
      await lifecycle('active');
      h.db
        .update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      refuse = false;
      h.clock += 60_000;
      await lifecycle('active');
      expect(h.db.select().from(connections).get()).toMatchObject({ enabled: true });
      // Weeks later: paused, then one refused resume. Signing in may fix it.
      h.clock += 21 * 24 * 60 * 60_000;
      await lifecycle('paused');
      refuse = true;
      await lifecycle('active');
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
        closedBecause: null,
      });
    });

    it('finishes a disconnect the ended link refused even after the account was removed', async () => {
      // The live incident: the link ended, Disconnect was refused, the person
      // removed the app, then linked the same DorkOS account again.
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      const lifecycle = new ConnectorLifecycleService({
        db: h.db,
        registry: h.registry,
        authenticationFlows: new ConnectorAuthenticationFlowService({
          db: h.db,
          registry: h.registry,
        }),
        authorityCleanup: {
          revokeConnection: vi.fn(),
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
        },
        managed: sync,
      });
      await lifecycle.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      lifecycle.remove(OWNER, CONNECTION_ID);
      expect(h.db.select().from(connections).get()).toMatchObject({
        removedAt: expect.any(String),
        externalCleanupState: 'pending',
      });

      h.db
        .update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'complete',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);
      expect(h.submitted.at(-1)).toMatchObject({
        kind: 'set_connection_lifecycle',
        lifecycle: 'disconnected',
      });
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });

    it('can’t confirm the end of a disconnect the service no longer recognizes', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      await h.service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        externalCleanupState: 'unknown',
        closedBecause: null,
      });
    });

    it('sends a disconnect the old link refused again, so DorkOS still finishes it', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      await sync.transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'disconnected',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('pending');
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'complete',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal);
      expect(h.submitted.at(-1)).toMatchObject({
        kind: 'set_connection_lifecycle',
        lifecycle: 'disconnected',
      });
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });

    it('never counts a refused pause (recorded before this change) as a refused resume', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      // An earlier refused pause, as the 0125 backfill names it.
      h.db
        .insert(connectorManagedAuthorityOutbox)
        .values({
          commandId: 'old-refused-pause',
          connectionId: CONNECTION_ID,
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          managedConnectionId: MANAGED_CONNECTION_ID,
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          requestHash: 'h',
          requestJson: JSON.stringify({
            version: 1,
            commandId: 'old-refused-pause',
            managedConnectionId: MANAGED_CONNECTION_ID,
            scopeVersion: 1,
            kind: 'set_connection_lifecycle',
            lifecycle: 'paused',
          }),
          state: 'rejected',
          rejectionCode: 'connection_unavailable',
          createdAt: new Date(h.clock).toISOString(),
          updatedAt: new Date(h.clock).toISOString(),
        })
        .run();
      h.db
        .insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: MANAGED_CONNECTION_ID,
          scopeKind: 'connection_lifecycle',
          subjectId: 'connection',
          scopeVersion: 1,
          lastCommandId: 'old-refused-pause',
          lastCommandHash: 'h',
          updatedAt: new Date(h.clock).toISOString(),
        })
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      await h.service().transition({
        connectionId: CONNECTION_ID,
        managedConnectionId: MANAGED_CONNECTION_ID,
        lifecycle: 'active',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
      });
    });
  });
});
