/**
 * The servers a person added for every agent reach each agent's runtime through
 * the one resolver every runtime reads (DOR-3213), under the agent's own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { AgentMcpServerService, type GlobalMcpServerSource } from '../agent-mcp-server-service.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';

const manifest: AgentManifest = {
  workspace: { mode: 'home' },
  id: AGENT_ID,
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
};

const GLOBAL: McpAppServerConnection = {
  transport: 'stdio',
  command: 'npx',
  args: ['docs-search-mcp'],
  env: {},
};

/** A global source that answers for one agent and records who asked. */
function source(servers: Record<string, McpAppServerConnection>): GlobalMcpServerSource & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    injectableFor: (agentId) => {
      asked.push(agentId);
      return servers;
    },
  };
}

const dirs: string[] = [];

async function setup(globalServers: GlobalMcpServerSource) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-global-'));
  dirs.push(projectPath);
  await writeManifest(projectPath, manifest);
  const service = new AgentMcpServerService({
    agents: { get: (id) => (id === AGENT_ID ? { projectPath } : undefined) },
    logger: { warn: () => {} },
    globalServers,
  });
  return { service, projectPath };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('injectableServersForCwd with servers for every agent', () => {
  it('hands an agent the global servers, asked for by its own id', async () => {
    const globals = source({ docs: GLOBAL });
    const { service, projectPath } = await setup(globals);

    expect(service.injectableServersForCwd(projectPath)).toEqual({ docs: GLOBAL });
    expect(globals.asked).toEqual([AGENT_ID]);
  });

  it("lets the agent's own server of the same name win", async () => {
    const { service, projectPath } = await setup(source({ docs: GLOBAL }));
    const own = { transport: 'stdio' as const, command: 'node', args: ['mine.js'], env: {} };
    await service.add({
      agentId: AGENT_ID,
      name: 'docs',
      connection: own,
      addedBy: 'x',
      enabled: true,
    });

    expect(service.injectableServersForCwd(projectPath)).toEqual({ docs: own });
  });

  it('gives a folder with no agent nothing', async () => {
    const { service } = await setup(source({ docs: GLOBAL }));
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'no-agent-'));
    dirs.push(empty);
    expect(service.injectableServersForCwd(empty)).toEqual({});
  });
});
