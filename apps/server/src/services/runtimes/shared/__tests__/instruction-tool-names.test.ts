/**
 * Every tool name a runtime's per-turn instructions write is one that runtime's
 * model can call (DOR-4112).
 *
 * The connection tools register as `connectors.list_granted_connections`, with a
 * dot. No runtime shows a model that dot: each rewrites it to `_`. `<accounts_access>`
 * wrote the registered spelling on Claude Code and Codex, so every agent with a
 * connected app was told a name that answered "No such tool available".
 *
 * The callable names are built here from two things this file does not share
 * with the code under test: the LIVE tool lists the servers serve, and each
 * runtime's qualifying rule restated from that runtime's own source. A literal
 * per runtime anchors the rule to a name seen in a real session.
 *
 * Shown to fail first: on the pre-fix `accounts-access-context.ts`, Claude Code
 * and Codex each report all twelve connection tools under their dotted names.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import type { CapabilityRegistry } from '../../../core/capabilities/index.js';
import { capabilitiesForMcpServer } from '../../../core/capabilities/mcp-projection.js';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import { connectorExecutionDomain } from '../../../connectors/execution/execution-capabilities.js';
import { createConnectorRuntimeMcpServer } from '../../../connectors/execution/runtime-mcp-server.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { CONNECTOR_RUNTIME_MCP_SERVER_NAME } from '../../connector-tools.js';
import { renderContextEntry } from '../../claude-code/messaging/context-builder.js';
import { buildCodexPrompt } from '../../codex/turn-input.js';
import { buildOpenCodeParts } from '../../opencode/messaging/turn-input.js';

type Runtime = 'claude-code' | 'codex' | 'opencode';

/**
 * Each runtime's model-facing name for an MCP tool, restated from its source.
 *
 * - Claude Code: `mcp__<server>__<tool>`, every character outside `[A-Za-z0-9_-]`
 *   becomes `_` (seen live: `mcp__dorkos__connectors_list_granted_connections`).
 * - Codex 0.163: `codex-rs/codex-mcp/src/tools.rs` runs both parts through
 *   `sanitize_responses_api_tool_name`, which keeps only `[A-Za-z0-9_]`.
 * - OpenCode: `sanitize(server) + "_" + sanitize(tool)`, keeping `[A-Za-z0-9_-]`.
 */
const CALLABLE: Record<Runtime, (server: string, tool: string) => string> = {
  'claude-code': (server, tool) =>
    `mcp__${server.replace(/[^\w-]/g, '_')}__${tool.replace(/[^\w-]/g, '_')}`,
  codex: (server, tool) => `mcp__${server.replace(/\W/g, '_')}__${tool.replace(/\W/g, '_')}`,
  opencode: (server, tool) => `${server.replace(/[^\w-]/g, '_')}_${tool.replace(/[^\w-]/g, '_')}`,
};

/** One connection tool per runtime, as a model in a real session is shown it. */
const ANCHOR: Record<Runtime, string> = {
  'claude-code': 'mcp__dorkos__connectors_list_granted_connections',
  codex: 'mcp__dorkos_connections__connectors_list_granted_connections',
  opencode: 'dorkos_connections_connectors_list_granted_connections',
};

/** Where each runtime's model finds the connection tools. */
const CONNECTION_SERVER: Record<Runtime, string> = {
  // In-session: the same registered names, on the `dorkos` server
  // (`capability-mcp-tools.ts`; pinned by `tool-exposure.test.ts`).
  'claude-code': 'dorkos',
  codex: CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  opencode: CONNECTOR_RUNTIME_MCP_SERVER_NAME,
};

/** What the dedicated connections server really serves, read over MCP. */
async function liveConnectionTools(): Promise<string[]> {
  const capabilities = connectorExecutionDomain.capabilities;
  const registry = {
    capabilities,
    get: (id: string) => capabilities.find((capability) => capability.id === id),
  } as unknown as CapabilityRegistry;
  const principal = createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId: 'binding-a',
    runtime: 'codex',
    canonicalSessionId: 'session-a',
    agentId: 'agent-a',
    agentPath: '/projects/a',
    canonicalCwd: '/projects/a',
  });
  const server = createConnectorRuntimeMcpServer(registry, principal);
  const client = new Client({ name: 'dor-4112-probe', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

/** Every name the runtime's model can call among DorkOS's own tools. */
async function callableNames(runtime: Runtime): Promise<Set<string>> {
  const callable = CALLABLE[runtime];
  const inSession = capabilitiesForMcpServer(composeCapabilityRegistryForDocs(), 'in-session').map(
    (capability) => capability.surfaces.mcp!.toolName
  );
  return new Set([
    ...inSession.map((tool) => callable('dorkos', tool)),
    ...(await liveConnectionTools()).map((tool) => callable(CONNECTION_SERVER[runtime], tool)),
  ]);
}

/** The per-turn instruction text each runtime's real renderer produces. */
function rendered(runtime: Runtime, entry: AdditionalContextEntry): string {
  if (runtime === 'claude-code') return renderContextEntry(entry);
  if (runtime === 'codex')
    return buildCodexPrompt('question', { additionalContext: [entry] } as never);
  return JSON.stringify(buildOpenCodeParts('question', { additionalContext: [entry] } as never));
}

/**
 * Every DorkOS tool name the text writes, dots included so a registered spelling
 * is caught whole; a sentence's closing period is not part of a name.
 */
function toolTokens(text: string): string[] {
  return [...text.matchAll(/\b(?:mcp__dorkos\w*__|dorkos_)[\w.-]*/g)].map((match) =>
    match[0].replace(/\.+$/, '')
  );
}

const ENTRIES: AdditionalContextEntry[] = [
  {
    kind: 'accounts_access',
    scope: 'per-turn',
    data: { accountCount: 1, changed: false, serviceCatalog: true },
  },
  {
    kind: 'context_warning',
    scope: 'per-turn',
    data: { percent: 82, canCompact: true },
  } as AdditionalContextEntry,
];

describe('per-turn instructions name tools the way each runtime exposes them (DOR-4112)', () => {
  it('restates each runtime rule correctly for the anchor seen in a real session', () => {
    for (const runtime of Object.keys(ANCHOR) as Runtime[]) {
      expect(
        CALLABLE[runtime](CONNECTION_SERVER[runtime], 'connectors.list_granted_connections')
      ).toBe(ANCHOR[runtime]);
    }
  });

  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'writes only names %s can call',
    async (runtime) => {
      const callable = await callableNames(runtime);
      for (const entry of ENTRIES) {
        const tokens = toolTokens(rendered(runtime, entry));
        // Not vacuous: the block named tools at all, under this runtime's spelling.
        expect(tokens.length, `${entry.kind} names no tool on ${runtime}`).toBeGreaterThan(0);
        const uncallable = [...new Set(tokens.filter((token) => !callable.has(token)))].sort();
        expect(uncallable, `${entry.kind} on ${runtime} names tools its model cannot call`).toEqual(
          []
        );
      }
      // Every connection tool is taught, so a dropped line is a red here too.
      const accounts = toolTokens(rendered(runtime, ENTRIES[0]!));
      for (const tool of await liveConnectionTools()) {
        expect(accounts).toContain(CALLABLE[runtime](CONNECTION_SERVER[runtime], tool));
      }
    }
  );
});
