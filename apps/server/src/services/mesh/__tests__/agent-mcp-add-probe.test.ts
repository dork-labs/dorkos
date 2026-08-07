/**
 * `add()`'s advisory sign-in probe (DOR-1003): adding a remote MCP server dials
 * it once, and a clean 401 stamps `authKind: 'oauth2'` on the entry before it is
 * persisted — so the very first listing says "needs sign-in" instead of the
 * operator finding out when a turn fails.
 *
 * The three outcomes are held apart on purpose: a 401 teaches, a healthy server
 * teaches nothing, and a server that does not answer inside the add's budget
 * neither teaches nor delays the add.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';

import { AgentMcpServerService, type AgentWorkspaceLocator } from '../agent-mcp-server-service.js';
import { ADD_PROBE_BUDGET_MS } from '../agent-mcp-probe.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER_URL = 'https://mcp.example/mcp';

const REMOTE: McpServerTransport = { transport: 'http', url: SERVER_URL, headers: {} };
const STDIO: McpServerTransport = { transport: 'stdio', command: 'node', args: [], env: {} };

class FakeLocator implements AgentWorkspaceLocator {
  constructor(private readonly projectPath: string) {}
  get(agentId: string): { projectPath: string } | undefined {
    return agentId === AGENT_ID ? { projectPath: this.projectPath } : undefined;
  }
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(
  probeFetch: typeof fetch
): Promise<{ service: AgentMcpServerService; projectPath: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-add-probe-'));
  tempDirs.push(projectPath);
  const manifest: AgentManifest = {
    id: AGENT_ID,
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-07T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
  };
  await writeManifest(projectPath, manifest);
  const service = new AgentMcpServerService({
    agents: new FakeLocator(projectPath),
    logger: { warn: () => {} },
    probeFetch,
  });
  return { service, projectPath };
}

/** Read the one persisted entry's `authKind` straight off disk. */
async function persistedAuthKind(service: AgentMcpServerService): Promise<string | undefined> {
  const [server] = await service.list(AGENT_ID);
  const connection = server?.connection;
  return connection && connection.transport !== 'stdio' ? connection.authKind : undefined;
}

/** A fetch that answers every request with a bare 401, as an OAuth-protected server does. */
const unauthorizedFetch: typeof fetch = async () =>
  new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

/**
 * A fetch that speaks just enough Streamable HTTP MCP to complete `initialize`
 * and `tools/list` — a healthy, unauthenticated server.
 */
function healthyMcpFetch(toolCount: number): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id?: number; method?: string };
    // A notification (no id) gets the SDK's expected empty-accepted response.
    if (request.id === undefined) return new Response(null, { status: 202 });
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'healthy', version: '1.0.0' },
          }
        : {
            tools: Array.from({ length: toolCount }, (_unused, i) => ({
              name: `tool-${i}`,
              inputSchema: { type: 'object' },
            })),
          };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'probe-session' },
    });
  }) as typeof fetch;
}

describe('AgentMcpServerService.add — advisory sign-in probe', () => {
  it('stamps authKind: oauth2 before persisting when the server answers 401', async () => {
    const { service } = await setup(unauthorizedFetch);

    const list = await service.add({
      agentId: AGENT_ID,
      name: 'granola',
      connection: REMOTE,
      addedBy: 'operator',
    });

    // The RETURNED entry carries it — the manifest entry IS the signal `mcp.add`
    // hands back, so a caller never has to make a second call to find out.
    const added = list[0]?.connection;
    expect(added?.transport === 'http' ? added.authKind : undefined).toBe('oauth2');
    // And it was written, not merely returned: reverting the stamp to persist the
    // caller's connection untouched reddens both halves.
    expect(await persistedAuthKind(service)).toBe('oauth2');
  });

  it('leaves authKind unset when the server connects and lists its tools', async () => {
    const { service } = await setup(healthyMcpFetch(3));

    const list = await service.add({
      agentId: AGENT_ID,
      name: 'healthy',
      connection: REMOTE,
      addedBy: 'operator',
    });

    const added = list[0]?.connection;
    expect(added?.transport === 'http' ? added.authKind : undefined).toBeUndefined();
    expect(await persistedAuthKind(service)).toBeUndefined();
    // The probe may add a fact; it must never withhold or change the add itself.
    expect(list).toHaveLength(1);
    expect(list[0]?.enabled).toBe(true);
  });

  it('adds fast and unstamped when the server never answers, and does not fail', async () => {
    // Held open for the whole assertion: this server has NOT answered by the time
    // the add has to decide. Reverting the bounded wait to `await probe` hangs
    // here until the runner's own timeout — that is the red.
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { service } = await setup((async () => {
      await held;
      return new Response('Boom', { status: 500 });
    }) as typeof fetch);

    const startedAt = Date.now();
    const list = await service.add({
      agentId: AGENT_ID,
      name: 'wedged',
      connection: REMOTE,
      addedBy: 'operator',
    });
    const elapsed = Date.now() - startedAt;

    expect(list).toHaveLength(1);
    const added = list[0]?.connection;
    expect(added?.transport === 'http' ? added.authKind : undefined).toBeUndefined();
    // Bounded by the add budget, not by the ten-second probe timeout.
    expect(elapsed).toBeLessThan(ADD_PROBE_BUDGET_MS * 2);

    answer();
  });

  it('never probes a stdio server (nothing to sign in to)', async () => {
    const { service, projectPath } = await setup(unauthorizedFetch);

    const startedAt = Date.now();
    const list = await service.add({
      agentId: AGENT_ID,
      name: 'local',
      connection: STDIO,
      addedBy: 'operator',
    });
    const elapsed = Date.now() - startedAt;

    // Timing is the discriminator, not a spy on the fetch seam: a stdio probe
    // would never touch `fetch` at all, it would SPAWN the command. Dropping the
    // stdio guard makes this add wait out the whole budget on a `node` process
    // that is sitting there reading stdin.
    expect(elapsed).toBeLessThan(ADD_PROBE_BUDGET_MS / 2);
    expect(list[0]?.connection.transport).toBe('stdio');
    const onDisk = await readManifest(projectPath);
    expect(onDisk?.mcpServers[0]?.connection.transport).toBe('stdio');
  });
});
