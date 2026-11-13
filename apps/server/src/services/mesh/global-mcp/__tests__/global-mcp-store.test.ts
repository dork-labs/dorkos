/**
 * The person's MCP servers for every agent (DOR-3213): secrets are stored
 * encrypted and never handed back, and each agent gets what it is not kept from.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalMcpServerInput } from '@dorkos/shared/global-mcp-schemas';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { GlobalMcpStore, GlobalMcpStoreError } from '../global-mcp-store.js';

/** An in-memory credential store that remembers what it holds. */
function memoryStore(): CredentialStore & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    put: async (name, secret) => {
      held.set(name, secret);
      return `file:${name}`;
    },
    get: async (name) => held.get(name) ?? null,
    delete: async (name) => {
      held.delete(name);
    },
  };
}

const GITHUB: GlobalMcpServerInput = {
  name: 'github',
  connection: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_real_secret', LOG_LEVEL: 'info' },
  },
  secretNames: [],
  excludedAgents: [],
  enabled: true,
};

let home: string;
let secrets: ReturnType<typeof memoryStore>;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'global-mcp-'));
  secrets = memoryStore();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('GlobalMcpStore', () => {
  it('tells its listeners once each write is saved, so running chats can drop a server (DOR-3872)', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const changed = vi.fn();
    store.onChange(changed);
    await store.add(GITHUB);
    expect(changed).toHaveBeenCalledTimes(1);
    await store.patch('github', { enabled: false });
    await store.replace('github', GITHUB);
    await store.remove('github');
    expect(changed).toHaveBeenCalledTimes(4);
    // A refused write changed nothing, so it tells nobody.
    await expect(store.remove('github')).rejects.toThrow();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('a listener that throws never fails the write', async () => {
    const store = new GlobalMcpStore(home, secrets, { logger: { warn: vi.fn() } });
    store.onChange(() => {
      throw new Error('made-up listener failure');
    });
    await expect(store.add(GITHUB)).resolves.toBeDefined();
  });

  it('keeps a secret value out of the file and out of every answer', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const view = await store.add(GITHUB);

    const file = readFileSync(path.join(home, 'mcp', 'global-servers.json'), 'utf8');
    expect(file).not.toContain('ghp_real_secret');
    expect([...secrets.held.values()]).toContain('ghp_real_secret');
    expect(JSON.stringify(view)).not.toContain('ghp_real_secret');
    expect(JSON.stringify(store.list())).not.toContain('ghp_real_secret');
    expect(view.env).toEqual([
      { name: 'GITHUB_TOKEN', secret: true },
      { name: 'LOG_LEVEL', secret: false },
    ]);
  });

  it('treats a name the person marked as secret like a TOKEN', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const view = await store.add({
      ...GITHUB,
      connection: { ...GITHUB.connection, env: { WORKSPACE: 'acme' } } as never,
      secretNames: ['WORKSPACE'],
    });
    expect(view.env).toEqual([{ name: 'WORKSPACE', secret: true }]);
  });

  it('hands every agent the server with its secret resolved, in memory only', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);

    expect(store.injectableFor('agent-a')).toEqual({
      github: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_real_secret', LOG_LEVEL: 'info' },
      },
    });
  });

  it('resolves the secret again after a restart', async () => {
    await new GlobalMcpStore(home, secrets).add(GITHUB);
    const restarted = new GlobalMcpStore(home, secrets);
    await restarted.load();
    expect(restarted.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: 'ghp_real_secret' },
    });
  });

  it('leaves out a server whose secret is gone, rather than starting it without one', async () => {
    await new GlobalMcpStore(home, secrets).add(GITHUB);
    secrets.held.clear();
    const restarted = new GlobalMcpStore(home, secrets);
    await restarted.load();
    expect(restarted.injectableFor('agent-a')).toEqual({});
    expect(restarted.list()).toHaveLength(1);
  });

  it('skips an agent the person kept it from, and every agent while it is off', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add({ ...GITHUB, excludedAgents: ['agent-b'] });
    expect(Object.keys(store.injectableFor('agent-a'))).toEqual(['github']);
    expect(store.injectableFor('agent-b')).toEqual({});

    await store.patch('github', { enabled: false });
    expect(store.injectableFor('agent-a')).toEqual({});
  });

  it('knows a saved server by name, on or off, and forgets a removed one', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add({ ...GITHUB, enabled: false });
    expect(store.has('github')).toBe(true);
    expect(store.has('linear')).toBe(false);
    await store.remove('github');
    expect(store.has('github')).toBe(false);
  });

  it('shows no setting value at all, secret-named or not, and masks the address', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const view = await store.add({
      name: 'remote',
      enabled: true,
      secretNames: [],
      excludedAgents: [],
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/made-up-key/mcp?x=1',
        headers: { 'X-Plain': 'made-up-plain' },
      },
    });
    expect(view.url).toBe('https://mcp.example.test/•••?•••');
    expect(view.headers).toEqual([{ name: 'X-Plain', secret: false }]);
    expect(JSON.stringify(store.list())).not.toContain('made-up');
    expect(store.injectableFor('agent-a').remote).toMatchObject({
      url: 'https://mcp.example.test/made-up-key/mcp?x=1',
      headers: { 'X-Plain': 'made-up-plain' },
    });
  });

  it('keeps running a value saved before its name counted as secret', async () => {
    const dir = path.join(home, 'mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'global-servers.json'),
      JSON.stringify({
        version: 1,
        servers: [
          {
            name: 'older',
            enabled: true,
            connection: { transport: 'stdio', command: 'npx', args: [], env: { DB_PASS: 'plain' } },
            secretNames: [],
            excludedAgents: [],
            addedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      })
    );
    const store = new GlobalMcpStore(home, secrets);
    await store.load();
    expect(store.injectableFor('agent-a').older).toMatchObject({ env: { DB_PASS: 'plain' } });
  });

  it('removes the stored secrets with the server', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    await store.remove('github');
    expect(secrets.held.size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("replaces a server's secrets with the ones typed again", async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    await store.replace('github', {
      ...GITHUB,
      connection: { ...GITHUB.connection, env: { GITHUB_TOKEN: 'ghp_new' } } as never,
    });
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: 'ghp_new' },
    });
    expect([...secrets.held.values()]).toEqual(['ghp_new']);
  });

  it('refuses a taken name, the reserved dorkos name and a sign-in server', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    await expect(store.add(GITHUB)).rejects.toMatchObject({ code: 'name_taken' });
    for (const name of ['dorkos', 'DorkOS', 'dorkos_connections', 'DORKOS_CONNECTIONS']) {
      await expect(store.add({ ...GITHUB, name })).rejects.toMatchObject({
        code: 'reserved_name',
        message: `${name} is one of DorkOS's own names. Pick another.`,
      });
    }
    await expect(
      store.add({
        ...GITHUB,
        name: 'linear',
        connection: {
          transport: 'http',
          url: 'https://mcp.linear.app',
          headers: {},
          authKind: 'oauth2',
        },
      })
    ).rejects.toBeInstanceOf(GlobalMcpStoreError);
  });

  it('refuses to save a server that runs from where agents write, or injects a library', async () => {
    const agentFolder = path.join(home, 'repos', 'app');
    const store = new GlobalMcpStore(home, secrets, { agentRoots: () => [agentFolder] });
    await expect(
      store.add({ ...GITHUB, connection: { ...GITHUB.connection, command: './run.sh' } } as never)
    ).rejects.toMatchObject({ code: 'unsafe_command' });
    await expect(
      store.add({
        ...GITHUB,
        connection: { ...GITHUB.connection, command: path.join(agentFolder, 'server') },
      } as never)
    ).rejects.toMatchObject({ code: 'unsafe_command' });
    await expect(
      store.add({
        ...GITHUB,
        connection: { ...GITHUB.connection, env: { LD_PRELOAD: '/tmp/x.so' } },
      } as never)
    ).rejects.toMatchObject({ code: 'unsafe_env' });
    expect(store.list()).toEqual([]);
  });

  it('leaves a working server running, secrets and all, when an edit is refused', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    const fileBefore = readFileSync(path.join(home, 'mcp', 'global-servers.json'));
    await expect(
      store.replace('github', {
        ...GITHUB,
        connection: { ...GITHUB.connection, command: './run.sh' },
      } as never)
    ).rejects.toMatchObject({ code: 'unsafe_command' });
    expect(store.injectableFor('agent-a').github).toMatchObject({
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_real_secret' },
    });
    expect([...secrets.held.values()]).toEqual(['ghp_real_secret']);
    expect(readFileSync(path.join(home, 'mcp', 'global-servers.json')).equals(fileBefore)).toBe(
      true
    );
  });

  it('flags NODE_OPTIONS on the saved server without refusing it', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const view = await store.add({
      ...GITHUB,
      connection: { ...GITHUB.connection, env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
    } as never);
    expect(view.warnings.map((w) => w.name)).toEqual(['NODE_OPTIONS']);
    expect(Object.keys(store.injectableFor('agent-a'))).toEqual(['github']);
  });

  it('never starts a server written into the file by hand with a bad path', async () => {
    // Any program running as this user can write the file. The check runs
    // again at load and before each injection, so this one is dropped.
    mkdirSync(path.join(home, 'mcp'), { recursive: true });
    const handWritten = {
      version: 1,
      servers: [
        {
          name: 'planted',
          enabled: true,
          connection: { transport: 'stdio', command: './x.sh', args: [], env: {} },
          secretNames: [],
          excludedAgents: [],
          addedAt: '2026-10-30T00:00:00.000Z',
        },
        {
          name: 'preload',
          enabled: true,
          connection: {
            transport: 'stdio',
            command: 'npx',
            args: [],
            env: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' },
          },
          secretNames: [],
          excludedAgents: [],
          addedAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(path.join(home, 'mcp', 'global-servers.json'), JSON.stringify(handWritten));
    const warn = vi.fn();
    const store = new GlobalMcpStore(home, secrets, { logger: { warn } });
    await store.load();

    expect(store.injectableFor('agent-a')).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    expect(store.list().map((s) => s.warnings[0]?.note)).toEqual([
      expect.stringMatching(/^Not started\./),
      expect.stringMatching(/^Not started\./),
    ]);
  });

  it('drops a saved server once an agent folder appears around its path', async () => {
    const roots: string[] = [];
    const store = new GlobalMcpStore(home, secrets, { agentRoots: () => roots });
    // Outside the data directory, which counts as agent-writable on its own.
    const outside = mkdtempSync(path.join(tmpdir(), 'global-mcp-tools-'));
    try {
      await store.add({
        ...GITHUB,
        connection: { ...GITHUB.connection, command: path.join(outside, 'server') },
      } as never);
      expect(Object.keys(store.injectableFor('agent-a'))).toEqual(['github']);
      roots.push(outside);
      expect(store.injectableFor('agent-a')).toEqual({});
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('says Codex and OpenCode skip an SSE-only server', async () => {
    const store = new GlobalMcpStore(home, secrets);
    const view = await store.add({
      ...GITHUB,
      name: 'docs',
      connection: {
        transport: 'sse',
        url: 'https://docs.example.dev/sse',
        headers: { Authorization: 'Bearer abc' },
      },
    });
    expect(view.skippedOn).toEqual(['codex', 'opencode']);
    expect(view.headers).toEqual([{ name: 'Authorization', secret: true }]);
  });
});

describe('connectionToCheck (DOR-4118)', () => {
  it('hands a person’s sheet the resolved connection of a server that is on', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    expect(store.connectionToCheck('github')).toMatchObject({
      transport: 'stdio',
      command: 'npx',
    });
  });

  it('never hands out a server that is off, or one that does not exist', async () => {
    const store = new GlobalMcpStore(home, secrets);
    await store.add(GITHUB);
    await store.patch('github', { enabled: false });
    expect(store.connectionToCheck('github')).toBeNull();
    expect(store.connectionToCheck('nope')).toBeNull();
  });
});
