import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRemoteAccessSettings } from '@dorkos/shared/config-schema';
import { initConfigManager, configManager } from '../../../config-manager.js';
import { CloudLinkManager, initCloudLinkManager, getCloudLinkManager } from '../../cloud-link.js';
import { linkProofForKey } from '../../cloud-link-client.js';
import {
  noSleep,
  routerFetch,
  CODES,
  useCloudLinkSandbox,
  setCloud,
} from './cloud-link.fixtures.js';

describe('CloudLinkManager', () => {
  let manager: CloudLinkManager;
  const sandbox = useCloudLinkSandbox('dorkos-cloud-link-', () => manager?.stop());

  describe('checking the link now, after the account may have gone elsewhere (DOR-2651)', () => {
    const linked = () =>
      setCloud({
        instanceToken: 'dork_inst_live',
        instanceName: 'kai-mbp',
        linkedAccountLabel: null,
      });

    it('unlinks and clears the key when the account no longer accepts it', async () => {
      linked();
      const fetchImpl = routerFetch({ heartbeat: () => ({ status: 401, body: {} }) });
      manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

      const summary = await manager.checkLink();

      expect(summary).toEqual({ linked: false, accountLabel: null, lastHeartbeatAt: null });
      expect(configManager.getDot('cloud.instanceToken')).toBeNull();
      expect(manager.getStatus().state).toBe('unlinked');
      const paths = fetchImpl.mock.calls.map((c) => new URL(c[0] as string).pathname);
      expect(paths).toEqual(['/api/instances/heartbeat']);
    });

    it('keeps the link, and records the heartbeat, when the account still accepts it', async () => {
      linked();
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({
          heartbeat: () => ({
            status: 200,
            body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-10-01T00:00:00Z' },
          }),
        }),
        sleep: noSleep,
      });

      const summary = await manager.checkLink();

      expect(summary).toMatchObject({ linked: true, lastHeartbeatAt: '2026-10-01T00:00:00Z' });
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_live');
    });

    it('keeps the key when the account cannot be reached', async () => {
      linked();
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ heartbeat: () => ({ status: 503, body: {} }) }),
        sleep: noSleep,
      });

      expect((await manager.checkLink()).linked).toBe(true);
      expect(configManager.getDot('cloud.instanceToken')).toBe('dork_inst_live');
    });

    it('asks nothing while this computer holds no key', async () => {
      const fetchImpl = routerFetch({});
      manager = new CloudLinkManager({ fetchImpl, sleep: noSleep });

      expect((await manager.checkLink()).linked).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('shares one heartbeat between checks that overlap, and reuses its answer briefly', async () => {
      linked();
      const fetchImpl = routerFetch({
        heartbeat: () => ({
          status: 200,
          body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-10-01T00:00:00Z' },
        }),
      });
      let clock = 1_000_000;
      manager = new CloudLinkManager({ fetchImpl, sleep: noSleep, now: () => clock });

      const [first, second] = await Promise.all([manager.checkLink(), manager.checkLink()]);

      expect(first).toEqual(second);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Inside the reuse window: the last answer, with no new heartbeat.
      clock += 14_999;
      expect(await manager.checkLink()).toEqual(first);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Past it: the account is asked again.
      clock += 1;
      await manager.checkLink();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never reuses an answer given for a different key', async () => {
      linked();
      const fetchImpl = routerFetch({
        heartbeat: () => ({
          status: 200,
          body: { ok: true, instanceId: 'inst-1', lastSeenAt: '2026-10-01T00:00:00Z' },
        }),
      });
      manager = new CloudLinkManager({ fetchImpl, sleep: noSleep, now: () => 1_000_000 });
      await manager.checkLink();
      setCloud({
        instanceToken: 'dork_inst_other',
        instanceName: 'kai-mbp',
        linkedAccountLabel: null,
      });
      await manager.checkLink();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
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
      const body = JSON.parse(((call as unknown[] | undefined)?.[1] as RequestInit).body as string);
      return JSON.parse(body.scope) as Record<string, unknown>;
    };

    it('keeps a proof of the key, never the key, when the person unlinks', async () => {
      setCloud(LINKED);
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
        credits: { defaults: {}, offer: 'none', agents: [], linkedTo: null },
        // Managed remote access is withdrawn with the link (DOR-2086).
        remote: defaultRemoteAccessSettings(),
      });
      expect(JSON.stringify(configManager.getAll())).not.toContain('dork_inst_old');
    });

    it('keeps the person’s credits choices across an unlink, so nothing is moved (ADR 261001-000811)', async () => {
      const credits = {
        defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
        offer: 'none',
      };
      setCloud({ ...LINKED, credits } as never);
      manager = new CloudLinkManager({
        fetchImpl: routerFetch({ revoke: () => ({ status: 200, body: {} }) }),
        sleep: noSleep,
      });

      await manager.unlink();

      expect(configManager.get('cloud').credits).toEqual({
        defaults: {
          'claude-code': {
            runsOn: 'credits',
            chosenBy: 'user',
            announced: true,
            signInReoffered: false,
          },
        },
        offer: 'none',
        agents: [],
        linkedTo: null,
      });
    });

    it('keeps a proof of the key when the cloud refuses it (401)', async () => {
      setCloud(LINKED);
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
      setCloud({
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
      setCloud({
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
      setCloud({
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
      setCloud({ ...LINKED, previousLinkProof: 'stale-proof' });
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
        path.join(sandbox.dir, 'config.json'),
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'config.json'), 'utf-8')),
          cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
        })
      );
      initConfigManager(sandbox.dir);
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
});

// The keystone honesty proof for the accessor-pair construction seam
// (spec `capture-cloud-link-stub` §Testing Strategy — "Seam construction unit").
// Separate top-level describe: it drives the module-level `init/getCloudLinkManager`
// singleton directly (not `new CloudLinkManager()` per-test like the suite above).
describe('cloud-link construction seam (init/getCloudLinkManager)', () => {
  let manager: CloudLinkManager | undefined;
  useCloudLinkSandbox('dorkos-cloud-link-seam-', () => {
    manager?.stop();
    manager = undefined;
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

  it('getCloudLinkManager() before any initCloudLinkManager() call throws a loud, helpful error — not a silent undefined deref', async () => {
    // instance is module-level singleton state that leaks across test files/cases
    // via the statically-imported bindings above, so reset modules and re-import
    // fresh to observe the pre-init state.
    vi.resetModules();
    const fresh = await import('../../cloud-link.js');
    expect(() => fresh.getCloudLinkManager()).toThrow('CloudLinkManager not initialized');
  });

  it('stopCloudLinkManager() before initCloudLinkManager() has nothing to stop and does not throw (DOR-4689)', async () => {
    // A shutdown signal can land while the server is still booting.
    vi.resetModules();
    const fresh = await import('../../cloud-link.js');
    expect(() => fresh.stopCloudLinkManager()).not.toThrow();
  });
});
