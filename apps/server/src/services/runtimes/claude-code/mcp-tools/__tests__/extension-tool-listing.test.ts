/**
 * An extension's tools on the real in-session `tools/list` (DOR-2685, task
 * 2.2).
 *
 * One record-shaped input schema anywhere on the `dorkos` server empties the
 * whole tool list on the current Claude SDK (`tool-exposure.ts`). This drives
 * the real `createDorkOsToolServer` through an in-memory MCP client, with the
 * fixture extension's tools accepted by discovery's check and a record-shaped
 * tool declared beside them, and asserts every core tool is still listed.
 *
 * Lives here because only this directory may import the Agent SDK, and the
 * guard has to hold against the real SDK, not a restatement of it.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ExtensionManifestSchema } from '@dorkos/extension-api';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer } from '../index.js';
import { inSessionToolName } from '../tool-exposure.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import type { McpToolDeps } from '../types.js';
import type { CapabilityRegistry } from '../../../../core/capabilities/index.js';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../extensions/__fixtures__/agent-tools-ext/extension.json'
);

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-2685-listing',
    dorkHome: '/tmp/dorkos-test-home',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
  };
}

/** Every tool name the live in-session server advertises. */
async function listedNames(registry: CapabilityRegistry): Promise<string[]> {
  const server = createDorkOsToolServer(
    createFullDeps(),
    undefined,
    undefined,
    undefined,
    registry
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-2685-listing-probe', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

describe('extension tools on the real in-session tools/list', () => {
  it('lists every core tool and the accepted extension tools, and never the refused one', async () => {
    // Purpose: a refused record-shaped schema beside valid tools must not cost
    // anyone a single core tool, and the accepted ones must actually list.
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as { tools: unknown[] };
    raw.tools.push({
      name: 'dump_headers',
      title: 'Dump headers',
      description: 'Takes a free-form map, which no agent tool list can carry.',
      tier: 'observe',
      inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
    });
    const manifest = ExtensionManifestSchema.parse(raw);
    const checks = checkDeclaredTools(manifest);
    expect(checks.find((c) => c.name === 'dump_headers')?.ok).toBe(false);

    const registry = composeCapabilityRegistryForDocs();
    const before = await listedNames(registry);
    expect(before.length).toBeGreaterThan(20);

    const contributed = registry.contribute({
      owner: manifest.id,
      displayName: manifest.name,
      tools: checks.flatMap((c) => (c.ok ? [{ ...c, invoke: async () => 'ok' }] : [])),
    });
    expect(contributed.ok).toBe(true);

    const after = await listedNames(registry);
    for (const name of before) expect(after).toContain(name);
    const extNames = after.filter((name) => name.startsWith('ext_'));
    expect(extNames.sort()).toEqual(
      [
        'ext_agent_tools_ext__bump_counter',
        'ext_agent_tools_ext__delete_note',
        'ext_agent_tools_ext__echo',
      ].sort()
    );
    expect(after).not.toContain('ext_agent_tools_ext__dump_headers');
    // The qualified spelling an agent would see is the plain prefix plus the name.
    expect(inSessionToolName('ext_agent_tools_ext__echo')).toBe(
      'mcp__dorkos__ext_agent_tools_ext__echo'
    );

    if (contributed.ok) contributed.remove();
    expect(await listedNames(registry)).toEqual(before);
  });
});
