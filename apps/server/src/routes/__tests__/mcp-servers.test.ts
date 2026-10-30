/**
 * `/api/mcp-servers` is person-only (DOR-3213): an agent can neither read nor
 * change the servers every agent gets, and no answer carries a secret value.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), onChange: vi.fn(() => () => undefined) },
}));

vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['box.ngrok.app'],
}));

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'owner',
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { configManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER } from '../../lib/caller-authority.js';
import type { CredentialStore } from '../../services/core/credential-provider.js';
import { GlobalMcpStore } from '../../services/mesh/global-mcp/global-mcp-store.js';
import { createMcpServerRoutes, MCP_SERVERS_PERSON_ONLY } from '../mcp-servers.js';

const target = swappableServer();
const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;

const SERVER = {
  name: 'github',
  connection: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_real_secret' },
  },
  enabled: true,
};

let home: string;
let store: GlobalMcpStore;

function secrets(): CredentialStore {
  const held = new Map<string, string>();
  return {
    put: async (name, secret) => (held.set(name, secret), `file:${name}`),
    get: async (name) => held.get(name) ?? null,
    delete: async (name) => void held.delete(name),
  };
}

function app() {
  return target.mount(
    honoGroupListener({ path: '/api/mcp-servers', routes: createMcpServerRoutes(store) })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(path.join(tmpdir(), 'mcp-servers-route-'));
  store = new GlobalMcpStore(home, secrets());
  mockConfigGet.mockImplementation((key: string) =>
    key === 'auth' ? { enabled: false } : undefined
  );
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('/api/mcp-servers', () => {
  it('lets a person at this computer add a server, and answers without its secret', async () => {
    const res = await request(app()).post('/api/mcp-servers').send(SERVER);
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('ghp_real_secret');
    expect(res.body.env).toEqual([{ name: 'GITHUB_TOKEN', secret: true }]);

    const list = await request(app()).get('/api/mcp-servers');
    expect(list.status).toBe(200);
    expect(list.body.servers.map((s: { name: string }) => s.name)).toEqual(['github']);
    expect(JSON.stringify(list.body)).not.toContain('ghp_real_secret');
  });

  it('refuses an agent, on reads and on writes', async () => {
    await store.add({ ...SERVER, secretNames: [], excludedAgents: [] } as never);
    const read = await request(app()).get('/api/mcp-servers').set('x-dorkos-agent', 'agent-token');
    expect(read.status).toBe(403);
    expect(read.body.code).toBe(MCP_SERVERS_PERSON_ONLY);

    const write = await request(app())
      .post('/api/mcp-servers')
      .set('x-dorkos-agent', 'agent-token')
      .send({ ...SERVER, name: 'other' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);

    const remove = await request(app())
      .delete('/api/mcp-servers/github')
      .set('x-dorkos-agent', 'agent-token');
    expect(remove.status).toBe(403);
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a change from another device', async () => {
    const res = await request(app())
      .post('/api/mcp-servers')
      .set('Host', 'box.ngrok.app')
      .send(SERVER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    expect(store.list()).toEqual([]);
  });

  it('turns a server off, keeps an agent from it, and removes it', async () => {
    await request(app()).post('/api/mcp-servers').send(SERVER);
    const off = await request(app())
      .patch('/api/mcp-servers/github')
      .send({ enabled: false, excludedAgents: ['agent-b'] });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, excludedAgents: ['agent-b'] });

    expect((await request(app()).delete('/api/mcp-servers/github')).status).toBe(204);
    expect((await request(app()).delete('/api/mcp-servers/github')).status).toBe(404);
  });

  it('answers a clash and an incomplete server plainly', async () => {
    await request(app()).post('/api/mcp-servers').send(SERVER);
    expect((await request(app()).post('/api/mcp-servers').send(SERVER)).status).toBe(409);
    expect((await request(app()).post('/api/mcp-servers').send({ name: 'x' })).status).toBe(400);
  });
});
