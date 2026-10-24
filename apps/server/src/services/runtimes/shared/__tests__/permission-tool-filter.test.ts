/**
 * A Blocked permission hides its tools and leaves one line saying so (spec
 * `agent-permissions` D15), on every tool-list builder: claude-code's in-session
 * server, the runtime listener Codex and OpenCode reach, and the external
 * `/mcp` server. The resolution runs the real resolver over the real composed
 * registry; only the two sources (config, the agent's overrides) move.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  renderBlockedAreaLines,
  resolveToolVisibility,
  resolveToolVisibilityFor,
} from '../permission-tool-filter.js';
import { initPermissionGate, resetPermissionGate } from '../../../core/capabilities/index.js';
import { permissionActions } from '../../../core/permissions/index.js';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import { registerCapabilitiesAsMcpTools } from '../../../core/external-mcp/capability-mcp-tools.js';
import { createDorkOsToolServer } from '../../claude-code/mcp-tools/index.js';
import type { McpToolDeps } from '../../claude-code/mcp-tools/types.js';

/** The tools in the Rooms area, in-session or not. */
const ROOM_AREA_TOOLS = [
  'create_room',
  'add_room_members',
  'remove_room_members',
  'update_room',
  'leave_room',
  'archive_room',
  'merge_to_room_main',
  'reseat_room_agent',
];

/**
 * The ones an agent's own (in-session) server offers. Moving an agent to
 * another account is people-only for now, so it is on the external server
 * alone (Re-seat, Security Must 5).
 */
const ROOM_TOOLS = ROOM_AREA_TOOLS.filter((name) => name !== 'reseat_room_agent');

const registry = composeCapabilityRegistryForDocs();

let preset: PermissionPreset | null;
let agent: AgentPermissions | undefined;

beforeEach(() => {
  preset = 'full';
  agent = undefined;
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => agent,
    listActions: () => permissionActions(registry),
  });
});

afterEach(() => resetPermissionGate());

/** Tool names a server advertises, asked through a real MCP client. */
async function listed(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'permission-filter-probe', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe('resolveToolVisibility', () => {
  it('hides every Rooms tool and names the area when Rooms is Blocked', () => {
    const visibility = resolveToolVisibility({ areas: { rooms: 'blocked' } });
    expect([...visibility.hiddenToolNames].sort()).toEqual([...ROOM_AREA_TOOLS].sort());
    expect(visibility.blockedAreas).toEqual(['rooms']);
  });

  it('hides nothing when Rooms is Allowed', () => {
    const visibility = resolveToolVisibility({ areas: { rooms: 'allowed' } });
    expect(visibility.hiddenToolNames.size).toBe(0);
    expect(visibility.blockedAreas).toEqual([]);
  });

  it('keeps an Ask area listed, since a card follows a call', () => {
    const visibility = resolveToolVisibility({ areas: { rooms: 'ask' } });
    expect(visibility.hiddenToolNames.size).toBe(0);
  });

  it('names only a Blocked area that actually hides something', () => {
    // Careful blocks Reach & secrets, which has no tool of its own, so it is not
    // named: a line saying an area is blocked while nothing in it is hidden
    // would be false.
    preset = 'careful';
    expect(resolveToolVisibility(undefined).blockedAreas).toEqual([]);
    const visibility = resolveToolVisibility({ areas: { rooms: 'blocked' } });
    expect(visibility.blockedAreas).toEqual(['rooms']);
  });

  it('hides nothing on an install that never chose, which resolves as Trusted', () => {
    preset = null;
    const visibility = resolveToolVisibility(undefined);
    expect(visibility.blockedAreas).toEqual([]);
    expect(visibility.hiddenToolNames.size).toBe(0);
  });

  it("reads an agent's overrides fresh by path", async () => {
    agent = { areas: { rooms: 'blocked' } };
    expect((await resolveToolVisibilityFor('/agents/a')).blockedAreas).toEqual(['rooms']);
    agent = undefined;
    expect((await resolveToolVisibilityFor('/agents/a')).blockedAreas).toEqual([]);
  });
});

describe('the context line', () => {
  it('appears exactly once for a Blocked Rooms, and not otherwise', () => {
    const blocked = renderBlockedAreaLines(['rooms']);
    expect(blocked).toBe(
      'Rooms is blocked for you. If you need it, ask with the tool ending in ' +
        '`request_permission`, and say why.'
    );
    expect(blocked.match(/Rooms is blocked/g)).toHaveLength(1);
    expect(renderBlockedAreaLines([])).toBe('');
  });
});

describe('the builders', () => {
  it('the registry projection (runtime listener and external /mcp) leaves hidden tools out', async () => {
    const hidden = resolveToolVisibility({ areas: { rooms: 'blocked' } }).hiddenToolNames;
    const blockedServer = new McpServer({ name: 'probe', version: '0' });
    registerCapabilitiesAsMcpTools(blockedServer, registry, 'external', undefined, hidden);
    const allowedServer = new McpServer({ name: 'probe', version: '0' });
    registerCapabilitiesAsMcpTools(allowedServer, registry, 'external');

    const blockedNames = await listed(blockedServer);
    const allowedNames = await listed(allowedServer);
    for (const tool of ROOM_AREA_TOOLS) {
      expect(blockedNames).not.toContain(tool);
      expect(allowedNames).toContain(tool);
    }
  });

  it("claude-code's in-session server leaves hidden tools out", async () => {
    const stub = {} as never;
    const deps: McpToolDeps = {
      transcriptReader: { listSessions: vi.fn().mockResolvedValue([]) } as never,
      defaultCwd: '/tmp/permission-filter',
      dorkHome: '/tmp/permission-filter-home',
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
    const hidden = resolveToolVisibility({ areas: { rooms: 'blocked' } }).hiddenToolNames;
    const blocked = createDorkOsToolServer(deps, undefined, undefined, undefined, registry, hidden);
    const allowed = createDorkOsToolServer(deps, undefined, undefined, undefined, registry);

    const blockedNames = await listed(blocked.instance as unknown as McpServer);
    const allowedNames = await listed(allowed.instance as unknown as McpServer);
    const bare = (name: string) => name.replace(/^mcp__dorkos__/, '');
    for (const tool of ROOM_TOOLS) {
      expect(blockedNames.map(bare)).not.toContain(tool);
      expect(allowedNames.map(bare)).toContain(tool);
    }
  });
});
