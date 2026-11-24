import { describe, it, expect, vi } from 'vitest';
import { configManager } from '../../config-manager.js';
import { CloudLinkManager } from '../cloud-link.js';
import { ManagedConnectorCloudError } from '../cloud-link-client.js';
import { logger } from '../../../../lib/logger.js';
import {
  noSleep,
  routerFetch,
  CODES,
  useCloudLinkSandbox,
} from './cloud-link/cloud-link.fixtures.js';

describe('CloudLinkManager', () => {
  let manager: CloudLinkManager;
  useCloudLinkSandbox('dorkos-cloud-link-', () => manager?.stop());

  it('stores the token and fires a heartbeat on approval', async () => {
    const fetchImpl = routerFetch({
      code: () => CODES,
      token: () => ({ status: 200, body: { access_token: 'dork_inst_live' } }),
      heartbeat: () => ({
        status: 200,
        body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' },
      }),
    });
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

    const start = await manager.startLink();
    expect(start.userCode).toBe('ABCD1234');
    expect(start.verificationUri).toContain('/activate');
    expect(typeof start.expiresAt).toBe('string');

    await manager.pendingLink;

    expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_live');
    expect(configManager.getDot('cloud.instanceName')).toBeTruthy();
    expect(manager.getStatus().state).toBe('linked');
    expect(manager.getStatus().lastHeartbeatAt).toBe('2026-07-03T00:00:00Z');
    expect(manager.getSummary()).toMatchObject({
      linked: true,
      lastHeartbeatAt: '2026-07-03T00:00:00Z',
    });

    const paths = fetchImpl.mock.calls.map((c) => new URL(c[0] as string).pathname);
    expect(paths).toContain('/api/instances/heartbeat');
  });

  it('reports the code waiting for approval, then the code whose approval linked it', async () => {
    let released = false;
    const approve = () => (released = true);
    const fetchImpl = routerFetch({
      code: () => CODES,
      token: () =>
        released
          ? { status: 200, body: { access_token: 'dork_inst_live' } }
          : { status: 400, body: { error: 'authorization_pending' } },
      heartbeat: () => ({
        status: 200,
        body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' },
      }),
    });
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

    const start = await manager.startLink();
    expect(manager.getStatus()).toMatchObject({ state: 'pending', pending: start });
    expect(manager.getStatus().approvedCode).toBeUndefined();

    approve();
    await manager.pendingLink;
    expect(manager.getStatus()).toMatchObject({ state: 'linked', approvedCode: 'ABCD1234' });
    expect(manager.getStatus().pending).toBeUndefined();

    await manager.unlink();
    expect(manager.getStatus().approvedCode).toBeUndefined();
  });

  it('reconciles managed provider registration on link and unlink without exposing key material', async () => {
    const fetchImpl = routerFetch({
      code: () => CODES,
      token: () => ({ status: 200, body: { access_token: 'dork_inst_managed' } }),
      heartbeat: () => ({
        status: 200,
        body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' },
      }),
      revoke: () => ({ status: 200, body: { ok: true } }),
    });
    const sync = vi.fn(async () => {});
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });
    manager.setManagedProviderSync(sync);

    expect(manager.managedConnectorMaterialDigest()).toBeUndefined();
    await manager.startLink();
    await manager.pendingLink;
    const digest = manager.managedConnectorMaterialDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain('dork_inst_managed');
    expect(sync).toHaveBeenCalledTimes(1);

    await manager.unlink();
    expect(manager.managedConnectorMaterialDigest()).toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('runs the new-link step on an approved link only, never at startup (ADR 261001-000811)', async () => {
    const fetchImpl = routerFetch({
      code: () => CODES,
      token: () => ({ status: 200, body: { access_token: 'dork_inst_new' } }),
      heartbeat: () => ({
        status: 200,
        body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' },
      }),
    });
    const onNewLink = vi.fn(async () => {});
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });
    manager.setOnNewLink(onNewLink);

    await manager.startLink();
    await manager.pendingLink;
    expect(onNewLink).toHaveBeenCalledTimes(1);

    // A restart of an already-linked computer is not a new link: the credits
    // defaults must never fill gaps on a link made before they existed.
    manager.stop();
    const restarted = new CloudLinkManager({ fetchImpl, sleep: noSleep });
    restarted.setOnNewLink(onNewLink);
    await restarted.initOnStartup();
    expect(onNewLink).toHaveBeenCalledTimes(1);

    // "Link again" from an already-linked computer is an approval too: the
    // step runs, and it tells a relink to the same account from another.
    await restarted.startLink();
    await restarted.pendingLink;
    expect(onNewLink).toHaveBeenCalledTimes(2);
    restarted.stop();
  });

  it('preserves an old linked key on permission upgrade and clears an invalid key', async () => {
    const config = {
      token: 'old-key' as string | null,
      getToken() {
        return this.token;
      },
      getAccountLabel: () => null,
      getPreviousLinkProof: () => null,
      save: vi.fn(),
      setAccountLabel: vi.fn(),
      clear() {
        this.token = null;
      },
    };
    const command = {
      version: 1,
      commandId: 'command-a',
      managedConnectionId: 'managed-a',
      scopeVersion: 1,
      kind: 'set_connection_lifecycle',
      lifecycle: 'paused',
    } as const;
    manager = new CloudLinkManager({
      config,
      fetchImpl: routerFetch({
        authority: () => ({
          status: 403,
          body: { error: 'permission_upgrade_required' },
        }),
      }),
    });

    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'permission_upgrade_required',
    });
    expect(config.token).toBe('old-key');

    manager = new CloudLinkManager({
      config,
      // The heartbeat, the authoritative key check, refuses the key too.
      fetchImpl: routerFetch({
        authority: () => ({ status: 401, body: {} }),
        heartbeat: () => ({ status: 401, body: {} }),
      }),
    });
    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(config.token).toBeNull();
  });

  it('observes authoritative execution and recovery receipts without blocking the response', async () => {
    const receipt = {
      version: 1,
      receiptId: 'receipt-a',
      logicalOperationId: 'logical-a',
      attemptId: 'attempt-a',
      attemptIndex: 1,
      outcome: 'success',
      completedAt: '2026-09-06T12:00:01.000Z',
      recordedAt: '2026-09-06T12:00:02.000Z',
    } as const;
    const observeManagedReceipt = vi
      .fn()
      .mockRejectedValueOnce(new Error('mirror busy'))
      .mockResolvedValueOnce(undefined);
    manager = new CloudLinkManager({
      config: {
        getToken: () => 'linked-key',
        getAccountLabel: () => null,
        getPreviousLinkProof: () => null,
        save: vi.fn(),
        setAccountLabel: vi.fn(),
        clear: vi.fn(),
      },
      observeManagedReceipt,
      fetchImpl: routerFetch({
        execution: () => ({
          status: 200,
          body: {
            state: 'receipt_only',
            receipt,
          },
        }),
      }),
    });
    const request = {
      version: 1,
      logicalOperationId: 'logical-a',
      attemptId: 'attempt-a',
      attemptIndex: 1,
      managedConnectionId: 'managed-a',
      agentId: 'agent-a',
      grantScopeVersion: 1,
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a' },
      revision: {
        hostedRevisionId: '11111111-1111-4111-8111-111111111111',
        operationSlug: 'gmail.send',
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:revision-a',
      },
      arguments: { message: 'hello' },
    } as const;

    await expect(
      manager.executeManagedConnectorOperation(request, new AbortController().signal)
    ).resolves.toMatchObject({ state: 'receipt_only', receipt });
    expect(observeManagedReceipt).toHaveBeenCalledWith(receipt);

    manager = new CloudLinkManager({
      config: {
        getToken: () => 'linked-key',
        getAccountLabel: () => null,
        getPreviousLinkProof: () => null,
        save: vi.fn(),
        setAccountLabel: vi.fn(),
        clear: vi.fn(),
      },
      observeManagedReceipt,
      fetchImpl: routerFetch({
        execution: () => ({ status: 200, body: { state: 'recorded', receipt } }),
      }),
    });
    await expect(
      manager.getManagedConnectorExecutionReceipt('attempt-a', new AbortController().signal)
    ).resolves.toMatchObject({ state: 'recorded', receipt });
    expect(observeManagedReceipt).toHaveBeenCalledTimes(2);
  });

  it('threads the telemetry instance id into the device-code scope only when the resolver returns one', async () => {
    // Helper: pull the parsed `scope` object from the /device/code POST body.
    const scopeOf = (fetchImpl: ReturnType<typeof routerFetch>) => {
      const call = fetchImpl.mock.calls.find((c) => (c[0] as string).endsWith('/device/code'));
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      return JSON.parse(body.scope) as Record<string, unknown>;
    };

    // Opted in: the resolver returns an id, so the scope carries it (the merge signal).
    const withFetch = routerFetch({
      code: () => CODES,
      token: () => ({ status: 400, body: { error: 'expired_token' } }),
    });
    const withManager = new CloudLinkManager({
      fetchImpl: withFetch,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => 'inst-uuid-optin',
    });
    await withManager.startLink();
    await withManager.pendingLink;
    withManager.stop();
    expect(scopeOf(withFetch).telemetryInstanceId).toBe('inst-uuid-optin');

    // Not opted in: the resolver returns undefined, so the scope omits the id.
    const withoutFetch = routerFetch({
      code: () => CODES,
      token: () => ({ status: 400, body: { error: 'expired_token' } }),
    });
    manager = new CloudLinkManager({
      fetchImpl: withoutFetch,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    await manager.startLink();
    await manager.pendingLink;
    expect('telemetryInstanceId' in scopeOf(withoutFetch)).toBe(false);
  });

  it('persists the account label the heartbeat reports', async () => {
    const fetchImpl = routerFetch({
      code: () => CODES,
      token: () => ({ status: 200, body: { access_token: 'dork_inst_live' } }),
      heartbeat: () => ({
        status: 200,
        body: {
          ok: true,
          instanceId: 'inst-1',
          lastSeenAt: '2026-07-03T00:00:00Z',
          accountLabel: 'owner@dork.test',
        },
      }),
    });
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

    await manager.startLink();
    await manager.pendingLink;

    expect(configManager.getDot('cloud.linkedAccountLabel')).toBe('owner@dork.test');
    expect(manager.getSummary().accountLabel).toBe('owner@dork.test');
  });

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const)(
    'surfaces %s as the distinct state %s without storing a token',
    async (error, state) => {
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error } }),
        }),
        sleep: noSleep,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().state).toBe(state);
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
    }
  );

  it('marks unlinked and clears the token when a startup heartbeat 401s', async () => {
    // Pre-link this instance, then simulate the cloud having revoked the key.
    configManager.set('cloud', {
      instanceToken: 'dork_inst_dead',
      instanceName: 'kai-mbp',
      linkedAccountLabel: null,
    });
    manager = new CloudLinkManager({
      fetchImpl: routerFetch({ heartbeat: () => ({ status: 401, body: {} }) }),
      sleep: noSleep,
    });

    await manager.initOnStartup();

    expect(manager.getStatus().state).toBe('unlinked');
    expect(configManager.getDot('cloud.instanceToken')).toBeNull();
    expect(manager.getSummary().linked).toBe(false);
  });

  it('unlink best-effort-revokes then clears local state and returns to idle', async () => {
    configManager.set('cloud', {
      instanceToken: 'dork_inst_live',
      instanceName: 'kai-mbp',
      linkedAccountLabel: null,
    });
    const fetchImpl = routerFetch({ revoke: () => ({ status: 200, body: { ok: true } }) });
    manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

    await manager.unlink();

    expect(configManager.getDot('cloud.instanceToken')).toBeNull();
    expect(manager.getStatus().state).toBe('idle');
    const paths = fetchImpl.mock.calls.map((c) => new URL(c[0] as string).pathname);
    expect(paths).toContain('/api/instances/revoke');
  });

  it('names the cloud code and status when managed provider registration fails', async () => {
    configManager.set('cloud', {
      instanceToken: 'linked-key',
      instanceName: 'kai-mbp',
      linkedAccountLabel: null,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    manager = new CloudLinkManager({
      fetchImpl: routerFetch({ revoke: () => ({ status: 200, body: { ok: true } }) }),
      sleep: noSleep,
    });
    manager.setManagedProviderSync(async () => {
      throw new ManagedConnectorCloudError('unavailable', { status: 503 });
    });
    await manager.unlink();
    expect(warn).toHaveBeenCalledWith(
      '[CloudLink] Managed provider registration failed',
      expect.objectContaining({ code: 'unavailable', status: 503 })
    );
  });

  it('logs only closed managed authentication failure details and rethrows unchanged', async () => {
    const token = 'SECRET_INSTANCE_TOKEN';
    const privateBody = 'SECRET_HOSTED_BODY';
    configManager.set('cloud', {
      instanceToken: token,
      instanceName: 'kai-mbp',
      linkedAccountLabel: null,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    manager = new CloudLinkManager({
      fetchImpl: routerFetch({
        authentication: () => ({ status: 503, body: { privateBody } }),
      }),
      sleep: noSleep,
    });

    const failure = await manager
      .startManagedConnectorAuthentication(
        { version: 1, requestId: 'request-a', toolkit: 'gmail' },
        new AbortController().signal
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'unavailable', status: 503 });
    expect(warn).toHaveBeenCalledWith('[CloudLink] Managed authentication start did not complete', {
      code: 'unavailable',
      status: 503,
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(privateBody);

    warn.mockClear();
    const privateCause = 'SECRET_NETWORK_CAUSE';
    manager = new CloudLinkManager({
      fetchImpl: vi.fn(async () => {
        throw new Error(privateCause);
      }),
      sleep: noSleep,
    });
    await expect(
      manager.startManagedConnectorAuthentication(
        { version: 1, requestId: 'request-network', toolkit: 'gmail' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'network_error', status: undefined });
    expect(warn).toHaveBeenCalledWith('[CloudLink] Managed authentication start did not complete', {
      code: 'network_error',
      status: undefined,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateCause);

    warn.mockClear();
    const arbitrarySecret = new Error('SECRET_ARBITRARY_CAUSE');
    const aborted = new AbortController();
    aborted.abort(arbitrarySecret);
    manager = new CloudLinkManager({
      fetchImpl: vi.fn(async () => {
        throw arbitrarySecret;
      }),
      sleep: noSleep,
    });
    await expect(
      manager.startManagedConnectorAuthentication(
        { version: 1, requestId: 'request-b', toolkit: 'gmail' },
        aborted.signal
      )
    ).rejects.toBe(arbitrarySecret);
    expect(warn).not.toHaveBeenCalled();
  });
});
