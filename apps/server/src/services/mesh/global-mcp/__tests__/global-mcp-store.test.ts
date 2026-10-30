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
      { name: 'LOG_LEVEL', secret: false, value: 'info' },
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
    await expect(store.add({ ...GITHUB, name: 'dorkos' })).rejects.toMatchObject({
      code: 'reserved_name',
    });
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
