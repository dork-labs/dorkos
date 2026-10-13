/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
vi.mock('../../services/core/auth/session-gate.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user: { userId: string } | undefined) => user?.userId === 'owner',
}));
vi.mock('../../startup/computers.js', () => ({
  getComputerService: () => undefined,
  computerSetupFailed: () => false,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner', name: 'Owner' }),
}));
import { configManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createComputerRoutes, type ComputerRoutesService } from '../computers.js';
import { ComputerRefusal } from '../../services/computers/computer-service.js';
const status = {
  id: 'local' as const,
  name: 'Agent computer',
  supported: true,
  phase: 'ready' as const,
  generation: 1,
  ready: true,
};
const service: ComputerRoutesService = {
  status: vi.fn(async () => status),
  create: vi.fn(async () => status),
  start: vi.fn(async () => status),
  stop: vi.fn(async () => status),
  signIn: vi.fn(async () => status),
  session: vi.fn(async () => ({ id: 'session', cwd: '/anchor', runtime: 'computer-local' })),
  frame: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,YQ==',
    width: 1280,
    height: 800,
    generation: 1,
  })),
  acquire: vi.fn(async () => ({ leaseId: 'lease', generation: 1 })),
  release: vi.fn(async () => {}),
  input: vi.fn(async () => {}),
};
const server = listeningServer(
  honoGroupListener(
    { path: '/api/computers', routes: createComputerRoutes(service) },
    {
      before: async (c, next) => {
        const kind = c.req.header('x-fixture-user');
        if (kind)
          c.set('user', {
            userId: kind === 'member' ? 'member' : 'owner',
            credential: kind === 'api-key' ? 'api-key' : 'cookie',
          });
        await next();
      },
    }
  )
);
beforeEach(() => {
  vi.clearAllMocks();
  const config = UserConfigSchema.parse({ version: 1 });
  config.auth.enabled = true;
  vi.mocked(configManager.get).mockImplementation((key) => config[key] as never);
});
const ownerHeaders = { 'x-fixture-user': 'owner', 'X-Client-Id': 'web-tab-a' };
describe('computer owner routes', () => {
  it('refuses absent users, API keys, non-owners and presented agent identity', async () => {
    for (const headers of [
      {},
      { 'x-fixture-user': 'api-key' },
      { 'x-fixture-user': 'member' },
      { ...ownerHeaders, 'X-DorkOS-Agent': 'unresolved-agent' },
    ]) {
      const response = await request(server).post('/api/computers').set(headers);
      expect(response.status).toBe(403);
    }
    expect(service.create).not.toHaveBeenCalled();
  });
  it('requires a bounded client identity and keys control by proven user plus window', async () => {
    expect(
      (await request(server).post('/api/computers/control').set({ 'x-fixture-user': 'owner' }))
        .status
    ).toBe(400);
    const response = await request(server).post('/api/computers/control').set(ownerHeaders);
    expect(response.body).not.toHaveProperty('code', 'not-a-person');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(service.acquire).toHaveBeenCalledWith(JSON.stringify(['owner', 'web-tab-a']));
  });
  it('rejects malformed or extra input before delivering it', async () => {
    const response = await request(server).post('/api/computers/input').set(ownerHeaders).send({
      kind: 'pointer',
      action: 'down',
      x: 1,
      y: 2,
      button: 0,
      leaseId: 'lease',
      generation: 1,
      url: 'http://host',
    });
    expect(response.status).toBe(400);
    expect(service.input).not.toHaveBeenCalled();
    expect(
      (await request(server).delete('/api/computers/control').set(ownerHeaders).send({})).status
    ).toBe(400);
  });
  it('delivers admitted input with user-window authority and hides private diagnostics', async () => {
    const input = {
      kind: 'pointer',
      action: 'down',
      x: 1,
      y: 2,
      button: 0,
      leaseId: 'lease',
      generation: 1,
    };
    expect(
      (await request(server).post('/api/computers/input').set(ownerHeaders).send(input)).status
    ).toBe(200);
    expect(service.input).toHaveBeenCalledWith(JSON.stringify(['owner', 'web-tab-a']), input);
    vi.mocked(service.input).mockRejectedValueOnce(new Error('private password secret'));
    const failed = await request(server).post('/api/computers/input').set(ownerHeaders).send(input);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    vi.mocked(service.input).mockRejectedValueOnce(new ComputerRefusal('control-lost'));
    expect(
      (await request(server).post('/api/computers/input').set(ownerHeaders).send(input)).status
    ).toBe(409);
  });
  it('validates closed public DTOs and never serializes an accidental credential', async () => {
    vi.mocked(service.status).mockResolvedValueOnce({
      ...status,
      ...{ desktopPassword: 'private-credential' },
    });
    const response = await request(server).get('/api/computers').set(ownerHeaders);
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('private-credential');
  });
});
