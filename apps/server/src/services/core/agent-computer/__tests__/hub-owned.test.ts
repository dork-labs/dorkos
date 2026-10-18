/**
 * The table of what only the hub may do on an agent computer (DOR-2940),
 * checked against every action that exists: each registry capability and
 * each hand-registered MCP tool. Then the two gates that run actions are
 * asked for real, so the table cannot be right while its wiring is gone.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));

const {
  HUB_OWNED_ACTIONS,
  HUB_OWNED_ROUTES,
  agentComputerActionRefusal,
  agentComputerRouteRefusal,
} = await import('../hub-owned.js');
const { MCP_TOOL_TIERS, gatedActionForMcpTool } = await import('../../mcp-tool-tiers.js');
const { composeCapabilityRegistryForDocs } =
  await import('../../self-description/dorkos-registry.js');
const { CapabilityGateRefusal } = await import('../../capabilities/tier-enforcement.js');
const { gateHandRegisteredMcpTools } = await import('../../mcp-tool-gate.js');

/** Every action that exists: registry capabilities, then hand-registered tools. */
function everyAction() {
  const capabilities = composeCapabilityRegistryForDocs().capabilities.map((c) => ({
    id: c.id,
    title: c.title,
    tier: c.tier,
  }));
  const tools = Object.keys(MCP_TOOL_TIERS).map((name) => gatedActionForMcpTool(name));
  return [...capabilities, ...tools];
}

beforeEach(() => {
  role.value = 'agent-computer';
});

describe('the hub-owned table', () => {
  it('names only actions that exist', () => {
    const ids = new Set(everyAction().map((action) => action.id));
    const stale = [...HUB_OWNED_ACTIONS.keys()].filter((id) => !ids.has(id));
    expect(stale).toEqual([]);
  });

  it('refuses every hub-owned and every destructive action, and nothing else', () => {
    for (const action of everyAction()) {
      const refused = agentComputerActionRefusal(action) !== null;
      const expected = HUB_OWNED_ACTIONS.has(action.id) || action.tier === 'destructive';
      expect(refused, action.id).toBe(expected);
    }
  });

  it('never refuses an action on another role', () => {
    for (const value of ['computer', 'hub'] as const) {
      role.value = value;
      for (const action of everyAction()) {
        expect(agentComputerActionRefusal(action), `${value} ${action.id}`).toBeNull();
      }
    }
  });

  it('covers what the hub owns: agents, schedules, extensions, packages, permissions', () => {
    for (const id of [
      'create_agent',
      'operator.update_agent',
      'mesh_register',
      'mesh_unregister',
      'mesh_deny',
      'tasks_create',
      'create_extension',
      'reload_extensions',
      'marketplace.install',
      'marketplace.update',
      'marketplace.uninstall',
      'permissions.change',
    ]) {
      expect(HUB_OWNED_ACTIONS.has(id), id).toBe(true);
    }
  });

  it('is never approvable, so an agent does not ask again', () => {
    expect(
      agentComputerActionRefusal({ id: 'tasks_delete', title: 'Delete', tier: 'destructive' })
    ).toMatchObject({ status: 'denied', approvable: false });
  });
});

describe('the hub-owned routes', () => {
  const REFUSED: [string, string][] = [
    ['POST', '/api/admin/reset'],
    ['POST', '/api/admin/reset/prepare'],
    ['POST', '/api/agents'],
    ['POST', '/api/agents/create'],
    ['PATCH', '/api/agents/current'],
    ['PATCH', '/api/agents/a1/permissions'],
    ['POST', '/api/mesh/agents'],
    ['DELETE', '/api/mesh/agents/a1'],
    ['POST', '/api/mesh/deny'],
    ['POST', '/api/tasks'],
    ['POST', '/api/tasks/t1/trigger'],
    ['POST', '/api/extensions/e1/approve'],
    ['POST', '/api/extensions/reload'],
    ['POST', '/api/marketplace/packages/p/install'],
    ['POST', '/api/marketplace/packages/p/update'],
    ['POST', '/api/marketplace/packages/p/uninstall'],
    ['PUT', '/api/permissions/preset'],
    ['PATCH', '/api/permissions/defaults'],
    ['PATCH', '/api/config'],
    ['PUT', '/api/config/agents/defaultagent'],
    ['POST', '/api/runtimes/claude-code/accounts/found/dismiss'],
    ['POST', '/api/tunnel/start'],
    ['POST', '/api/remote-access/mode'],
    ['POST', '/api/lan-access'],
    ['PUT', '/api/heartbeats/triage-credits'],
    ['POST', '/api/shapes/s/apply'],
    ['POST', '/api/harness/adopt'],
    ['PATCH', '/api/profile'],
  ];

  it.each(REFUSED)('refuses %s %s', (method, path) => {
    expect(agentComputerRouteRefusal(method, path)?.code).toBe('AGENT_COMPUTER_HUB_OWNED');
  });

  it('leaves reads and an agent`s own work open', () => {
    for (const [method, path] of [
      ['GET', '/api/config'],
      ['GET', '/api/tasks'],
      ['POST', '/api/agents/a1/pause'],
      ['POST', '/api/agents/a1/commitments'],
      ['POST', '/api/agents/resolve'],
      ['POST', '/api/mesh/agents/a1/heartbeat'],
      ['POST', '/api/sessions/s1/messages'],
      ['POST', '/api/rooms/r1/messages'],
    ]) {
      expect(agentComputerRouteRefusal(method!, path!), `${method} ${path}`).toBeNull();
    }
  });

  it('refuses nothing on a person`s own computer', () => {
    role.value = 'computer';
    for (const route of HUB_OWNED_ROUTES) {
      expect(agentComputerRouteRefusal('POST', route.prefix)).toBeNull();
    }
  });
});

describe('the gates that run actions', () => {
  it('refuses a hub-owned capability in the registry, before it runs', async () => {
    const registry = composeCapabilityRegistryForDocs();
    const refusal: unknown = await registry.invoke('operator.update_agent', {}).catch((err) => err);
    expect(refusal).toBeInstanceOf(CapabilityGateRefusal);
    expect((refusal as InstanceType<typeof CapabilityGateRefusal>).decision.payload).toMatchObject({
      capabilityId: 'operator.update_agent',
      message: 'This is an agent computer. Only its hub changes its agents.',
    });
  });

  it('refuses a hub-owned hand-registered tool at once, without its handler', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
    const [tool] = gateHandRegisteredMcpTools([
      { name: 'tasks_create', description: 'Create', inputSchema: {}, handler },
    ] as never[]);
    const result = (await (tool as { handler: (a: never, e: unknown) => Promise<unknown> }).handler(
      {} as never,
      {}
    )) as { content: { text: string }[] };
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: 'denied',
      capabilityId: 'tasks_create',
      approvable: false,
    });
  });
});
