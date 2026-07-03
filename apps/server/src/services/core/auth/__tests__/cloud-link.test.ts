import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initConfigManager, configManager } from '../../config-manager.js';
import { CloudLinkManager } from '../cloud-link.js';

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
