import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfigManager, configManager } from '../../config-manager.js';
import { CloudLinkManager, initCloudLinkManager, getCloudLinkManager } from '../cloud-link.js';
import {
  DEVICE_TOKEN_REQUEST_TIMEOUT_MS,
  linkProofForKey,
  ManagedConnectorCloudError,
} from '../cloud-link-client.js';
import { logger } from '../../../../lib/logger.js';

/** Immediate, deterministic sleep so the background poll settles synchronously. */
const noSleep = async (): Promise<void> => {};

type Step = { status: number; body: unknown };

/** A fetch that routes by cloud endpoint path, returning per-endpoint canned responses. */
function routerFetch(handlers: {
  code?: () => Step;
  token?: () => Step;
  heartbeat?: () => Step;
  revoke?: () => Step;
  authority?: () => Step;
  execution?: () => Step;
  usage?: () => Step;
  authentication?: () => Step;
}) {
  return vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    let step: Step | undefined;
    if (p.endsWith('/device/code')) step = handlers.code?.();
    else if (p.endsWith('/device/token')) step = handlers.token?.();
    else if (p.endsWith('/instances/heartbeat')) step = handlers.heartbeat?.();
    else if (p.endsWith('/instances/revoke')) step = handlers.revoke?.();
    else if (p.includes('/instances/connectors/authority-commands')) {
      step = handlers.authority?.();
    } else if (p.includes('/instances/connectors/executions')) {
      step = handlers.execution?.();
    } else if (p.includes('/instances/connectors/usage')) {
      step = handlers.usage?.();
    } else if (p.endsWith('/instances/connectors/authentication-flows')) {
      step = handlers.authentication?.();
    }
    if (!step) throw new Error(`unexpected request: ${p}`);
    return new Response(JSON.stringify(step.body), { status: step.status });
  });
}

const CODES: Step = {
  status: 200,
  body: {
    device_code: 'dev-123',
    user_code: 'ABCD1234',
    verification_uri: 'https://dorkos.ai/activate',
    verification_uri_complete: 'https://dorkos.ai/activate?user_code=ABCD1234',
    expires_in: 1800,
    interval: 5,
  },
};

