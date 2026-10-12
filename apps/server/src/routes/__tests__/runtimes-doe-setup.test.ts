/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner' }),
}));
// The session gate lets every request through: the cases are about the
// routes' own bars, and the fixture header below stands in for the user the
// gate would have proved.
vi.mock('../../services/core/auth/session-gate.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/operator/config-write.js', async (original) => ({
  ...(await original<typeof import('../../services/core/operator/config-write.js')>()),
  logConfigWrite: vi.fn(),
}));
vi.mock('../../services/runtimes/connect/doe-credentials.js', () => ({
  storeDoeCredential: vi.fn(),
}));
import { configManager } from '../../services/core/config-manager.js';
import { logConfigWrite } from '../../services/core/operator/config-write.js';
import { storeDoeCredential } from '../../services/runtimes/connect/doe-credentials.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createDoeSetupRoutes } from '../runtimes-doe-setup.js';

const server = listeningServer(
  honoGroupListener(
    { path: '/api/runtimes/doe', routes: createDoeSetupRoutes() },
    {
      before: (c, next) => {
        const kind = c.req.header('x-fixture-user');
        if (kind)
          c.set('user', {
            userId: kind === 'member-cookie' ? 'member' : 'owner',
            credential: kind === 'owner-api-key' ? 'api-key' : 'cookie',
          } satisfies RequestUser);
        return next();
      },
    }
  )
);
const inference = {
  source: 'api-key' as const,
  provider: 'fixture',
  protocol: 'openai-chat-completions' as const,
  endpoint: 'http://127.0.0.1:4444/v1',
  model: 'fixture',
  contextWindow: 8192,
  maxOutputTokens: 100,
};
let config = UserConfigSchema.parse({ version: 1 });
beforeEach(() => {
  vi.clearAllMocks();
  config = UserConfigSchema.parse({ version: 1 });
  vi.mocked(configManager.get).mockImplementation((key) => config[key] as never);
  vi.mocked(storeDoeCredential).mockResolvedValue(inference);
});
const writes = [
  { method: 'put' as const, path: '/api/runtimes/doe/inference', body: inference },
  {
    method: 'post' as const,
    path: '/api/runtimes/doe/credential',
    body: { inference, secret: 'offline-fixture-secret' },
  },
];
describe('owner authorization before DorkOS model setup effects', () => {
  for (const write of writes) {
    for (const header of ['X-DorkOS-Agent', 'X-DorkOS-Approval']) {
      it(`${write.method} ${write.path} refuses ${header} even on loopback with login off`, async () => {
        const response = await request(server)
          [write.method](write.path)
          .set(header, 'present')
          .send(write.body);
        expect(response.status).toBe(403);
        expect(configManager.set).not.toHaveBeenCalled();
        expect(storeDoeCredential).not.toHaveBeenCalled();
        expect(logConfigWrite).not.toHaveBeenCalled();
      });
    }
    for (const user of ['owner-api-key', 'member-cookie']) {
      it(`${write.method} ${write.path} refuses ${user} under login before either writer`, async () => {
        config.auth.enabled = true;
        const response = await request(server)
          [write.method](write.path)
          .set('X-Fixture-User', user)
          .send(write.body);
        expect(response.status).toBe(403);
        expect(configManager.set).not.toHaveBeenCalled();
        expect(storeDoeCredential).not.toHaveBeenCalled();
        expect(logConfigWrite).not.toHaveBeenCalled();
      });
    }
    it(`${write.method} ${write.path} admits the install owner's cookie under login`, async () => {
      config.auth.enabled = true;
      const response = await request(server)
        [write.method](write.path)
        .set('X-Fixture-User', 'owner-cookie')
        .send(write.body);
      expect(response.status).toBe(200);
      expect(
        write.method === 'post' ? storeDoeCredential : configManager.set
      ).toHaveBeenCalledTimes(1);
    });
    it(`${write.method} ${write.path} admits the local operator with login off`, async () => {
      const response = await request(server)[write.method](write.path).send(write.body);
      expect(response.status).toBe(200);
      expect(
        write.method === 'post' ? storeDoeCredential : configManager.set
      ).toHaveBeenCalledTimes(1);
    });
  }
  it('audits the inference metadata write with the exact before and after section', async () => {
    const before = config.runtimes;
    expect((await request(server).put('/api/runtimes/doe/inference').send(inference)).status).toBe(
      200
    );
    expect(logConfigWrite).toHaveBeenCalledWith(
      'the DorkOS model setup',
      'runtimes',
      before,
      expect.objectContaining({ doe: expect.objectContaining({ inference }) })
    );
  });
});

it('says which format DorkOS would pick in, and null when credits are not in use', async () => {
  expect((await request(server).get('/api/runtimes/doe/inference')).body).toEqual({
    inference: null,
    hasKey: false,
    autoProtocol: null,
  });
});

for (const injected of [
  { credentialRef: 'file:foreign-key', credentialEndpoint: inference.endpoint },
  { credentialRef: 'env:FOREIGN_KEY' },
  { credentialEndpoint: inference.endpoint },
]) {
  it(`rejects client-owned credential metadata ${Object.keys(injected).join(', ')} before mutation`, async () => {
    const response = await request(server)
      .put('/api/runtimes/doe/inference')
      .send({ ...inference, ...injected });
    expect(response.status).toBe(400);
    expect(configManager.set).not.toHaveBeenCalled();
    expect(storeDoeCredential).not.toHaveBeenCalled();
    expect(logConfigWrite).not.toHaveBeenCalled();
  });
}
it('keeps the server-owned reference only when metadata retains its original endpoint', async () => {
  config.runtimes.doe.inference = {
    ...inference,
    credentialRef: 'file:original-key',
    credentialEndpoint: inference.endpoint,
  };
  expect(
    (
      await request(server)
        .put('/api/runtimes/doe/inference')
        .send({ ...inference, model: 'new-model' })
    ).status
  ).toBe(200);
  expect(vi.mocked(configManager.set).mock.lastCall?.[1]).toMatchObject({
    doe: {
      inference: {
        model: 'new-model',
        credentialRef: 'file:original-key',
        credentialEndpoint: inference.endpoint,
      },
    },
  });
  expect(
    (
      await request(server)
        .put('/api/runtimes/doe/inference')
        .send({ ...inference, endpoint: 'http://127.0.0.1:5555/v1' })
    ).status
  ).toBe(200);
  const saved = vi.mocked(configManager.set).mock.lastCall?.[1];
  expect(saved).toMatchObject({ doe: { inference: { endpoint: 'http://127.0.0.1:5555/v1' } } });
  expect(JSON.stringify(saved)).not.toContain('original-key');
  expect(JSON.stringify(saved)).not.toContain('credentialEndpoint');
});
for (const invalid of [
  { ...inference, source: 'local', endpoint: 'https://example.com/v1' },
  { ...inference, maxOutputTokens: inference.contextWindow + 1 },
]) {
  it(`retains ${invalid.source === 'local' ? 'local endpoint' : 'output token'} validation on metadata input`, async () => {
    expect((await request(server).put('/api/runtimes/doe/inference').send(invalid)).status).toBe(
      400
    );
    expect(configManager.set).not.toHaveBeenCalled();
    expect(logConfigWrite).not.toHaveBeenCalled();
  });
}
