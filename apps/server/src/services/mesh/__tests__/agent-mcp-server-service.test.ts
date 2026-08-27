import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import {
  AgentMcpServerService,
  AgentMcpServerError,
  type AgentWorkspaceLocator,
} from '../agent-mcp-server-service.js';

// === Test doubles ===

/** Maps agent ids to workspace paths — the shape the mesh registry provides. */
class FakeLocator implements AgentWorkspaceLocator {
  private readonly map = new Map<string, string>();
  register(agentId: string, projectPath: string): void {
    this.map.set(agentId, projectPath);
  }
  get(agentId: string): { projectPath: string } | undefined {
    const projectPath = this.map.get(agentId);
    return projectPath ? { projectPath } : undefined;
  }
}

function baseManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: '01HV7KJZZZ0000000000000000',
    name: 'test-agent',
    description: 'A test agent',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-03T00:00:00.000Z',
    registeredBy: 'test-suite',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}

const stdioConn: McpServerTransport = {
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: {},
};

// === Fixture wiring ===

const tempDirs: string[] = [];

async function setup(manifest: AgentManifest = baseManifest()): Promise<{
  service: AgentMcpServerService;
  projectPath: string;
  agentId: string;
}> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-svc-'));
  tempDirs.push(projectPath);
  await writeManifest(projectPath, manifest);

  const locator = new FakeLocator();
  locator.register(manifest.id, projectPath);
  const service = new AgentMcpServerService({ agents: locator, logger: { warn: () => {} } });
  return { service, projectPath, agentId: manifest.id };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// === Tests ===

describe('AgentMcpServerService — CRUD write-through', () => {
  it('add() writes the entry through to the manifest file on disk', async () => {
    const { service, projectPath, agentId } = await setup();

    const list = await service.add({
      agentId,
      name: 'my-server',
      connection: stdioConn,
      addedBy: 'dorian',
    });

    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('my-server');
    expect(list[0]?.enabled).toBe(true); // add enables by default (spec §4)

    // Prove it persisted by reading the file back through readManifest.
    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers).toHaveLength(1);
    expect(onDisk?.mcpServers[0]?.addedBy).toBe('dorian');
    expect(onDisk?.mcpServers[0]?.connection).toEqual(stdioConn);
  });

  it('add() honors an explicit enabled: false', async () => {
    const { service, agentId } = await setup();
    const list = await service.add({
      agentId,
      name: 'off-by-default',
      connection: stdioConn,
      addedBy: 'dorian',
      enabled: false,
    });
    expect(list[0]?.enabled).toBe(false);
  });

  it('update() replaces the connection and persists it', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'srv', connection: stdioConn, addedBy: 'dorian' });

    const nextConn: McpServerTransport = {
      transport: 'http',
      url: 'https://example.com',
      headers: {},
    };
    await service.update({ agentId, name: 'srv', connection: nextConn });

    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers[0]?.connection).toEqual(nextConn);
  });

  it('remove() deletes the entry from the file', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'srv', connection: stdioConn, addedBy: 'dorian' });

    const list = await service.remove(agentId, 'srv');
    expect(list).toHaveLength(0);
    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers).toHaveLength(0);
  });

  it('list() reflects what is on disk', async () => {
    const { service, agentId } = await setup();
    await service.add({ agentId, name: 'a', connection: stdioConn, addedBy: 'x' });
    await service.add({ agentId, name: 'b', connection: stdioConn, addedBy: 'x' });
    const list = await service.list(agentId);
    expect(list.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('AgentMcpServerService — name rules', () => {
  it('rejects the reserved name "dorkos" (case-insensitive)', async () => {
    const { service, agentId } = await setup();
    await expect(
      service.add({ agentId, name: 'dorkos', connection: stdioConn, addedBy: 'x' })
    ).rejects.toMatchObject({ code: 'RESERVED_NAME' });
    await expect(
      service.add({ agentId, name: 'DorkOS', connection: stdioConn, addedBy: 'x' })
    ).rejects.toBeInstanceOf(AgentMcpServerError);
  });

  it('rejects a duplicate name within the agent', async () => {
    const { service, agentId } = await setup();
    await service.add({ agentId, name: 'dup', connection: stdioConn, addedBy: 'x' });
    await expect(
      service.add({ agentId, name: 'dup', connection: stdioConn, addedBy: 'x' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
  });

  it('rejects operations on an unknown agent id', async () => {
    const { service } = await setup();
    await expect(service.list('unknown-agent')).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('rejects update/remove of a non-existent server', async () => {
    const { service, agentId } = await setup();
    await expect(service.update({ agentId, name: 'ghost', enabled: true })).rejects.toMatchObject({
      code: 'SERVER_NOT_FOUND',
    });
    await expect(service.remove(agentId, 'ghost')).rejects.toMatchObject({
      code: 'SERVER_NOT_FOUND',
    });
  });
});

describe('AgentMcpServerService — injectableServersForCwd', () => {
  it('returns {} for a cwd with no manifest', async () => {
    const { service } = await setup();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'no-manifest-'));
    tempDirs.push(empty);
    expect(service.injectableServersForCwd(empty)).toEqual({});
  });

  it('returns only enabled entries, mapped to the neutral connection shape', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'on', connection: stdioConn, addedBy: 'x', enabled: true });
    await service.add({
      agentId,
      name: 'off',
      connection: stdioConn,
      addedBy: 'x',
      enabled: false,
    });

    const injectable = service.injectableServersForCwd(projectPath);
    expect(Object.keys(injectable)).toEqual(['on']);
    expect(injectable.on).toEqual(stdioConn);
  });

  it('drops a server from injection once it is disabled', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'srv', connection: stdioConn, addedBy: 'x', enabled: true });
    expect(Object.keys(service.injectableServersForCwd(projectPath))).toEqual(['srv']);

    await service.disable(agentId, 'srv');
    expect(service.injectableServersForCwd(projectPath)).toEqual({});

    await service.enable(agentId, 'srv');
    expect(Object.keys(service.injectableServersForCwd(projectPath))).toEqual(['srv']);
  });

  it('serves a repeat call from the mtime cache (no manifest change)', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'srv', connection: stdioConn, addedBy: 'x', enabled: true });

    const first = service.injectableServersForCwd(projectPath);
    const second = service.injectableServersForCwd(projectPath);
    // Same object identity proves the second call hit the cache rather than
    // re-parsing the file.
    expect(second).toBe(first);
  });
});