describe('CloudLinkManager', () => {
  let tmpDir: string;
  let manager: CloudLinkManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cloud-link-'));
    initConfigManager(tmpDir);
  });

  afterEach(() => {
    manager?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

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

  it('surfaces denial as a distinct state without storing a token', async () => {
    manager = new CloudLinkManager({
      fetchImpl: routerFetch({
        code: () => CODES,
        token: () => ({ status: 400, body: { error: 'access_denied' } }),
      }),
      sleep: noSleep,
    });
    await manager.startLink();
    await manager.pendingLink;
    expect(manager.getStatus().state).toBe('denied');
    expect(configManager.getDot('cloud.instanceToken')).toBeNull();
  });

  it('surfaces expiry as a distinct state without storing a token', async () => {
    manager = new CloudLinkManager({
      fetchImpl: routerFetch({
        code: () => CODES,
        token: () => ({ status: 400, body: { error: 'expired_token' } }),
      }),
      sleep: noSleep,
    });
    await manager.startLink();
    await manager.pendingLink;
    expect(manager.getStatus().state).toBe('expired');
    expect(configManager.getDot('cloud.instanceToken')).toBeNull();
  });

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

  describe('keeping the dropped key so a new link can continue the old one (DOR-2521)', () => {
    const LINKED = {
      instanceToken: 'dork_inst_old',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
      previousLinkProof: null,
    };
    const OLD_PROOF = linkProofForKey('dork_inst_old');

    /** The parsed device-code `scope` of the first link request `fetchImpl` saw. */
    const scopeOf = (fetchImpl: ReturnType<typeof routerFetch>) => {
      const call = fetchImpl.mock.calls.find((c) => (c[0] as string).endsWith('/device/code'));
      const body = JSON.parse((call?.[1] as RequestInit).body as string);
      return JSON.parse(body.scope) as Record<string, unknown>;
    };

    it('keeps a proof of the key, never the key, when the person unlinks', async () => {
      configManager.set('cloud', LINKED);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ revoke: () => ({ status: 200, body: {} }) }),
        sleep: noSleep,
      });

      await manager.unlink();

      expect(configManager.get('cloud')).toEqual({
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof: OLD_PROOF,
      });
      expect(JSON.stringify(configManager.getAll())).not.toContain('dork_inst_old');
    });

    it('keeps a proof of the key when the cloud refuses it (401)', async () => {
      configManager.set('cloud', LINKED);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ heartbeat: () => ({ status: 401, body: {} }) }),
        sleep: noSleep,
      });

      await manager.initOnStartup();

      expect(manager.getStatus().state).toBe('unlinked');
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(configManager.getDot('cloud.previousLinkProof')).toBe(OLD_PROOF);
    });

    it('does not wipe a kept proof when unlinking with no key held', async () => {
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof: 'kept-proof',
      });
      const fetchImpl = routerFetch({});
      manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

      await manager.unlink();

      expect(configManager.getDot('cloud.previousLinkProof')).toBe('kept-proof');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends the kept proof with the next link and drops it once the new key is saved', async () => {
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof: OLD_PROOF,
      });
      const fetchImpl = routerFetch({
        code: () => CODES,
        token: () => ({ status: 200, body: { access_token: 'dork_inst_new' } }),
        heartbeat: () => ({
          status: 200,
          body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' },
        }),
      });
      manager = new CloudLinkManager({
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });

      await manager.startLink();
      await manager.pendingLink;

      expect(scopeOf(fetchImpl).previousLinkProof).toBe(OLD_PROOF);
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_new');
      expect(configManager.getDot('cloud.previousLinkProof')).toBeNull();
    });

    it('keeps the proof when the new link is denied, so the next try still sends it', async () => {
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof: OLD_PROOF,
      });
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error: 'access_denied' } }),
        }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });

      await manager.startLink();
      await manager.pendingLink;

      expect(configManager.getDot('cloud.previousLinkProof')).toBe(OLD_PROOF);
    });

    it('sends the proof of the key held right now when re-linking while linked', async () => {
      configManager.set('cloud', { ...LINKED, previousLinkProof: 'stale-proof' });
      const fetchImpl = routerFetch({
        code: () => CODES,
        token: () => ({ status: 400, body: { error: 'expired_token' } }),
      });
      manager = new CloudLinkManager({
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });

      await manager.startLink();
      await manager.pendingLink;

      expect(scopeOf(fetchImpl).previousLinkProof).toBe(OLD_PROOF);
    });

    it('sends no proof on a first link, including from a config written before the field', async () => {
      // A pre-DOR-2521 config: the `cloud` section carries no previousLinkProof leaf.
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')),
          cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
        })
      );
      initConfigManager(tmpDir);
      const fetchImpl = routerFetch({
        code: () => CODES,
        token: () => ({ status: 400, body: { error: 'expired_token' } }),
      });
      manager = new CloudLinkManager({
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });

      await manager.startLink();
      await manager.pendingLink;

      expect('previousLinkProof' in scopeOf(fetchImpl)).toBe(false);
    });
  });

  describe('a relink that does not finish while this computer is still linked', () => {
    const HELD = {
      instanceToken: 'dork_inst_held',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
      previousLinkProof: null,
    };

    it.each([
      ['denied', { status: 400, body: { error: 'access_denied' } }],
      ['expired', { status: 400, body: { error: 'expired_token' } }],
      ['failed', { status: 500, body: {} }],
    ] as const)('goes straight back to linked when the relink ends %s', async (outcome, step) => {
      configManager.set('cloud', HELD);
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ code: () => CODES, token: () => step }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      expect(manager.getStatus().state).toBe('pending');
      await manager.pendingLink;
      expect(manager.getStatus()).toMatchObject({ state: 'linked', relinkOutcome: outcome });
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
    });

    it('still ends denied or expired on a computer with no link to keep', async () => {
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error: 'access_denied' } }),
        }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().state).toBe('denied');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('cancels a pending relink back to linked, and clears the note', async () => {
      configManager.set('cloud', HELD);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          code: () => CODES,
          token: () => ({ status: 400, body: { error: 'expired_token' } }),
        }),
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().relinkOutcome).toBe('expired');
      await manager.cancelLink();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    /**
     * A cloud whose first token answer arrives only when the test says so.
     * At token exchange the cloud issues the new key and retires the old one,
     * so an answer that was already on its way must never be thrown away.
     * Later token polls answer `expired_token`.
     */
    function exchangeOnCue(answer: 'approved' | 'denied') {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let tokenCalls = 0;
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        void init;
        const p = new URL(url).pathname;
        if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
        if (p.endsWith('/device/token')) {
          tokenCalls += 1;
          if (tokenCalls > 1) {
            return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
          }
          await released;
          return answer === 'approved'
            ? new Response(JSON.stringify({ access_token: 'dork_inst_new' }))
            : new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 });
        }
        if (p.endsWith('/instances/heartbeat')) {
          return new Response(
            JSON.stringify({ ok: true, instanceId: 'i', lastSeenAt: '2026-09-30T00:00:00Z' })
          );
        }
        if (p.endsWith('/instances/revoke')) return new Response(JSON.stringify({ ok: true }));
        throw new Error(`unexpected request: ${p}`);
      });
      const exchanging = () => vi.waitFor(() => expect(tokenCalls).toBeGreaterThanOrEqual(1));
      return { fetchImpl, release, exchanging };
    }

    function managerWith(fetchImpl: ReturnType<typeof vi.fn>, sleep = noSleep) {
      return new CloudLinkManager({
        fetchImpl: fetchImpl as never,
        sleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
    }

    it.each([
      ['held', 'approved', 'dork_inst_new', 'linked'],
      ['held', 'denied', 'dork_inst_held', 'linked'],
      ['none', 'approved', 'dork_inst_new', 'linked'],
      ['none', 'denied', null, 'idle'],
    ] as const)(
      'a cancel with a key %s while an exchange is in flight keeps an %s answer honest',
      async (key, answer, token, state) => {
        if (key === 'held') configManager.set('cloud', HELD);
        const cloud = exchangeOnCue(answer);
        manager = managerWith(cloud.fetchImpl);
        await manager.startLink();
        await cloud.exchanging();
        let cancelled = false;
        const cancelling = manager.cancelLink().then((status) => {
          cancelled = true;
          return status;
        });
        await Promise.resolve();
        // The cancel waits for the answer already on its way.
        expect(cancelled).toBe(false);
        cloud.release();
        const status = await cancelling;
        expect(configManager.getDot('cloud.instanceToken')).toBe(token);
        expect(status.state).toBe(state);
        expect(status.relinkOutcome).toBeUndefined();
        expect(manager.getStatus()).toEqual(status);
      }
    );

    it('cancels at once between polls, without sending a token request', async () => {
      configManager.set('cloud', HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl, () => new Promise<void>(() => {}));
      await manager.startLink();
      const status = await manager.cancelLink();
      expect(status.state).toBe('linked');
      expect(cloud.fetchImpl.mock.calls.some((c) => String(c[0]).endsWith('/device/token'))).toBe(
        false
      );
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
    });

    it('keeps a key issued while Link again restarts the flow, and proves the new key next', async () => {
      configManager.set('cloud', HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl);
      await manager.startLink();
      await cloud.exchanging();
      const restarting = manager.startLink();
      cloud.release();
      await restarting;
      await manager.pendingLink;
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_new');
      const codeCalls = cloud.fetchImpl.mock.calls.filter((c) =>
        String(c[0]).endsWith('/device/code')
      );
      expect(codeCalls).toHaveLength(2);
      const secondScope = JSON.parse(
        JSON.parse((codeCalls[1]![1] as RequestInit).body as string).scope
      ) as Record<string, unknown>;
      expect(secondScope.previousLinkProof).toBe(linkProofForKey('dork_inst_new'));
    });

    it('withdraws locally at once on unlink, then clears and revokes a key issued meanwhile', async () => {
      configManager.set('cloud', HELD);
      const cloud = exchangeOnCue('approved');
      manager = managerWith(cloud.fetchImpl);
      await manager.startLink();
      await cloud.exchanging();
      const unlinking = manager.unlink();
      // Withdrawn before any await: the held key is gone and nothing waits on the exchange.
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(manager.getStatus().state).toBe('idle');
      cloud.release();
      await unlinking;
      await manager.pendingLink;
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(manager.getStatus().state).toBe('idle');
      const revoked = cloud.fetchImpl.mock.calls
        .filter((c) => String(c[0]).endsWith('/instances/revoke'))
        .map((c) => ((c[1] as RequestInit).headers as Record<string, string>).authorization);
      expect(revoked).toEqual(['Bearer dork_inst_held', 'Bearer dork_inst_new']);
    });

    it.each(['cancelLink', 'startLink'] as const)(
      'lets %s finish within the token request bound when the request hangs',
      async (action) => {
        vi.useFakeTimers();
        try {
          configManager.set('cloud', HELD);
          let tokenRequests = 0;
          const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            const p = new URL(url).pathname;
            if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
            if (p.endsWith('/device/token')) {
              tokenRequests += 1;
              if (tokenRequests > 1) {
                return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
              }
              // Hangs until its own signal gives up on it.
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              });
            }
            throw new Error(`unexpected request: ${p}`);
          });
          manager = managerWith(fetchImpl);
          await manager.startLink();
          for (let i = 0; i < 20 && tokenRequests === 0; i++) await vi.advanceTimersByTimeAsync(0);
          expect(tokenRequests).toBe(1);
          let settled = false;
          const acting = (
            action === 'cancelLink' ? manager.cancelLink() : manager.startLink()
          ).then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(DEVICE_TOKEN_REQUEST_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await acting;
          expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it.each([200, 400])(
      'bounds the token request body too, when a %i arrives and its body stalls',
      async (status) => {
        vi.useFakeTimers();
        try {
          configManager.set('cloud', HELD);
          let tokenRequests = 0;
          const fetchImpl = vi.fn(async (url: string) => {
            const p = new URL(url).pathname;
            if (p.endsWith('/device/code')) return new Response(JSON.stringify(CODES.body));
            if (p.endsWith('/device/token')) {
              tokenRequests += 1;
              if (tokenRequests > 1) {
                return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
              }
              // Headers now, then a body that never ends and ignores every signal.
              return new Response(new ReadableStream({ start() {} }), { status });
            }
            throw new Error(`unexpected request: ${p}`);
          });
          manager = managerWith(fetchImpl);
          await manager.startLink();
          for (let i = 0; i < 20 && tokenRequests === 0; i++) await vi.advanceTimersByTimeAsync(0);
          expect(tokenRequests).toBe(1);
          let settled = false;
          const cancelling = manager.cancelLink().then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(DEVICE_TOKEN_REQUEST_TIMEOUT_MS - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).toBe(true);
          await cancelling;
          expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_held');
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it('keeps a key issued after stop, but starts nothing for it', async () => {
      vi.useFakeTimers();
      try {
        const cloud = exchangeOnCue('approved');
        manager = new CloudLinkManager({
          fetchImpl: cloud.fetchImpl as never,
          sleep: noSleep,
          heartbeatIntervalMs: 1_000,
          resolveTelemetryInstanceId: async () => undefined,
        });
        const sync = vi.fn(async () => {});
        manager.setManagedProviderSync(sync);
        await manager.startLink();
        await vi.advanceTimersByTimeAsync(0);
        expect(cloud.fetchImpl.mock.calls.some((c) => String(c[0]).endsWith('/device/token'))).toBe(
          true
        );
        const poll = manager.pendingLink;
        manager.stop();
        cloud.release();
        await poll;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_new');
        expect(sync).not.toHaveBeenCalled();
        expect(
          cloud.fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/instances/heartbeat'))
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the note a relink left is cleared whenever the link changes', () => {
    const HELD = {
      instanceToken: 'dork_inst_held',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
      previousLinkProof: null,
    };
    const OK_HEARTBEAT: Step = {
      status: 200,
      body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-09-30T00:00:00Z' },
    };

    /** Leave a `denied` note on a computer that keeps its key. */
    async function deniedRelink(extra: Parameters<typeof routerFetch>[0] = {}) {
      configManager.set('cloud', HELD);
      let token: Step = { status: 400, body: { error: 'access_denied' } };
      const fetchImpl = routerFetch({
        code: () => CODES,
        token: () => token,
        heartbeat: () => OK_HEARTBEAT,
        revoke: () => ({ status: 200, body: { ok: true } }),
        ...extra,
      });
      manager = new CloudLinkManager({
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().relinkOutcome).toBe('denied');
      return {
        approveNext: () => {
          token = { status: 200, body: { access_token: 'dork_inst_new' } };
        },
      };
    }

    it('drops the note when a new link is started and approved', async () => {
      const { approveNext } = await deniedRelink();
      approveNext();
      await manager.startLink();
      await manager.pendingLink;
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note when a new link is started, even if that start fails', async () => {
      let codeRequests = 0;
      await deniedRelink({
        code: () => (++codeRequests === 1 ? CODES : { status: 502, body: {} }),
      });
      await expect(manager.startLink()).rejects.toThrow();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note on unlink, so a later link starts clean', async () => {
      await deniedRelink();
      await manager.unlink();
      configManager.set('cloud', HELD);
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });

    it('drops the note when the key is refused, so a later link starts clean', async () => {
      let heartbeat: Step = { status: 401, body: {} };
      await deniedRelink({ heartbeat: () => heartbeat });
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('unlinked');
      heartbeat = OK_HEARTBEAT;
      configManager.set('cloud', HELD);
      await manager.initOnStartup();
      expect(manager.getStatus().state).toBe('linked');
      expect(manager.getStatus().relinkOutcome).toBeUndefined();
    });
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

// The keystone honesty proof for the accessor-pair construction seam
// (spec `capture-cloud-link-stub` §Testing Strategy — "Seam construction unit").
// Separate top-level describe: it drives the module-level `init/getCloudLinkManager`
// singleton directly (not `new CloudLinkManager()` per-test like the suite above).
describe('cloud-link construction seam (init/getCloudLinkManager)', () => {
  let tmpDir: string;
  let manager: CloudLinkManager | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cloud-link-seam-'));
    initConfigManager(tmpDir);
  });

  afterEach(() => {
    manager?.stop();
    manager = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prod-default construction (no fetchImpl) drives startLink() through the real globalThis.fetch, never a fake', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const p = new URL(String(input)).pathname;
      if (p.endsWith('/device/code')) {
        return new Response(JSON.stringify(CODES.body), { status: 200 });
      }
      if (p.endsWith('/device/token')) {
        return new Response(JSON.stringify({ access_token: 'seam-test-token' }), { status: 200 });
      }
      if (p.endsWith('/instances/heartbeat')) {
        return new Response(
          JSON.stringify({ ok: true, instanceId: 'seam-inst', lastSeenAt: '2026-07-17T00:00:00Z' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected request: ${p}`);
    });

    // No fetchImpl passed — proves the prod default is byte-for-byte the real fetch.
    manager = initCloudLinkManager({ sleep: noSleep });
    expect(getCloudLinkManager()).toBe(manager);

    await manager.startLink();
    await manager.pendingLink;

    expect(fetchSpy).toHaveBeenCalled();
    expect(manager.getStatus().state).toBe('linked');
  });

  it('an injected fetchImpl at construction is used instead of the real fetch — the seam is injectable', async () => {
    const realFetchSpy = vi.spyOn(globalThis, 'fetch');
    const injected = routerFetch({
      code: () => CODES,
      token: () => ({ status: 200, body: { access_token: 'dork_inst_seam' } }),
      heartbeat: () => ({
        status: 200,
        body: { ok: true, instanceId: 'inst-seam', lastSeenAt: '2026-07-17T00:00:00Z' },
      }),
    });

    manager = initCloudLinkManager({ fetchImpl: injected, sleep: noSleep });
    expect(getCloudLinkManager()).toBe(manager);

    await manager.startLink();
    await manager.pendingLink;

    expect(injected).toHaveBeenCalled();
    expect(realFetchSpy).not.toHaveBeenCalled();
    expect(manager.getStatus().state).toBe('linked');
  });

  it('getCloudLinkManager() before any initCloudLinkManager() call throws a loud, helpful error — not a silent undefined deref', async () => {
    // instance is module-level singleton state that leaks across test files/cases
    // via the statically-imported bindings above, so reset modules and re-import
    // fresh to observe the pre-init state.
    vi.resetModules();
    const fresh = await import('../cloud-link.js');
    expect(() => fresh.getCloudLinkManager()).toThrow('CloudLinkManager not initialized');
  });
});
