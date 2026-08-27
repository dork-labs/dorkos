/**
 * The claude-code MCP-server config seam (spec `mcp-server-management` §6): the
 * SDK-shape conversion (`toSdkMcpServers`) and the session merge ordering
 * (`mergeSessionMcpServers`) that guarantees the DorkOS tool server is never
 * shadowed, plus the end-to-end injection of an agent's ENABLED managed servers.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { toSdkMcpServers, mergeSessionMcpServers } from '../mcp-server-config.js';
import {
  AgentMcpServerService,
  type AgentWorkspaceLocator,
} from '../../../mesh/agent-mcp-server-service.js';

/** A distinguishable stub tool server standing in for the real DorkOS server. */
const DORKOS_STUB: McpServerConfig = { type: 'http', url: 'http://dorkos.local/mcp', headers: {} };

class FakeLocator implements AgentWorkspaceLocator {
  constructor(private readonly map: Record<string, string>) {}
  get(agentId: string): { projectPath: string } | undefined {
    const projectPath = this.map[agentId];
    return projectPath ? { projectPath } : undefined;
  }
}

function manifestWith(servers: AgentManifest['mcpServers']): AgentManifest {
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
    mcpServers: servers,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('mergeSessionMcpServers — ordering guarantee', () => {
  it('spreads managed first, connectors second, dorkos last', () => {
    const merged = mergeSessionMcpServers({
      managed: { m: { type: 'stdio', command: 'm', args: [], env: {} } },
      connectors: { c: { type: 'http', url: 'http://c', headers: {} } },
      dorkos: DORKOS_STUB,
    });
    expect(Object.keys(merged)).toEqual(['m', 'c', 'dorkos']);
    expect(merged.dorkos).toBe(DORKOS_STUB);
  });

  it('dorkos can never be shadowed by a managed or connector server of the same name', () => {
    const impostor: McpServerConfig = { type: 'stdio', command: 'evil', args: [], env: {} };
    const merged = mergeSessionMcpServers({
      managed: { dorkos: impostor },
      connectors: { dorkos: impostor },
      dorkos: DORKOS_STUB,
    });
    // The explicit `dorkos` property wins over both earlier spreads.
    expect(merged.dorkos).toBe(DORKOS_STUB);
    expect(merged.dorkos).not.toBe(impostor);
  });

  it('a managed↔connector name clash resolves to the connector (later spread)', () => {
    const managedSrv: McpServerConfig = { type: 'stdio', command: 'managed', args: [], env: {} };
    const connectorSrv: McpServerConfig = { type: 'http', url: 'http://conn', headers: {} };
    const merged = mergeSessionMcpServers({
      managed: { shared: managedSrv },
      connectors: { shared: connectorSrv },
      dorkos: DORKOS_STUB,
    });
    expect(merged.shared).toBe(connectorSrv);
  });
});

describe('managed server injection into the factory shape', () => {
  it('injects only the ENABLED server, and dorkos is present and unshadowed', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-inject-'));
    tempDirs.push(projectPath);
    const manifest = manifestWith([
      {
        name: 'enabled-srv',
        enabled: true,
        connection: { transport: 'stdio', command: 'node', args: ['on.js'], env: {} },
        addedAt: '2026-08-03T00:00:00.000Z',
        addedBy: 'operator',
      },
      {
        name: 'disabled-srv',
        enabled: false,
        connection: { transport: 'stdio', command: 'node', args: ['off.js'], env: {} },
        addedAt: '2026-08-03T00:00:00.000Z',
        addedBy: 'operator',
      },
    ]);
    await writeManifest(projectPath, manifest);

    const service = new AgentMcpServerService({
      agents: new FakeLocator({ [manifest.id]: projectPath }),
      logger: { warn: () => {} },
    });

    const managed = toSdkMcpServers(service.injectableServersForCwd(projectPath));
    const merged = mergeSessionMcpServers({ managed, connectors: {}, dorkos: DORKOS_STUB });

    expect(Object.keys(merged).sort()).toEqual(['dorkos', 'enabled-srv']);
    expect(merged['disabled-srv']).toBeUndefined();
    expect(merged.dorkos).toBe(DORKOS_STUB);
    expect(merged['enabled-srv']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['on.js'],
      env: {},
    });
  });

  it('contributes nothing for a manifest-less (non-agent) cwd', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-noagent-'));
    tempDirs.push(empty);
    const service = new AgentMcpServerService({
      agents: new FakeLocator({}),
      logger: { warn: () => {} },
    });
    const managed = toSdkMcpServers(service.injectableServersForCwd(empty));
    expect(managed).toEqual({});
    const merged = mergeSessionMcpServers({ managed, connectors: {}, dorkos: DORKOS_STUB });
    expect(Object.keys(merged)).toEqual(['dorkos']);
  });
});