describe('AgentMcpServerService — test probe', () => {
  it('returns an in-band error for an unreachable server (never throws)', async () => {
    const { service, agentId } = await setup();
    await service.add({
      agentId,
      name: 'broken',
      connection: {
        transport: 'stdio',
        command: 'dorkos-nonexistent-binary-xyz',
        args: [],
        env: {},
      },
      addedBy: 'x',
    });

    const result = await service.test(agentId, 'broken');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('AgentMcpServerService — import from .mcp.json (DOR-894)', () => {
  /** Write a `.mcp.json` at the workspace root with the given raw server map. */
  async function writeMcpJson(
    projectPath: string,
    servers: Record<string, unknown>
  ): Promise<void> {
    await fs.writeFile(
      path.join(projectPath, '.mcp.json'),
      JSON.stringify({ mcpServers: servers }),
      'utf-8'
    );
  }

  it('resolves a stdio server from .mcp.json and writes it managed + enabled', async () => {
    const { service, projectPath, agentId } = await setup();
    await writeMcpJson(projectPath, {
      filesystem: { command: 'npx', args: ['-y', '@mcp/fs'], env: { ROOT: '/tmp' } },
    });

    const list = await service.import({ agentId, name: 'filesystem', addedBy: 'operator' });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'filesystem',
      enabled: true,
      addedBy: 'operator',
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/fs'],
        env: { ROOT: '/tmp' },
      },
    });
    // Persisted, not just returned.
    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers[0]?.connection).toMatchObject({ transport: 'stdio', command: 'npx' });
  });

  it('resolves an http server (type + url) from .mcp.json', async () => {
    const { service, projectPath, agentId } = await setup();
    await writeMcpJson(projectPath, {
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    });

    const list = await service.import({ agentId, name: 'remote', addedBy: 'operator' });
    expect(list[0]?.connection).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('rejects the reserved name before touching the file', async () => {
    const { service, agentId } = await setup();
    await expect(
      service.import({ agentId, name: 'dorkos', addedBy: 'operator' })
    ).rejects.toMatchObject({ code: 'RESERVED_NAME' });
  });

  it('rejects a name already managed as DUPLICATE_NAME (even if also in .mcp.json)', async () => {
    const { service, projectPath, agentId } = await setup();
    await writeMcpJson(projectPath, { dup: { command: 'node' } });
    await service.add({
      agentId,
      name: 'dup',
      connection: stdioConn,
      addedBy: 'operator',
    });

    await expect(
      service.import({ agentId, name: 'dup', addedBy: 'operator' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
  });

  it('throws DISCOVERED_NOT_FOUND when neither .mcp.json nor the fallback resolves the name', async () => {
    const { service, projectPath, agentId } = await setup();
    await writeMcpJson(projectPath, { other: { command: 'node' } });

    await expect(
      service.import({ agentId, name: 'missing', addedBy: 'operator' })
    ).rejects.toMatchObject({ code: 'DISCOVERED_NOT_FOUND' });
  });

  it('falls back to the runtime resolver when .mcp.json cannot resolve the name', async () => {
    const { service, agentId } = await setup(); // no .mcp.json written

    const list = await service.import({
      agentId,
      name: 'from-runtime',
      addedBy: 'operator',
      resolveFallback: () => ({ transport: 'stdio', command: 'cached-cmd' }),
    });

    expect(list[0]).toMatchObject({
      name: 'from-runtime',
      enabled: true,
      connection: { transport: 'stdio', command: 'cached-cmd', args: [], env: {} },
    });
  });

  it('prefers .mcp.json over the fallback when both resolve', async () => {
    const { service, projectPath, agentId } = await setup();
    await writeMcpJson(projectPath, { srv: { command: 'file-cmd' } });

    const list = await service.import({
      agentId,
      name: 'srv',
      addedBy: 'operator',
      resolveFallback: () => ({ transport: 'stdio', command: 'fallback-cmd' }),
    });
    expect(list[0]?.connection).toMatchObject({ command: 'file-cmd' });
  });
});
