import { describe, expect, it, vi } from 'vitest';
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
  createDb,
  runMigrations,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
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
  directory,
  requestRow,
} from './agent-request-service.fixtures.js';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorOperatorQueryService,
  type ConnectorServiceDirectory,
} from '../../resources/operator-query-service.js';
import { ConnectorRegistry } from '../../registry.js';

/** Answering with the access the agent already holds, and requests for a service no way reaches. */
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
      const decision = CURRENT_ACCESS as const;

      await requests.resolve(OWNER, created.requestId, decision);
      await expect(requests.resolve(OWNER, created.requestId, decision)).resolves.toMatchObject({
        status: 'granted',
      });
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).rejects.toMatchObject({ code: 'request_already_resolved' });
    });
  });

  describe('a request for a service this installation cannot connect', () => {
    // Display names verified against docs.composio.dev/toolkits/<slug> on 2026-09-23.
    const COMPOSIO = [
      ['gmail', 'Gmail'],
      ['outlook', 'Outlook'],
      ['composio_search', 'Composio Search'],
      ['linear', 'Linear'],
    ] as const;

    function withDirectory(value: ConnectorServiceDirectory) {
      return h.service({ services: { serviceDirectory: vi.fn(async () => value) } });
    }

    async function refusal(
      requests: ConnectorAgentRequestService,
      serviceSlug: string,
      runtime: 'claude-code' | 'codex' | 'opencode' = 'claude-code'
    ) {
      const error: unknown = await requests
        .create(principal({ runtime }), { ...INPUT, serviceSlug })
        .then(
          () => undefined,
          (caught: unknown) => caught
        );
      expect(error).toMatchObject({ code: 'service_unavailable' });
      expect(h.db.select().from(connectorReviewRequests).all()).toEqual([]);
      return (error as Error).message;
    }

    // The in-app report: an agent guessed `composio-emails`, was told only that the
    // service "is not available", and fell back to installing a CLI in its shell.
    it('points a guessed name at the lookup tool without suggesting a service named after the route', async () => {
      const message = await refusal(withDirectory(directory(COMPOSIO)), 'composio-emails');

      expect(message).toContain('"composio-emails"');
      expect(message).toContain('mcp__dorkos__connector_list_toolkits');
      expect(message).not.toContain('Close matches');
      expect(message).not.toContain('composio_search');
    });

    it.each([
      ['a route-prefixed guess', 'composio_gmail'],
      ['a guess with the service id inside it', 'gmail_inbox'],
    ])('suggests the real service %s names', async (_label, guess) => {
      const message = await refusal(withDirectory(directory(COMPOSIO)), guess);

      expect(message).toContain('Close matches: gmail.');
    });

    it('accepts a service a linked account brings back, through the recovery the lookup runs', async () => {
      // The catalog side reads its own store; this suite's seeded rows describe a
      // provider that registry never registers.
      const catalogDb = createDb(':memory:');
      runMigrations(catalogDb);
      const registry = new ConnectorRegistry({
        db: catalogDb,
        configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
      });
      const managed = new FakeConnectorProvider({
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-managed'),
        type: 'dorkos-managed',
        toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      });
      const recoverManagedProvider = vi.fn(async () => {
        if (!registry.resolveProviderInstance(managed.instanceId)) {
          registry.register(managed, 'material-managed');
        }
      });
      const requests = h.service({
        services: new ConnectorOperatorQueryService({
          db: catalogDb,
          registry,
          recoverManagedProvider,
          sessions: { resolveSessionAgent: () => undefined },
          agentOwnership: { ownsAgent: () => false },
        }),
      });

      await expect(requests.create(principal(), INPUT)).resolves.toMatchObject({
        status: 'awaiting_owner',
        serviceSlug: 'gmail',
      });
      expect(recoverManagedProvider).toHaveBeenCalledOnce();
    });

    it('answers "try again" on time even when a route ignores the signal', async () => {
      const started = Date.now();
      const message = await refusal(
        h.service({
          serviceDirectoryTimeoutMs: 50,
          services: {
            serviceDirectory: vi.fn(
              () =>
                new Promise<ConnectorServiceDirectory>((resolve) => {
                  setTimeout(() => resolve(directory([['gmail', 'Gmail']])), 1_500);
                })
            ),
          },
        }),
        'gmail'
      );

      expect(message).toContain('Try again');
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    /** The real catalog read, with nothing set up to reach apps. */
    function bareDirectory(registry?: ConnectorRegistry) {
      const catalogDb = createDb(':memory:');
      runMigrations(catalogDb);
      return new ConnectorOperatorQueryService({
        db: catalogDb,
        registry:
          registry ??
          new ConnectorRegistry({
            db: catalogDb,
            configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
          }),
        relay: {
          getManifest: (type) => (type === 'telegram' ? { displayName: 'Telegram' } : undefined),
          getCatalog: () => [{ manifest: { type: 'telegram', displayName: 'Telegram' } }],
        },
        sessions: { resolveSessionAgent: () => undefined },
        agentOwnership: { ownsAgent: () => false },
      });
    }

    it('records a request for a popular app no way reaches yet, once, like any other (DOR-2494)', async () => {
      const requests = h.service({ services: bareDirectory() });

      const created = await requests.create(principal(), INPUT);
      expect(created).toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
      // The same ask again is the same request: no second card, no second row.
      const again = await requests.create(principal(), INPUT);
      expect(again.requestId).toBe(created.requestId);
      expect(h.db.select().from(connectorReviewRequests).all()).toHaveLength(1);
      // Nothing is granted by asking: the owner still decides.
      expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
    });

    it('answers at once with the choices to offer when no way reaches the app yet (FB-57)', async () => {
      const requests = h.service({ services: bareDirectory() });

      const opened = await requests.open(principal(), INPUT);
      // No silent wait: the person has a choice to make first.
      expect(opened.waitForOwner).toBe(false);
      expect(opened.status).toMatchObject({ status: 'awaiting_owner', serviceSlug: 'gmail' });
      const { note } = opened.status;
      expect(note).toContain("DorkOS can't reach Gmail yet");
      expect(note).toContain("These are steps the person takes, so don't say how long they take");
      expect(note).toContain('ask which one they want, then help them do it');
      expect(note).toContain(
        'sign in to a DorkOS account, or create one, in Settings › DorkOS account'
      );
      expect(note).toContain('paste their own Composio key in Settings › Connections');
      expect(note).toContain("don't ask again");
      // Asking again while it is still unreachable gives the same choices.
      const again = await requests.open(principal(), INPUT);
      expect(again.status.requestId).toBe(opened.status.requestId);
      expect(again.waitForOwner).toBe(false);
      // Nobody holds the call, so the row must not look held: a live hold
      // keeps the owner's answer out of the chat until it runs out.
      expect(requestRow(h.db, opened.status.requestId)).toMatchObject({
        liveHoldBootEpoch: null,
        liveHoldUntil: null,
      });
    });
  });
});
