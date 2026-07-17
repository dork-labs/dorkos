import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfigManager, configManager } from '../../config-manager.js';
import { CloudLinkManager, initCloudLinkManager, getCloudLinkManager } from '../cloud-link.js';

/** Immediate, deterministic sleep so the background poll settles synchronously. */
const noSleep = async (): Promise<void> => {};

type Step = { status: number; body: unknown };

/** A fetch that routes by cloud endpoint path, returning per-endpoint canned responses. */
function routerFetch(handlers: {
  code?: () => Step;
  token?: () => Step;
  heartbeat?: () => Step;
  revoke?: () => Step;
}) {
  return vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    let step: Step | undefined;
    if (p.endsWith('/device/code')) step = handlers.code?.();
    else if (p.endsWith('/device/token')) step = handlers.token?.();
    else if (p.endsWith('/instances/heartbeat')) step = handlers.heartbeat?.();
    else if (p.endsWith('/instances/revoke')) step = handlers.revoke?.();
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
