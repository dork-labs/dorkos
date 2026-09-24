/**
 * Asking past Blocked, and reading one's own permissions (spec
 * `agent-permissions` D8, D9), driven through the real registry, the real tier
 * gate, the real approval service and the real in-session hold. Only the two
 * permission SOURCES (the config section and the agent's manifest) are moved
 * per test; mocking the gate would only restate the rule under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityDeps,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import { ApprovalService, BLOCKED_REQUEST_DENY_COOLDOWN_MS } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { permissionsDomain } from '../permission-capabilities.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCapabilitiesAsMcpTools } from '../../external-mcp/capability-mcp-tools.js';
import { capabilityMcpTools } from '../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js';

const DORKBOT_PATH = '/agents/dorkbot';

/** DorkBot, identified. */
function dorkbot(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentPath: DORKBOT_PATH,
    displayName: 'DorkBot',
    tierCeiling: 'destructive',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let ran: { id: string; input: unknown }[] = [];

/** A capability in an area, recording what it ran with. */
function probe(id: `${string}.${string}`, area: 'rooms' | 'tasks', toolName: string) {
  return defineCapability({
    id,
    title: `Probe ${id}`,
    description: 'A probe capability.',
    tier: 'act',
    area,
    approvalDisplayFields: ['title'],
    input: z.object({ title: z.string() }),
    output: z.unknown(),
    surfaces: { mcp: { toolName, servers: ['in-session', 'external'] } },
    invoke: async (_deps, input) => {
      ran.push({ id, input });
      return { created: input.title };
    },
  });
}

const DOMAINS = [
  {
    name: 'rooms',
    capabilities: [
      probe('rooms.create', 'rooms', 'create_room'),
      probe('rooms.update', 'rooms', 'update_room'),
    ],
  },
  { name: 'tasks', capabilities: [probe('tasks.create', 'tasks', 'create_task')] },
  {
    name: 'reach',
    capabilities: [
      // One action per kind of surface, all in the Blocked Rooms area: one only
      // the in-session server lists, one only the external server lists, and
      // one no MCP server lists (a connector-shaped, principal-bound action).
      reachProbe('reach.in_session', 'in_session_only', ['in-session']),
      reachProbe('reach.external', 'external_only', ['external']),
      reachProbe('reach.unlisted', null, []),
    ],
  },
  permissionsDomain,
];

/** A Rooms-area capability listed on exactly the given MCP servers. */
function reachProbe(
  id: `${string}.${string}`,
  toolName: string | null,
  servers: ('in-session' | 'external')[]
) {
  return defineCapability({
    id,
    title: `Probe ${id}`,
    description: 'A probe capability.',
    tier: 'act',
    area: 'rooms',
    approvalDisplayFields: ['title'],
    input: z.object({ title: z.string() }),
    output: z.unknown(),
    surfaces: toolName ? { mcp: { toolName, servers } } : {},
    invoke: async (_deps, input) => {
      ran.push({ id, input });
      return { created: input.title };
    },
  });
}

/** Read the plain JSON payload out of an MCP text result. */
function payloadOf(result: {
  content: { type: string; text?: string }[];
}): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
}

