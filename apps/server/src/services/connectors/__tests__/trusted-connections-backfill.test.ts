/**
 * The once-per-install step that shares every connected app nobody was given
 * with every agent (spec `trusted-by-default-flip` §5.6, decision D1).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
} from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { applyTrustedStoresAtBoot } from '../../mesh/seed-open-mesh.js';
import { TrustedConnectionSharing, type TrustedSharingConfig } from '../access/trusted-sharing.js';
import { liveEveryAgentAccess } from '../every-agent-grants.js';
import { everyAgentLevel } from '../execution/access-levels.js';
import {
  CONNECTION_ID,
  NOW,
  OWNER,
  grantLevels,
  levelIds,
  levelHarness,
  liveActions,
  storedLevels,
  type LevelHarness,
} from './helpers/access-levels-harness.js';

const noopLogger = { info: () => {}, warn: () => {} };

/** A live config holding the two sections sharing reads and writes. */
function fakeConfig(
  preset: UserConfig['permissions']['preset'] = 'trusted',
  over: { permissions?: Partial<UserConfig['permissions']>; ui?: Partial<UserConfig['ui']> } = {}
) {
  const store: Pick<UserConfig, 'permissions' | 'ui'> = {
    permissions: { ...USER_CONFIG_DEFAULTS.permissions, preset, ...over.permissions },
    ui: { ...USER_CONFIG_DEFAULTS.ui, ...over.ui },
  };
  let failingWrites = 0;
  return {
    get: ((key: 'permissions' | 'ui') => store[key]) as TrustedSharingConfig['get'],
    set: ((key: 'permissions' | 'ui', value: never) => {
      if (failingWrites > 0) {
        failingWrites -= 1;
        throw new Error('config.json could not be written.');
      }
      store[key] = value;
    }) as TrustedSharingConfig['set'],
    permissions: () => store.permissions,
    ui: () => store.ui,
    /** Make the next `count` writes throw, as a full disk would. */
    failNextWrites: (count: number) => {
      failingWrites = count;
    },
  };
}

