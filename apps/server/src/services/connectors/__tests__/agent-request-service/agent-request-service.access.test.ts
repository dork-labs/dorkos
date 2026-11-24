import {
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
} from '@dorkos/db';
import { describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connectorAgentRequests,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  sessionConnectionOverrides,
  sessionMessageAcceptanceReceipts,
} from '@dorkos/db';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { ConnectorAgentRequestService } from '../../agent-request-service.js';
import {
  OWNER,
  NOW,
  CONNECTION_ID,
  INPUT,
  READ_WRITE,
  CURRENT_ACCESS,
  principal,
  seedSecondAccount,
  useAgentRequestHarness,
} from './agent-request-service.fixtures.js';

/** Answering a request with the access the agent already holds, and what the follow-up rechecks. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  describe('answering with the access the agent already holds', () => {
    it('resolves with exactly the live grants and writes none, even beyond what was asked', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      // Read and write from the card: more than the two operations requested.
      h.grantLive(['revision-read', 'revision-draft', 'revision-delete']);
      const before = h.db.select().from(connectionOperationGrants).all();

      const resolved = await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);

      expect(resolved).toMatchObject({
        status: 'granted',
        connectionId: CONNECTION_ID,
        grantedOperationRevisionIds: ['revision-delete', 'revision-draft', 'revision-read'],
      });
      expect(h.db.select().from(connectionOperationGrants).all()).toEqual(before);
      expect(
        h.db
          .select()
          .from(connectorReviewRequests)
          .where(eq(connectorReviewRequests.state, 'approved'))
          .all()
      ).toHaveLength(1);
    });

    it('refuses when the agent holds nothing on that account, and leaves the request pending', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);

      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).rejects.toMatchObject({ code: 'selection_invalid' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    });

    it("does not count another agent's access as this agent's", async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: 'grant-other',
          subjectType: 'agent',
          subjectId: 'agent-2',
          agentId: 'agent-2',
          connectionId: 'connection-1',
          operationRevisionId: 'revision-read',
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it('refuses a foreign owner and an account of another service', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.grantLive(['revision-read']);
      h.db
        .update(connections)
        .set({ toolkit: 'slack' })
        .where(eq(connections.id, 'connection-1'))
        .run();

      await expect(
        requests.resolve(
          { kind: 'local_install', installationId: 'foreign' },
          created.requestId,
          CURRENT_ACCESS
        )
      ).rejects.toMatchObject({ code: 'request_not_found' });
      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    it('waits for a managed account to finish applying the agent’s access', async () => {
      h.db
        .update(connectorProviderInstances)
        .set({ mode: 'managed', custody: 'managed' })
        .where(eq(connectorProviderInstances.id, 'provider-1'))
        .run();
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).rejects.toMatchObject({ code: 'authority_sync_failed' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    });

    /** Share the account with every agent, the way the page's "Every agent" save does. */
    function shareWithEveryAgent(revisionIds: string[]): void {
      for (const operationRevisionId of revisionIds) {
        h.db
          .insert(connectionOperationGrants)
          .values({
            id: `every-${operationRevisionId}`,
            subjectType: 'every_agent',
            subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
            agentId: null,
            connectionId: 'connection-1',
            operationRevisionId,
            createdBy: 'local_install:install-1',
            createdAt: NOW.toISOString(),
          })
          .run();
      }
    }

    it('counts an "Every agent" grant as this agent\'s access, as the execution check does', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      shareWithEveryAgent(['revision-read']);
      const before = h.db.select().from(connectionOperationGrants).all();

      const resolved = await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);

      expect(resolved).toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
        notGranted: [],
      });
      expect(h.db.select().from(connectionOperationGrants).all()).toEqual(before);
    });

    /** Scope this session's use of the account by hand, as Connections does. */
    function overrideSession(
      state: 'attached' | 'detached',
      options: { agentId?: string; needsReconciliation?: boolean } = {}
    ): void {
      h.db
        .insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-1',
          agentId: options.agentId ?? 'agent-1',
          connectionId: 'connection-1',
          state,
          needsReconciliation: options.needsReconciliation ?? false,
          updatedAt: NOW.toISOString(),
        })
        .run();
    }

    /** A grant this session holds on its own, used only under an `attached` override. */
    function grantSession(operationRevisionId: string): void {
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: `session-grant-${operationRevisionId}`,
          subjectType: 'session',
          subjectId: 'session-1',
          agentId: 'agent-1',
          connectionId: 'connection-1',
          operationRevisionId,
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();
    }

    it.each([
      ['detached', 'detached', {}],
      ["another agent's", 'attached', { agentId: 'agent-2' }],
      ['awaiting reconciliation', 'attached', { needsReconciliation: true }],
    ] as const)(
      'refuses when this chat has the account turned off (%s override), as execution would',
      async (_label, state, options) => {
        const requests = h.service();
        const created = await requests.create(principal(), INPUT);
        h.grantLive(['revision-read']);
        grantSession('revision-read');
        overrideSession(state, options);

        await expect(
          requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
        ).rejects.toMatchObject({ code: 'session_access_off' });
        expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
      }
    );

    it("never counts another chat's own grant under an attached override", async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      overrideSession('attached');
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: 'other-session-grant',
          subjectType: 'session',
          subjectId: 'session-2',
          agentId: 'agent-1',
          connectionId: 'connection-1',
          operationRevisionId: 'revision-read',
          createdBy: 'local_install:install-1',
          createdAt: NOW.toISOString(),
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).rejects.toMatchObject({ code: 'selection_invalid' });
    });

    describe('the follow-up rechecks the recorded access before it starts', () => {
      /** Answer with read access, then stop at the moment before the follow-up is claimed. */
      async function answeredFollowUp() {
        const { acceptance, requests } = h.serviceWithFollowUps();
        const created = await requests.create(principal(), INPUT);
        h.grantLive(['revision-read']);
        await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);
        h.clock = new Date(NOW.getTime() + 11 * 60_000);
        await requests.reconcile();
        const receiptId = h.db.select().from(sessionMessageAcceptanceReceipts).get()!.id;
        const prepared = await acceptance.prepare(receiptId);
        return { claim: () => acceptance.claim(receiptId, prepared), prepared };
      }

      it('refuses when a granted revision was revoked since', async () => {
        const followUp = await answeredFollowUp();
        h.db
          .update(connectionOperationGrants)
          .set({ revokedAt: h.clock.toISOString() })
          .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
          .run();
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });

      it('refuses when this chat has since had the account turned off', async () => {
        const followUp = await answeredFollowUp();
        overrideSession('detached');
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });

      it('refuses when the pinned revision was replaced by a newer one', async () => {
        const followUp = await answeredFollowUp();
        h.db
          .insert(connectorOperationRevisions)
          .values({
            id: 'revision-read-2',
            providerInstanceId: 'provider-1',
            toolkit: 'gmail',
            operationSlug: 'gmail.read',
            toolkitVersion: '2',
            schemaHash: 'hash-revision-read-2',
            capabilityClassification: 'read',
            retryPolicy: 'never',
            providerRevisionRef: 'hosted-revision-read-2',
            inputSchemaJson: '{}',
            discoveredAt: NOW.toISOString(),
          })
          .run();
        h.db
          .update(connectionOperationGrants)
          .set({ revokedAt: h.clock.toISOString() })
          .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
          .run();
        h.grantLive(['revision-read-2']);
        expect(() => followUp.claim()).toThrow(
          expect.objectContaining({ code: 'authority_expired' })
        );
      });
    });

    it('counts only live grants: a revoked one is not access', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.grantLive(['revision-read', 'revision-draft']);
      h.db
        .update(connectionOperationGrants)
        .set({ revokedAt: NOW.toISOString() })
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-draft'))
        .run();

      const resolved = await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);
      expect(resolved).toMatchObject({ grantedOperationRevisionIds: ['revision-read'] });
      // The follow-up for the first answer went out, so a new ask opens a new request.
      h.db.update(connectorAgentRequests).set({ resumeState: 'resumed' }).run();

      // Every grant revoked: nothing live, so nothing to answer with.
      const second = await requests.create(principal(), { ...INPUT, reason: 'Another look' });
      expect(second.requestId).not.toBe(created.requestId);
      h.db
        .update(connectionOperationGrants)
        .set({ revokedAt: NOW.toISOString() })
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-read'))
        .run();
      await expect(requests.resolve(OWNER, second.requestId, CURRENT_ACCESS)).rejects.toMatchObject(
        { code: 'selection_invalid' }
      );
    });

    describe('a level the account cannot give (DOR-4193)', () => {
      /** Ask for Read and write, and answer it with exactly `ids` on the second account. */
      async function answeredOnSecond(requests: ConnectorAgentRequestService, ids: string[]) {
        const created = await requests.create(principal(), READ_WRITE);
        h.grantLive(ids, 'connection-2');
        return requests.resolve(OWNER, created.requestId, {
          ...CURRENT_ACCESS,
          connectionId: 'connection-2' as ConnectionId,
        });
      }

      it('lists write as not granted when the account has no actions that change things', async () => {
        seedSecondAccount(h.db, [['read-2', 'read']]);
        const resolved = await answeredOnSecond(h.service(), ['read-2']);

        expect(resolved).toMatchObject({ status: 'granted', notGranted: ['write'] });
        expect(resolved.note).toContain('You can now read Gmail.');
        expect(resolved.note).toContain("You can't change anything in Gmail");
        expect(resolved.note).toContain('connect Gmail again on the Connections page');
        expect(resolved.note).not.toContain('Carry on');
      });
    });

    it('answers the same decision twice idempotently and refuses a different later one', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.grantLive(['revision-read']);
      const decision = CURRENT_ACCESS;

      await requests.resolve(OWNER, created.requestId, decision);
      await expect(requests.resolve(OWNER, created.requestId, decision)).resolves.toMatchObject({
        status: 'granted',
      });
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).rejects.toMatchObject({ code: 'request_already_resolved' });
    });

    it('counts "Every agent" on a managed account once hosted authority has applied it', async () => {
      h.db
        .update(connectorProviderInstances)
        .set({ mode: 'managed', custody: 'managed' })
        .where(eq(connectorProviderInstances.id, 'provider-1'))
        .run();
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      shareWithEveryAgent(['revision-read']);

      // Nothing hosted has applied yet: the answer waits (DOR-2439).
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'authority_sync_failed' });

      const stamp = NOW.toISOString();
      h.db
        .insert(connectorManagedAuthorityOutbox)
        .values({
          commandId: 'every-agent-v1',
          connectionId: 'connection-1',
          providerInstanceId: 'provider-1',
          executionConfigGeneration: 1,
          ownerKind: 'local_install',
          ownerId: 'install-1',
          managedConnectionId: 'private-account-ref',
          scopeKind: 'every_agent_grants',
          subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
          scopeVersion: 1,
          requestHash: 'hash',
          requestJson: '{}',
          state: 'applied',
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      h.db
        .insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: 'private-account-ref',
          scopeKind: 'every_agent_grants',
          subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
          scopeVersion: 1,
          lastCommandId: 'every-agent-v1',
          lastCommandHash: 'hash',
          updatedAt: stamp,
        })
        .run();

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({
        status: 'granted',
        grantedOperationRevisionIds: ['revision-read'],
      });
    });

    it("counts only the session's own grants under an attached override", async () => {
      const requests = h.service();
      const created = await requests.create(principal(), INPUT);
      h.grantLive(['revision-read', 'revision-draft']);
      overrideSession('attached');

      // The agent's own grants do not reach a chat scoped by hand.
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).rejects.toMatchObject({ code: 'selection_invalid' });

      grantSession('revision-read');
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({ grantedOperationRevisionIds: ['revision-read'] });
    });
  });
});
