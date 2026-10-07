import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { createDb, runMigrations } from '@dorkos/db';
import { expect, it, onTestFinished, vi } from 'vitest';
import { initAuth } from '../../../core/auth/index.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { verifyRequestAuth } from '../../../core/auth/session-gate.js';
import { BrowserControllerIdentities } from '../../api/controller-auth.js';
import { BrowserViewHost } from '../view-host.js';
import { logger } from '../../../../lib/logger.js';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
// This isolates genuine session verification and pixel issue/publication; native
// registry/grant ports are controlled unit ports, not installed ownership proof.
vi.mock('../../../../routes/room-caller.js', () => ({
  resolveCaller: (_req: unknown, res: Response) => ({ kind: 'human', id: res.locals.user.userId }),
}));
it('fresh post-control binding survives actual second cookie verification and stale binding remains refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'browser-view-auth-')),
    db = createDb(join(home, 'auth.db'));
  runMigrations(db);
  initConfigManager(home).set('auth', { enabled: true });
  const auth = initAuth(db, home),
    identities = new BrowserControllerIdentities();
  const resources: { host?: BrowserViewHost } = {};
  onTestFinished(async () => {
    try {
      await resources.host?.close();
      await identities.close();
    } finally {
      db.$client.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  const signup = await auth.api.signUpEmail({
    body: { email: 'viewer@dork.test', name: 'Owner', password: 'fixture-password-only' },
    asResponse: true,
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const req = {
    method: 'POST',
    headers: { cookie, host: '127.0.0.1:4242', origin: 'http://127.0.0.1:4242' },
    ip: '127.0.0.1',
    socket: {},
  } as unknown as Request;
  const user = await verifyRequestAuth(req, {
    sessionFreshness: 'server-store',
    sessionFailure: 'propagate',
  });
  expect(user).toBeDefined();
  const res = { locals: { user } } as unknown as Response;
  const binding = BrowserBindingSchema.parse({
    browserId: 'B'.repeat(22),
    browserGeneration: 1,
    tabId: 'T'.repeat(22),
    epoch: 1,
    inputGeneration: 1,
    navigationGeneration: 0,
    viewportVersion: 0,
  });
  let current = binding;
  let enabled = true;
  const resourceIdentity = Object.freeze({});
  const ownerView = vi.fn(() => ({ owner: user!.userId, identity: resourceIdentity }));
  const info = vi.spyOn(logger, 'info');
  onTestFinished(() => info.mockRestore());
  type Ports = ConstructorParameters<typeof BrowserViewHost>;
  const host = new BrowserViewHost(
    { instance: () => ({ status: 'running' }) } as unknown as Ports[0],
    { listTabs: () => [current] } as unknown as Ports[1],
    identities,
    {
      viewerGrant: () => {
        throw new Error('not requested');
      },
      admitViewer: () => {
        throw new Error('not requested');
      },
      ownerView,
    } as unknown as Ports[3],
    {
      capture: () => {
        throw new Error('not requested');
      },
      close: async () => {},
    } as unknown as Ports[4],
    () => enabled
  );
  resources.host = host;
  const issued = await host.issue(req, res, binding);
  const lease = await host.publication(req, res, issued.token);
  const publish = vi.fn();
  lease.publish(publish);
  expect(publish).toHaveBeenCalledOnce();
  current = { ...binding, epoch: 2, inputGeneration: 2 };
  await expect(host.issue(req, res, binding)).rejects.toMatchObject({ reason: 'authority' });
  expect(info).toHaveBeenCalledWith('Browser viewer original refusal stage', {
    stage: 'issue.current.binding',
    ordinal: 1,
  });
  const fresh = await host.issue(req, res, current);
  const freshLease = await host.publication(req, res, fresh.token);
  freshLease.publish(() => {});
  let admissions = 0;
  ownerView.mockImplementation(() => {
    if (++admissions === 3) enabled = false;
    return { owner: user!.userId, identity: resourceIdentity };
  });
  await expect(host.issue(req, res, current)).rejects.toMatchObject({ reason: 'authority' });
  expect(info).toHaveBeenLastCalledWith('Browser viewer original refusal stage', {
    stage: 'issue.current.config',
    ordinal: 2,
  });
  enabled = true;
});
