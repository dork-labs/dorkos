import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorReviewRequests,
  createDb,
  runMigrations,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorAgentRequestService } from '../../agent-request-service.js';
import {
  OWNER,
  INPUT,
  principal,
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

/** Requests for a service no way reaches: refusals, close matches and the catalog lookup. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

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
