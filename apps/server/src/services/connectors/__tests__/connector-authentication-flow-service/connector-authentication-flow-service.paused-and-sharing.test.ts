import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionAccessLevels,
  connectorAuthenticationFlows,
  connectorOperationRevisions,
  connectionOperationGrants,
  connections,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorReconciliationService } from '../../reconciliation-service.js';
import {
  TrustedConnectionSharing,
  type TrustedSharingConfig,
} from '../../access/trusted-sharing.js';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import {
  OWNER,
  PROVIDER_ID,
  NOW,
  RestartSafeProvider,
  insertActiveConnection,
  useAuthenticationFlowHarness,
  GMAIL_START,
} from './connector-authentication-flow-service.fixtures.js';

/** A sign-in again never leaves an account paused, and sharing a new app on Trusted. */
describe('ConnectorAuthenticationFlowService', () => {
  const h = useAuthenticationFlowHarness();

  describe('a sign-in again never leaves an account paused', () => {
    const accountOf = (id: string) =>
      h.db
        .select({ enabled: connections.enabled, pausedBy: connections.pausedBy })
        .from(connections)
        .where(eq(connections.id, id))
        .get();

    it('pauses the account while it runs, and records that the pause is the sign-in’s', async () => {
      const existing = insertActiveConnection(h.db);
      await h.service.reconnect(OWNER, existing, 'running');
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'sign_in' });
    });

    it('gives the account back when a sign-in nobody finished runs out of time', async () => {
      const existing = insertActiveConnection(h.db);
      let clock = NOW;
      const timed = new ConnectorAuthenticationFlowService({
        db: h.db,
        registry: h.registry,
        now: () => clock,
      });
      const started = await timed.reconnect(OWNER, existing, 'abandoned');
      // Nobody reads the flow again: the sweep alone ends it.
      clock = new Date(NOW.getTime() + 60 * 60_000);
      expect(timed.expireAbandoned()).toBe(1);
      expect(
        h.db
          .select({ state: connectorAuthenticationFlows.state })
          .from(connectorAuthenticationFlows)
          .where(eq(connectorAuthenticationFlows.id, started.flowId))
          .get()
      ).toEqual({ state: 'expired' });
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
      expect(timed.expireAbandoned()).toBe(0);
    });

    it('gives the account back when a restart interrupted the sign-in’s start', async () => {
      const existing = insertActiveConnection(h.db);
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'sign_in' })
        .where(eq(connections.id, existing))
        .run();
      h.db
        .insert(connectorAuthenticationFlows)
        .values({
          id: 'interrupted',
          ownerKind: OWNER.kind,
          ownerId: OWNER.installationId,
          idempotencyKey: 'interrupted',
          requestHash: 'hash',
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          toolkit: 'gmail',
          reconnectConnectionId: existing,
          state: 'starting',
          createdAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .run();
      expect(h.service.invalidateInterruptedStarts()).toBe(1);
      expect(accountOf(existing)).toEqual({ enabled: true, pausedBy: null });
    });

    it('never lifts a pause the owner chose, even when the sign-in fails', async () => {
      const existing = insertActiveConnection(h.db);
      h.registry.setPaused(existing, true);
      vi.spyOn(h.provider, 'pollConnect').mockResolvedValue({ status: 'failed' });
      const started = await h.service.reconnect(OWNER, existing, 'owner-paused');
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'owner' });
      await h.service.poll(OWNER, started.flowId);
      expect(accountOf(existing)).toEqual({ enabled: false, pausedBy: 'owner' });
    });
  });
});

describe('ConnectorAuthenticationFlowService sharing a new app on Trusted', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: RestartSafeProvider;
  let preset: UserConfig['permissions']['preset'];
  let sharing: TrustedConnectionSharing;
  let service: ConnectorAuthenticationFlowService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    provider = new RestartSafeProvider({ instanceId: PROVIDER_ID, toolkitVersion: 'v1' });
    vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => ({
      status: 'ok' as const,
      page: {
        operations: (
          [
            ['gmail.list', 'read'],
            ['gmail.send', 'write'],
            ['gmail.delete', 'destructive'],
          ] as const
        ).map(([slug, classification]) => ({
          providerInstanceId: provider.instanceId,
          toolkit: request.toolkit,
          operationSlug: slug,
          toolkitVersion: request.toolkitVersion,
          schemaHash: `sha256:${slug}`,
          capabilityClassification: classification,
          retryPolicy: 'never' as const,
          inputSchema: { type: 'object', additionalProperties: false },
        })),
        truncated: false,
      },
    }));
    registry.register(provider, 'material-a');
    preset = 'trusted';
    const reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [],
      now: () => NOW,
    });
    sharing = new TrustedConnectionSharing({
      db,
      // A new connection reads the posture only; it writes no config.
      config: {
        get: ((key: 'permissions' | 'ui') =>
          key === 'permissions'
            ? { ...USER_CONFIG_DEFAULTS.permissions, preset }
            : USER_CONFIG_DEFAULTS.ui) as TrustedSharingConfig['get'],
        set: () => {},
      },
      reconciliation,
      appVersion: 'test',
      now: () => NOW,
    });
    service = new ConnectorAuthenticationFlowService({ db, registry, now: () => NOW, sharing });
  });

  /** Sign in, and wait for the catalog read the sign-in started. */
  async function connect(started: Promise<{ flowId: string }>) {
    const follow = vi.spyOn(sharing, 'follow');
    const completed = await service.poll(OWNER, (await started).flowId);
    await Promise.all(follow.mock.results.map((result) => result.value));
    return { completed, follow };
  }

  const levels = () =>
    db
      .select()
      .from(connectionAccessLevels)
      .all()
      .map((row) => `${row.subjectType}:${row.level}`);

  const liveGrants = () =>
    db
      .select({ slug: connectorOperationRevisions.operationSlug })
      .from(connectionOperationGrants)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
      )
      .where(eq(connectionOperationGrants.subjectType, 'every_agent'))
      .all()
      .map((row) => row.slug)
      .sort();

  it('shares a new connection with every agent at Read and write, with the grants in place', async () => {
    const { completed } = await connect(
      service.start(OWNER, { ...GMAIL_START, label: 'Work', idempotencyKey: 'trusted-new' })
    );

    expect(completed).toMatchObject({ state: 'connected' });
    expect(levels()).toEqual(['every_agent:read-write']);
    // Read and write never covers a destructive action.
    expect(liveGrants()).toEqual(['gmail.list', 'gmail.send']);
  });

  it('shares nothing on a Careful install', async () => {
    preset = 'careful';
    const { follow } = await connect(
      service.start(OWNER, { ...GMAIL_START, label: 'Work', idempotencyKey: 'careful-new' })
    );

    expect(levels()).toEqual([]);
    expect(liveGrants()).toEqual([]);
    expect(follow).not.toHaveBeenCalled();
  });

  it('never rewrites who can use an app when it is signed in to again', async () => {
    const existing = insertActiveConnection(db);
    const { completed, follow } = await connect(
      service.reconnect(OWNER, existing, 'trusted-reconnect')
    );

    expect(completed).toMatchObject({ state: 'connected', connectionId: existing });
    expect(levels()).toEqual([]);
    expect(follow).not.toHaveBeenCalled();
  });
});