describe('permissions.request_access and permissions.list', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let preset: PermissionPreset | null;
  let agent: AgentPermissions | undefined;

  beforeEach(() => {
    ran = [];
    preset = 'full';
    agent = { areas: { rooms: 'blocked' } };
    db = createTestDb();
    approvals = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agent,
      listActions: () =>
        registry.capabilities.map((c) => ({
          id: c.id,
          tier: c.tier,
          area: c.area,
          ...(c.surfaces.mcp ? { toolName: c.surfaces.mcp.toolName } : {}),
        })),
    });
    const deps: CapabilityDeps = { logger: { debug() {}, info() {}, warn() {}, error() {} } };
    registry = composeRegistry(DOMAINS, deps);
    // The late binding `composeDorkOsCapabilityRegistry` performs.
    deps.registry = registry;
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Ask for an action over the MCP projection, as an in-session agent would. */
  function ask(
    args: Record<string, unknown>,
    identity: AgentIdentity | null = dorkbot(),
    surface?: Parameters<typeof invokeCapabilityAsMcpResult>[4]
  ) {
    return invokeCapabilityAsMcpResult(
      registry,
      'permissions.request_access',
      args,
      {
        ...(identity ? { identity } : {}),
        sessionId: 'session-1',
      },
      surface
    );
  }

  const REQUEST = {
    action: 'create_room',
    arguments: { title: 'proj-lunar' },
    reason: 'You asked me to set up the lunar room.',
  };

  it('refuses a direct call to a Blocked action, names the request tool, and mints nothing', async () => {
    await expect(
      registry.invoke('rooms.create', { title: 'x' }, { identity: dorkbot() })
    ).rejects.toMatchObject({
      decision: {
        payload: {
          reason: 'permission_blocked',
          approvable: true,
          message: expect.stringContaining('request_permission'),
        },
      },
    });
    expect(approvals.listPending()).toEqual([]);
  });

  it('mints one approval bound to the named action, with the reason on the card', async () => {
    const payload = payloadOf(await ask(REQUEST));

    expect(payload).toMatchObject({
      status: 'approval_required',
      capabilityId: 'rooms.create',
      reason: 'no_approval',
    });
    const [card] = approvals.listPending();
    expect(card).toMatchObject({
      capabilityId: 'rooms.create',
      area: 'rooms',
      alwaysOffered: true,
      blockedRequest: true,
      requestReason: 'You asked me to set up the lunar room.',
    });
    expect(ran).toEqual([]);
  });

  it('runs the named action with exactly those arguments once a person says yes', async () => {
    const asked = payloadOf(await ask(REQUEST));
    approvals.grant(asked.approvalId as string);

    const result = payloadOf(await ask({ ...REQUEST, approvalToken: asked.approvalToken }));

    expect(result).toEqual({ created: 'proj-lunar' });
    expect(ran).toEqual([{ id: 'rooms.create', input: { title: 'proj-lunar' } }]);
  });

  it('does not spend the token on a changed argument', async () => {
    const asked = payloadOf(await ask(REQUEST));
    approvals.grant(asked.approvalId as string);

    const changed = payloadOf(
      await ask({
        ...REQUEST,
        arguments: { title: 'something-else' },
        approvalToken: asked.approvalToken,
      })
    );

    expect(changed).toMatchObject({ status: 'approval_required', reason: 'wrong_action' });
    expect(ran).toEqual([]);
  });

  it('holds in session and returns the real result in the same turn', async () => {
    // The hold wakes on the real `approval_resolved` fan-out.
    vi.mocked(eventFanOut.broadcast).mockRestore();
    const eventQueue: unknown[] = [];
    const call = ask(REQUEST, dorkbot(), {
      session: { eventQueue: eventQueue as never[] },
      approvals,
    });
    // Let the hold push its card, then answer it.
    await vi.waitFor(() => expect(approvals.listPending()).toHaveLength(1));
    approvals.grant(approvals.listPending()[0]!.approvalId);

    expect(payloadOf(await call)).toEqual({ created: 'proj-lunar' });
    expect(ran).toHaveLength(1);
    expect((eventQueue[0] as { type: string }).type).toBe('capability_approval_required');
  });

  it('does not hold an unattended turn, and records where to deliver the answer', async () => {
    const eventQueue: unknown[] = [];
    const payload = payloadOf(
      await ask(REQUEST, dorkbot(), {
        session: { eventQueue: eventQueue as never[] },
        approvals,
        unattended: () => true,
      })
    );

    expect(payload.status).toBe('approval_required');
    // No inline card: nobody is watching this stream.
    expect(eventQueue).toEqual([]);
    approvals.grant(payload.approvalId as string);
    expect(approvals.verdictDelivery(payload.approvalId as string)?.sessionId).toBe('session-1');
  });

  describe('the rate limits, kept in the approvals store', () => {
    it('makes no second card while one request in the area is waiting', async () => {
      const first = payloadOf(await ask(REQUEST));
      const second = payloadOf(
        await ask({ ...REQUEST, action: 'update_room', arguments: { title: 'y' } })
      );

      expect(second).toMatchObject({
        status: 'denied',
        reason: 'request_pending',
        approvable: false,
        approvalId: first.approvalId,
      });
      // No token comes back (it is stored hashed), so the words say exactly how
      // to go on: wait, be told, and retry with the first request's token.
      expect(second.message).toBe(
        `You already asked the person about Rooms (request ${first.approvalId as string}) and ` +
          'they have not answered yet. Do not ask again: wait for their answer. In a DorkOS ' +
          'session, DorkOS tells you here when they decide. If they say yes, call ' +
          '`request_permission` again with the same action and arguments, plus the ' +
          'approvalToken your first request returned, and the action runs.'
      );
      expect(second).not.toHaveProperty('approvalToken');
      expect(approvals.listPending()).toHaveLength(1);
    });

    it('lets a request in ANOTHER area through while one waits', async () => {
      agent = { areas: { rooms: 'blocked', tasks: 'blocked' } };
      await ask(REQUEST);
      const other = payloadOf(
        await ask({ action: 'create_task', arguments: { title: 't' }, reason: 'the nightly run' })
      );
      expect(other.status).toBe('approval_required');
      expect(approvals.listPending()).toHaveLength(2);
    });

    it('refuses the same action for a day after a Deny, without a card', async () => {
      const first = payloadOf(await ask(REQUEST));
      approvals.deny(first.approvalId as string);

      const again = payloadOf(await ask(REQUEST));
      expect(again).toMatchObject({
        status: 'denied',
        reason: 'recently_denied',
        approvable: false,
      });
      expect(approvals.listPending()).toEqual([]);

      // A day later it may ask again.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + BLOCKED_REQUEST_DENY_COOLDOWN_MS + 60_000);
      expect(payloadOf(await ask(REQUEST)).status).toBe('approval_required');
    });

    it('stops at five requests an hour, across areas', async () => {
      agent = { areas: { rooms: 'blocked' } };
      for (let i = 0; i < 5; i += 1) {
        const asked = payloadOf(await ask({ ...REQUEST, arguments: { title: `room-${i}` } }));
        expect(asked.status).toBe('approval_required');
        // Answered, so the one-waiting rule does not trip first.
        approvals.grant(asked.approvalId as string);
      }
      const sixth = payloadOf(await ask({ ...REQUEST, arguments: { title: 'room-6' } }));
      expect(sixth).toMatchObject({ status: 'denied', reason: 'request_limit' });
    });
  });

  it('refuses a caller DorkOS cannot name, with no card', async () => {
    const result = await ask(REQUEST, null);
    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('UNIDENTIFIED_CALLER');
    expect(approvals.listPending()).toEqual([]);
  });

  it('refuses a revoked or expired identity, with no card', async () => {
    for (const inactive of ['revoked', 'expired'] as const) {
      const result = payloadOf(await ask(REQUEST, dorkbot({ inactive })));
      // A revoked identity never reaches the handler (its ceiling stops an
      // `act` call first); an expired one is refused by the handler. Either
      // way nothing runs and nothing is put in front of a person.
      expect(result.status === 'denied' || result.code === 'IDENTITY_INACTIVE').toBe(true);
    }
    expect(approvals.listPending()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('names an argument mismatch instead of throwing', async () => {
    const result = await ask({ ...REQUEST, arguments: { title: 42 } });
    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toMatchObject({ code: 'INVALID_ARGUMENTS' });
  });

  it('refuses an action that does not exist, and itself', async () => {
    expect(payloadOf(await ask({ ...REQUEST, action: 'nope' })).code).toBe('UNKNOWN_ACTION');
    expect(
      payloadOf(await ask({ ...REQUEST, action: 'request_permission', arguments: REQUEST })).code
    ).toBe('UNKNOWN_ACTION');
  });

  describe('only what the calling surface lists (spec D8)', () => {
    /** Ask for an action over a named MCP server, or over HTTP when `null`. */
    async function askOn(surface: 'in-session' | 'external' | null, action: string) {
      const result = await invokeCapabilityAsMcpResult(
        registry,
        'permissions.request_access',
        { ...REQUEST, action },
        { identity: dorkbot(), sessionId: 'session-1', ...(surface ? { mcpServer: surface } : {}) }
      );
      const payload = payloadOf(result);
      return (payload.code as string | undefined) ?? (payload.capabilityId as string);
    }

    it('on the in-session server, reaches in-session actions only', async () => {
      expect(await askOn('in-session', 'reach.unlisted')).toBe('UNKNOWN_ACTION');
      expect(await askOn('in-session', 'reach.external')).toBe('UNKNOWN_ACTION');
      expect(await askOn('in-session', 'external_only')).toBe('UNKNOWN_ACTION');
      expect(await askOn('in-session', 'in_session_only')).toBe('reach.in_session');
    });

    it('on the external server, reaches external actions only', async () => {
      expect(await askOn('external', 'reach.unlisted')).toBe('UNKNOWN_ACTION');
      expect(await askOn('external', 'reach.in_session')).toBe('UNKNOWN_ACTION');
      expect(await askOn('external', 'reach.external')).toBe('reach.external');
    });

    it('over HTTP, where any action is callable by id, reaches any', async () => {
      expect(await askOn(null, 'reach.unlisted')).toBe('reach.unlisted');
    });

    it('is told its surface by the external /mcp projection', async () => {
      const server = new McpServer({ name: 'dorkos', version: '0.0.0' });
      registerCapabilitiesAsMcpTools(server, registry, 'external', { identity: dorkbot() });
      const client = new Client({ name: 'test', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);

      const result = await client.callTool({
        name: 'request_permission',
        arguments: { ...REQUEST, action: 'in_session_only' },
      });
      expect(payloadOf(result as never)).toMatchObject({ code: 'UNKNOWN_ACTION' });
    });

    it('is told its surface by the Claude Code in-session projection', async () => {
      const tools = capabilityMcpTools(registry, 'in-session', async () => ({
        identity: dorkbot(),
        sessionId: 'session-1',
      }));
      const tool = tools.find((t) => t.name === 'request_permission') as unknown as {
        handler: (args: unknown, extra: unknown) => Promise<Parameters<typeof payloadOf>[0]>;
      };
      const result = await tool.handler({ ...REQUEST, action: 'external_only' }, {});
      expect(payloadOf(result)).toMatchObject({ code: 'UNKNOWN_ACTION' });
    });

    it('never runs an action the surface does not list', async () => {
      await askOn('in-session', 'reach.unlisted');
      expect(ran).toEqual([]);
      expect(approvals.listPending()).toEqual([]);
    });
  });

  it('accepts a runtime-prefixed tool name', async () => {
    const payload = payloadOf(await ask({ ...REQUEST, action: 'mcp__dorkos__create_room' }));
    expect(payload.capabilityId).toBe('rooms.create');
  });

  it('gives an action that is not Blocked no more than a direct call would', async () => {
    agent = undefined; // Full power: Rooms Allowed.
    const result = payloadOf(await ask(REQUEST));
    expect(result).toEqual({ created: 'proj-lunar' });
    expect(approvals.listPending()).toEqual([]);
  });

  describe('permissions.list', () => {
    /** List the caller's own permissions. */
    async function list(identity: AgentIdentity | null = dorkbot()) {
      return (await registry.invoke('permissions.list', {}, identity ? { identity } : {})) as {
        scope: string;
        areas: { id: string; state: string; source: string }[];
        actions: { id: string; state: string; source: string; toolName?: string }[];
      };
    }

    it('reports this agent’s state per area and per action, with where it came from', async () => {
      agent = { areas: { rooms: 'blocked' }, actions: { 'tasks.create': 'ask' } };
      const own = await list();

      expect(own.scope).toBe('agent');
      expect(own.areas.find((a) => a.id === 'rooms')).toMatchObject({
        state: 'blocked',
        source: 'agent-area',
      });
      expect(own.actions.find((a) => a.id === 'tasks.create')).toMatchObject({
        state: 'ask',
        source: 'agent-action',
        toolName: 'create_task',
      });
      // The request tool itself has no area, so it is not listed as a switch.
      expect(own.actions.some((a) => a.id === 'permissions.request_access')).toBe(false);
    });

    it('answers with the defaults for a caller it cannot name', async () => {
      const defaults = await list(null);
      expect(defaults.scope).toBe('defaults');
      expect(defaults.areas.find((a) => a.id === 'rooms')).toMatchObject({
        state: 'allowed',
        source: 'preset',
      });
    });

    it('reports everything Blocked for a revoked identity', async () => {
      const revoked = await list(dorkbot({ inactive: 'revoked' }));
      expect(revoked.areas.every((a) => a.state === 'blocked')).toBe(true);
    });
  });
});
