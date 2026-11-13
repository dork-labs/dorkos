/**
 * `/api/mcp-servers` is person-only (DOR-3213): an agent can neither read nor
 * change the servers every agent gets, and no answer carries a secret value.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Whether this install has an owner account, and who the gate proved. */
const state = vi.hoisted(() => ({
  owner: null as unknown,
  user: undefined as { userId: string; credential: 'cookie' | 'api-key' } | undefined,
}));

// A plain factory, not `importOriginal`: the gate policy imports this module
// back, and spreading the original hands it the real lookup, not this one.
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => state.owner,
  hasAnyUser: () => state.owner !== null,
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { configManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER } from '../../lib/caller-authority.js';
import type { CredentialStore } from '../../services/core/credential-provider.js';
import { GlobalMcpStore } from '../../services/mesh/global-mcp/global-mcp-store.js';
import {
  checkServerTools,
  GlobalMcpToolLedger,
} from '../../services/mesh/global-mcp/global-mcp-tools.js';
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
    honoGroupListener(
      { path: '/api/mcp-servers', routes: createMcpServerRoutes(store) },
      {
        before: async (c, next) => {
          if (state.user) c.set('user', state.user);
          await next();
        },
      }
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.owner = null;
  state.user = undefined;
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

  describe('check-args', () => {
    const check = (args: unknown) =>
      request(app()).post('/api/mcp-servers/check-args').send({ args });

    it('says whether arguments look secret, and never says them back', async () => {
      const yes = await check(['--token=made-up-canary']);
      expect(yes.status).toBe(200);
      expect(yes.body).toEqual({ looksSecret: true });
      expect(JSON.stringify(yes.body)).not.toContain('made-up-canary');
      expect((await check(['-y', '@made-up/server'])).body).toEqual({ looksSecret: false });
    });

    it('refuses an agent', async () => {
      const res = await request(app())
        .post('/api/mcp-servers/check-args')
        .set('x-dorkos-agent', 'agent-token')
        .send({ args: ['--token=made-up'] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(MCP_SERVERS_PERSON_ONLY);
    });

    it('refuses a body that is not arguments, or too big to read', async () => {
      expect((await check('--token=made-up')).status).toBe(400);
      expect((await check(['a'.repeat(4097)])).status).toBe(400);
    });

    it('saves nothing', async () => {
      await check(['--token=made-up']);
      expect(store.list()).toEqual([]);
    });
  });

  it.each(['ftp://mcp.example.test', 'http:user:made-up@mcp.example.test', 'javascript:alert(1)'])(
    'refuses %s as an address',
    async (url) => {
      const res = await request(app())
        .post('/api/mcp-servers')
        .send({ name: 'remote', connection: { transport: 'http', url, headers: {} } });
      expect(res.status).toBe(400);
      expect(store.list()).toEqual([]);
    }
  );

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

  describe('once this install has an owner (Security M1, DOR-3330)', () => {
    beforeEach(async () => {
      await store.add({ ...SERVER, secretNames: [], excludedAgents: [] } as never);
      state.owner = { id: 'owner' };
    });

    it('refuses every write from a program at this computer that sends no headers', async () => {
      const file = path.join(home, 'mcp', 'global-servers.json');
      const before = readFileSync(file);
      const writes = [
        request(app())
          .post('/api/mcp-servers')
          .send({ ...SERVER, name: 'planted' }),
        request(app()).put('/api/mcp-servers/github').send(SERVER),
        request(app()).patch('/api/mcp-servers/github').send({ enabled: false }),
        request(app()).delete('/api/mcp-servers/github'),
      ];
      for (const res of await Promise.all(writes)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
      }
      expect(store.list().map((s) => [s.name, s.enabled])).toEqual([['github', true]]);
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    it("refuses a page on another site, even carrying the owner's session", async () => {
      state.user = { userId: 'owner', credential: 'cookie' };
      const file = path.join(home, 'mcp', 'global-servers.json');
      const before = readFileSync(file);
      const res = await request(app())
        .post('/api/mcp-servers')
        .set('Origin', 'https://evil.example')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ ...SERVER, name: 'planted' });
      // The chain's CORS check refuses it before the route (its status is the
      // chain's to choose); what matters is that nothing was written.
      expect(res.ok).toBe(false);
      expect(store.list().map((s) => s.name)).toEqual(['github']);
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    it("refuses the owner's API key, which a program can read off disk", async () => {
      state.user = { userId: 'owner', credential: 'api-key' };
      const res = await request(app()).patch('/api/mcp-servers/github').send({ enabled: false });
      expect(res.status).toBe(403);
    });

    it("lets the owner's own session through", async () => {
      state.user = { userId: 'owner', credential: 'cookie' };
      const res = await request(app()).patch('/api/mcp-servers/github').send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
    });
  });

  it('refuses a server that runs from a relative path, or with LD_PRELOAD', async () => {
    const relative = await request(app())
      .post('/api/mcp-servers')
      .send({ ...SERVER, connection: { ...SERVER.connection, command: './server.sh' } });
    expect(relative.status).toBe(422);
    expect(relative.body.code).toBe('unsafe_command');

    const preload = await request(app())
      .post('/api/mcp-servers')
      .send({ ...SERVER, connection: { ...SERVER.connection, env: { LD_PRELOAD: '/tmp/x.so' } } });
    expect(preload.status).toBe(422);
    expect(preload.body.code).toBe('unsafe_env');
    expect(store.list()).toEqual([]);
  });

  it('keeps a working server when an edit is refused', async () => {
    await request(app()).post('/api/mcp-servers').send(SERVER);
    const refused = await request(app())
      .put('/api/mcp-servers/github')
      .send({ ...SERVER, connection: { ...SERVER.connection, command: './server.sh' } });
    expect(refused.status).toBe(422);
    expect(store.injectableFor('agent-a').github).toMatchObject({
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_real_secret' },
    });
  });

  it.each(['DorkOS', 'dorkos_connections', 'DORKOS_CONNECTIONS'])(
    'refuses %s as one of DorkOS’s own names, with the sentence the Name field uses (DOR-3600)',
    async (name) => {
      const res = await request(app())
        .post('/api/mcp-servers')
        .send({ ...SERVER, name });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: `${name} is one of DorkOS's own names. Pick another.`,
        code: 'reserved_name',
      });
      expect(store.list()).toEqual([]);
    }
  );

  it('answers a clash and an incomplete server plainly', async () => {
    await request(app()).post('/api/mcp-servers').send(SERVER);
    expect((await request(app()).post('/api/mcp-servers').send(SERVER)).status).toBe(409);
    expect((await request(app()).post('/api/mcp-servers').send({ name: 'x' })).status).toBe(400);
  });
});

// DOR-4118: the server sheet's "Who uses it without asking". Real agent folders,
// a real ledger, and the check's probe swapped for a made-up listing, so no
// server process ever starts here.
describe('the server sheet (DOR-4118)', () => {
  let agentHome: string;
  let checked: unknown[];
  let added: Array<[string, readonly string[], string[]]>;
  let toolsListed: string[];

  const localFile = () => path.join(agentHome, '.claude', 'settings.local.json');

  function sheetApp() {
    return target.mount(
      honoGroupListener(
        {
          path: '/api/mcp-servers',
          routes: createMcpServerRoutes(store, undefined, undefined, {
            agents: () => [{ id: 'agent-quill', name: 'Quill', home: agentHome }],
            ledger: new GlobalMcpToolLedger(home),
            onToolsAdded: (server, names, agents) => added.push([server, names, agents]),
            check: (connection, name, ledger) => {
              checked.push(connection);
              return checkServerTools(connection, name, ledger, async () => ({
                kind: 'ok',
                toolCount: toolsListed.length,
                tools: toolsListed.map((tool) => ({ name: tool, description: `Does ${tool}.` })),
              }));
            },
          }),
        },
        {
          before: async (c, next) => {
            if (state.user) c.set('user', state.user);
            await next();
          },
        }
      )
    );
  }

  beforeEach(async () => {
    checked = [];
    added = [];
    toolsListed = ['create_issue'];
    agentHome = path.join(home, 'agents', 'quill');
    mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
    writeFileSync(
      localFile(),
      JSON.stringify({ permissions: { allow: ['mcp__github', 'Bash(npm test)'] } }, null, 2)
    );
    await store.add({ ...SERVER, secretNames: [], excludedAgents: [] } as never);
  });

  it('checks the tools of a server that is on, and names a tool it adds later once', async () => {
    const first = await request(sheetApp()).get('/api/mcp-servers/github/tools');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      status: 'ok',
      tools: [{ name: 'create_issue', description: 'Does create_issue.', isNew: false }],
      added: [],
    });
    toolsListed = ['create_issue', 'export_all'];
    const later = await request(sheetApp()).get('/api/mcp-servers/github/tools');
    expect(later.body.tools[1]).toMatchObject({ name: 'export_all', isNew: true });
    expect(added).toEqual([['github', ['export_all'], ['Quill']]]);
  });

  it('says nothing about a new tool when no agent allows the whole server', async () => {
    writeFileSync(
      localFile(),
      JSON.stringify({ permissions: { allow: ['mcp__github__create_issue'] } })
    );
    await request(sheetApp()).get('/api/mcp-servers/github/tools');
    toolsListed = ['create_issue', 'export_all'];
    await request(sheetApp()).get('/api/mcp-servers/github/tools');
    expect(added).toEqual([]);
  });

  it('never starts a server that is off', async () => {
    await store.patch('github', { enabled: false });
    const res = await request(sheetApp()).get('/api/mcp-servers/github/tools');
    expect(res.body).toEqual({ status: 'not-checked' });
    expect(checked).toEqual([null]);
  });

  it('lists who may use it without asking', async () => {
    const res = await request(sheetApp()).get('/api/mcp-servers/github/allows');
    expect(res.status).toBe(200);
    expect(res.body.allows).toEqual([
      {
        agentId: 'agent-quill',
        agentName: 'Quill',
        rule: 'mcp__github',
        breadth: 'server',
        file: 'settings.local.json',
      },
    ]);
  });

  it('undoes one standing yes in the folder the registry names', async () => {
    const res = await request(sheetApp())
      .delete('/api/mcp-servers/github/allows')
      .send({ agentId: 'agent-quill', rule: 'mcp__github', home: '/somewhere/else' });
    expect(res.status).toBe(204);
    expect(JSON.parse(readFileSync(localFile(), 'utf8')).permissions.allow).toEqual([
      'Bash(npm test)',
    ]);
    const again = await request(sheetApp())
      .delete('/api/mcp-servers/github/allows')
      .send({ agentId: 'agent-quill', rule: 'mcp__github' });
    expect(again.status).toBe(404);
  });

  it.each([
    ['a rule for another server', { agentId: 'agent-quill', rule: 'mcp__weather' }, 400],
    ['a rule that is not an MCP rule', { agentId: 'agent-quill', rule: 'Bash(npm test)' }, 400],
    ['an agent the registry does not know', { agentId: 'agent-nobody', rule: 'mcp__github' }, 404],
  ])('refuses %s, writing nothing', async (_name, body, status) => {
    const before = readFileSync(localFile(), 'utf8');
    const res = await request(sheetApp()).delete('/api/mcp-servers/github/allows').send(body);
    expect(res.status).toBe(status);
    expect(readFileSync(localFile(), 'utf8')).toBe(before);
  });

  it('refuses an agent on all three, and an Undo from another device', async () => {
    const before = readFileSync(localFile(), 'utf8');
    for (const path of ['/api/mcp-servers/github/tools', '/api/mcp-servers/github/allows']) {
      const res = await request(sheetApp()).get(path).set('x-dorkos-agent', 'agent-token');
      expect(res.status).toBe(403);
    }
    const asAgent = await request(sheetApp())
      .delete('/api/mcp-servers/github/allows')
      .set('x-dorkos-agent', 'agent-token')
      .send({ agentId: 'agent-quill', rule: 'mcp__github' });
    expect(asAgent.status).toBe(403);
    const remote = await request(sheetApp())
      .delete('/api/mcp-servers/github/allows')
      .set('Host', 'box.ngrok.app')
      .send({ agentId: 'agent-quill', rule: 'mcp__github' });
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    expect(checked).toEqual([]);
    expect(readFileSync(localFile(), 'utf8')).toBe(before);
  });

  it('answers 404 for a server that does not exist', async () => {
    const res = await request(sheetApp()).get('/api/mcp-servers/nope/allows');
    expect(res.status).toBe(404);
  });
});
