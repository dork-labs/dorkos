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

  it('remove() deletes the entry from the file', async () => {
    const { service, projectPath, agentId } = await setup();
    await service.add({ agentId, name: 'srv', connection: stdioConn, addedBy: 'dorian' });

    const list = await service.remove(agentId, 'srv');
    expect(list).toHaveLength(0);
    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers).toHaveLength(0);
  });
});

// DOR-3207: a browser the agent-browser guard refuses says so on its row, and nothing else does.
describe('AgentMcpServerService — a browser DorkOS leaves out', () => {
  const browser = (...extra: string[]): McpServerTransport => ({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.82', '--isolated', '--headless', ...extra],
    env: {},
  });

  it('marks a browser with a custom browser path or a shared profile as left out', async () => {
    const { service, agentId } = await setup();
    await service.add({
      agentId,
      name: 'custom',
      connection: browser('--executable-path', '/opt/my-chrome'),
      addedBy: 'x',
    });
    await service.add({
      agentId,
      name: 'shared',
      connection: browser('--user-data-dir', '/tmp/made-up-profile'),
      addedBy: 'x',
    });
    const list = await service.list(agentId);
    expect(list.map((s) => [s.name, s.leftOut])).toEqual([
      ['custom', 'own-browser-only'],
      ['shared', 'own-browser-only'],
    ]);
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

  it('rejects the connection tools’ name too, in any case (DOR-3600)', async () => {
    const { service, agentId } = await setup();
    await expect(
      service.add({ agentId, name: 'Dorkos_Connections', connection: stdioConn, addedBy: 'x' })
    ).rejects.toMatchObject({
      code: 'RESERVED_NAME',
      message: "Dorkos_Connections is one of DorkOS's own names. Pick another.",
    });
  });

  it('rejects a duplicate name within the agent', async () => {
    const { service, agentId } = await setup();
    await service.add({ agentId, name: 'dup', connection: stdioConn, addedBy: 'x' });
    await expect(
      service.add({ agentId, name: 'dup', connection: stdioConn, addedBy: 'x' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
  });
});

describe('AgentMcpServerService — injectableServersForCwd', () => {
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
});

describe('AgentMcpServerService — the signed-in browser (spec agent-browser-sessions)', () => {
  it('writes an empty session file when the browser is added, and again at injection if it vanished', async () => {
    const { agentBrowserConnection } = await import('@dorkos/shared/agent-browser');
    const { vi } = await import('vitest');
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-svc-dork-'));
    tempDirs.push(dorkHome);
    vi.stubEnv('DORK_HOME', dorkHome);
    try {
      const stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
      const { service, agentId, projectPath } = await setup();

      await service.add({
        agentId,
        name: 'browser',
        connection: agentBrowserConnection(stateFile),
        addedBy: 'operator',
      });
      // Playwright MCP fails every tool on a missing file; an empty one signs in to nothing.
      expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual({
        cookies: [],
        origins: [],
      });
      expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600);

      await fs.rm(stateFile);
      expect(service.injectableServersForCwd(projectPath)).toHaveProperty('browser');
      expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual({
        cookies: [],
        origins: [],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