/** A second connected app beside the harness's own, nobody given access. */
function addConnection(harness: LevelHarness, id: string): void {
  harness.db
    .insert(connections)
    .values({
      id,
      providerInstanceId: harness.provider.instanceId,
      externalAccountRef: `external-${id}`,
      toolkit: 'gmail',
      label: `Gmail ${id}`,
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();
}

function sharingFor(harness: LevelHarness, config: ReturnType<typeof fakeConfig>) {
  return new TrustedConnectionSharing({
    db: harness.db,
    config,
    reconciliation: harness.service,
    ...(harness.sync ? { managedAuthority: harness.sync } : {}),
    appVersion: 'test',
    now: () => NOW,
  });
}

/**
 * One boot, through the real boot call. Mesh never started here, so the open
 * mesh defers and `trustedStoresAppliedAt` stays as it was: the apps step
 * stands on its own stamp.
 */
async function runOnce(harness: LevelHarness, config: ReturnType<typeof fakeConfig>) {
  const sharing = sharingFor(harness, config);
  const follow = vi.spyOn(sharing, 'follow');
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    await applyTrustedStoresAtBoot(config as never, noopLogger, {
      mesh: undefined,
      relayReady: false,
      connections: sharing,
    });
  } finally {
    vi.useRealTimers();
  }
  await Promise.all(follow.mock.results.map((result) => result.value));
  return follow;
}

describe('sharing existing connections at the Trusted upgrade', () => {
  it('shares an app nobody holds access to, names it, grants it and stamps', async () => {
    const harness = levelHarness();
    const config = fakeConfig();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual(['every_agent:read-write']);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
    // Read and write never covers a destructive action.
    expect(liveActions(harness.db, 'every_agent')).toEqual(['gmail.list:read', 'gmail.send:write']);
    expect(harness.activity.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorLabel: 'DorkOS',
        eventType: 'connectors.every_agent_changed',
        summary: expect.stringContaining('Shared Gmail (Work Gmail) with every agent'),
      })
    );
  });

  it('leaves an app someone already holds access to as it is', async () => {
    const harness = levelHarness();
    await grantLevels(harness);
    const before = storedLevels(harness.db);
    const config = fakeConfig();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual(before);
    expect(liveActions(harness.db, 'every_agent')).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
  });

  it('leaves an app alone when only an exact grant is live, with no level', async () => {
    const harness = levelHarness();
    harness.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'revision-list',
        providerInstanceId: harness.provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.list',
        toolkitVersion: 'v1',
        schemaHash: 'sha256:gmail.list',
        capabilityClassification: 'read',
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    harness.db
      .insert(connectionOperationGrants)
      .values({
        id: 'grant-exact',
        subjectType: 'agent',
        subjectId: 'exact',
        agentId: 'exact',
        connectionId: CONNECTION_ID,
        operationRevisionId: 'revision-list',
        createdBy: 'install-a',
        createdAt: NOW.toISOString(),
      })
      .run();
    const config = fakeConfig();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
  });

  it('keeps Read when the app offers nothing that writes', async () => {
    const harness = levelHarness();
    harness.catalog.splice(0, harness.catalog.length, {
      slug: 'gmail.list',
      classification: 'read',
    });
    const config = fakeConfig();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual(['every_agent:read']);
    expect(liveActions(harness.db, 'every_agent')).toEqual(['gmail.list:read']);
  });

  it('leaves a Careful install untouched for good, like the open mesh step', async () => {
    const harness = levelHarness();
    const seenAt = '2026-10-01T09:00:00.000Z';
    const config = fakeConfig('careful', { ui: { trustNoticeSeenAt: seenAt } });

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
    expect(config.ui().trustNoticeSeenAt).toBe(seenAt);

    // A later move to Trusted shares only apps connected from then on: the
    // step already ran, so an existing app stays as the person left it.
    config.set('permissions', { ...config.permissions(), preset: 'trusted' });
    const follow = await runOnce(harness, config);

    expect(follow).not.toHaveBeenCalled();
    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.ui().trustNoticeSeenAt).toBe(seenAt);
  });

  it('never shares again an app someone shared with every agent and then stopped', async () => {
    const harness = levelHarness();
    const snapshot = await harness.preview();
    await harness.service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
    });
    await harness.service.revokeEveryAgent(OWNER, CONNECTION_ID);
    // Stopped: no level, and only revoked grant rows left behind.
    expect(storedLevels(harness.db)).toEqual([]);
    const config = fakeConfig();

    const follow = await runOnce(harness, config);

    expect(follow).not.toHaveBeenCalled();
    expect(storedLevels(harness.db)).toEqual([]);
    expect(liveActions(harness.db, 'every_agent')).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
  });

  it('names an app whose catalog could not be read, so a share is never silent', async () => {
    const harness = levelHarness();
    const config = fakeConfig('trusted', { ui: { trustNoticeSeenAt: '2026-10-10T08:05:00.000Z' } });
    const sharing = new TrustedConnectionSharing({
      db: harness.db,
      config,
      reconciliation: {
        followCatalog: vi.fn().mockRejectedValue(new Error('The service is down.')),
      },
      appVersion: 'test',
      now: () => NOW,
    });
    const follow = vi.spyOn(sharing, 'follow');

    expect(await sharing.upgradeStep().run()).toBe('applied');
    await Promise.all(follow.mock.results.map((result) => result.value));

    // Shared by level, with no grant yet: the follower adds them later.
    expect(storedLevels(harness.db)).toEqual(['every_agent:read-write']);
    expect(liveActions(harness.db, 'every_agent')).toEqual([]);
    // What the notice reads: the level, not the grants.
    expect(everyAgentLevel(harness.db, CONNECTION_ID)).toBe('read-write');
    expect(liveEveryAgentAccess(harness.db, CONNECTION_ID)).toBeNull();
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
    expect(config.ui().trustNoticeSeenAt).toBeNull();
  });

  it('skips a disconnected app', async () => {
    const harness = levelHarness();
    harness.db.update(connections).set({ lifecycleState: 'disconnected' }).run();
    const config = fakeConfig();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual([]);
  });

  it('skips a DorkOS-account app when nothing can carry its access to hosted authority', async () => {
    const harness = levelHarness({ managed: true });
    const config = fakeConfig();
    const sharing = new TrustedConnectionSharing({
      db: harness.db,
      config,
      reconciliation: harness.service,
      appVersion: 'test',
      now: () => NOW,
    });

    expect(await sharing.upgradeStep().run()).toBe('applied');
    expect(storedLevels(harness.db)).toEqual([]);
  });

  it('runs once: a second boot after a person narrowed the app changes nothing', async () => {
    const harness = levelHarness();
    const config = fakeConfig();
    await runOnce(harness, config);
    await harness.service.revokeEveryAgent(
      { kind: 'local_install', installationId: 'install-a' },
      CONNECTION_ID
    );
    expect(storedLevels(harness.db)).toEqual([]);

    const follow = await runOnce(harness, config);

    expect(follow).not.toHaveBeenCalled();
    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
  });

  it('shares once on an install that already applied the other Trusted defaults, and shows the notice again', async () => {
    const harness = levelHarness();
    // Booted PR4: the open mesh is stamped and the notice was dismissed.
    const config = fakeConfig('trusted', {
      permissions: { trustedStoresAppliedAt: '2026-10-10T08:00:00.000Z' },
      ui: { trustNoticeSeenAt: '2026-10-10T08:05:00.000Z' },
    });

    const first = await runOnce(harness, config);

    expect(first).toHaveBeenCalledTimes(1);
    expect(storedLevels(harness.db)).toEqual(['every_agent:read-write']);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
    expect(config.permissions().trustedStoresAppliedAt).toBe('2026-10-10T08:00:00.000Z');
    // Not shared silently: the notice comes back, listing the app.
    expect(config.ui().trustNoticeSeenAt).toBeNull();

    // The person reads it again and dismisses it; a second boot does nothing.
    config.set('ui', { ...config.ui(), trustNoticeSeenAt: '2026-10-13T10:00:00.000Z' });
    const second = await runOnce(harness, config);

    expect(second).not.toHaveBeenCalled();
    expect(config.ui().trustNoticeSeenAt).toBe('2026-10-13T10:00:00.000Z');
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
  });

  it('does not show the notice again when it shared nothing', async () => {
    const harness = levelHarness();
    await grantLevels(harness);
    const seenAt = '2026-10-10T08:05:00.000Z';
    const config = fakeConfig('trusted', {
      permissions: { trustedStoresAppliedAt: '2026-10-10T08:00:00.000Z' },
      ui: { trustNoticeSeenAt: seenAt },
    });

    await runOnce(harness, config);

    expect(config.ui().trustNoticeSeenAt).toBe(seenAt);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
  });

  it('never shares a DorkOS-account app hosted authority was already asked about', async () => {
    const harness = levelHarness({ managed: true });
    // A grant command for this account is on record with hosted authority,
    // and no grant row or level is left here: hosted authority holds the only
    // trace that someone already decided who may use it.
    harness.db
      .insert(connectorManagedAuthorityScopes)
      .values({
        managedConnectionId: 'external-a',
        scopeKind: 'every_agent_grants',
        subjectId: 'every_agent',
        scopeVersion: 2,
        lastCommandId: 'command-stop',
        lastCommandHash: 'hash-stop',
        updatedAt: NOW.toISOString(),
      })
      .run();
    expect(storedLevels(harness.db)).toEqual([]);
    expect(harness.db.select().from(connectionOperationGrants).all()).toEqual([]);
    const config = fakeConfig();

    const follow = await runOnce(harness, config);

    expect(follow).not.toHaveBeenCalled();
    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
  });

  it('shares nothing and stamps nothing when the list cannot be written, then retries', async () => {
    const harness = levelHarness();
    const config = fakeConfig('trusted', { ui: { trustNoticeSeenAt: '2026-10-10T08:05:00.000Z' } });
    config.failNextWrites(1);

    await runOnce(harness, config);

    // Told first: with nobody told, nothing may be shared.
    expect(storedLevels(harness.db)).toEqual([]);
    expect(config.permissions().sharedAtUpgrade).toEqual([]);
    expect(config.permissions().sharedAppsAppliedAt).toBeNull();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual(['every_agent:read-write']);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
    expect(config.ui().trustNoticeSeenAt).toBeNull();
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
  });

  it('leaves a named app unshared when a level write fails partway, then shares it next boot', async () => {
    const harness = levelHarness();
    addConnection(harness, 'connection-b');
    const config = fakeConfig();
    type WithWriteLevel = { writeLevel: (...args: unknown[]) => void };
    const proto = TrustedConnectionSharing.prototype as unknown as WithWriteLevel;
    const original = proto.writeLevel;
    let writes = 0;
    const writeLevel = vi.spyOn(proto, 'writeLevel').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      writes += 1;
      if (writes === 2) throw new Error('The database refused the write.');
      return original.apply(this, args);
    });

    try {
      await runOnce(harness, config);
    } finally {
      writeLevel.mockRestore();
    }

    // Named, but the level transaction rolled back whole: no level, so the
    // notice (which lists by level) leaves both out, and nothing is stamped.
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID, 'connection-b']);
    expect(storedLevels(harness.db)).toEqual([]);
    expect(everyAgentLevel(harness.db, CONNECTION_ID)).toBeNull();
    expect(config.permissions().sharedAppsAppliedAt).toBeNull();

    await runOnce(harness, config);

    expect(storedLevels(harness.db)).toEqual(['every_agent:read-write', 'every_agent:read-write']);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID, 'connection-b']);
    expect(config.permissions().sharedAppsAppliedAt).toBe(NOW.toISOString());
  });

  it('is safe to repeat until stamped: a shared app is not shared twice', async () => {
    const harness = levelHarness();
    const config = fakeConfig();
    const sharing = sharingFor(harness, config);
    const follow = vi.spyOn(sharing, 'follow').mockResolvedValue();

    await sharing.upgradeStep().run();
    await sharing.upgradeStep().run();

    expect(follow).toHaveBeenCalledTimes(1);
    expect(config.permissions().sharedAtUpgrade).toEqual([CONNECTION_ID]);
  });
});
