/**
 * The permission decision inside the tier gate, driven at all three of its
 * choke points (spec `agent-permissions` D6): `registry.invoke`,
 * `authorizeCapability`, and the hand-registered MCP tool gate.
 *
 * The resolver is never mocked: every row runs the real `resolvePermission`
 * over the real preset tables, with only the two SOURCES (the config section
 * and the agent's manifest) moved per test. Mocking the resolver would only
 * restate the rule under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

vi.mock('../../mcp-tool-tiers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../mcp-tool-tiers.js')>();
  return {
    ...real,
    // One hand-registered probe tool in the Rooms area. No real hand-registered
    // tool has an area in phase 1, so the third choke point needs a probe.
    gatedActionForMcpTool: (name: string) =>
      name === 'probe_rooms_tool'
        ? {
            id: 'probe_rooms_tool',
            title: 'Probe a room',
            tier: 'act' as const,
            area: 'rooms' as const,
            approvalDisplayFields: ['name'],
          }
        : real.gatedActionForMcpTool(name),
  };
});

import { defineCapability } from '../capability-definition.js';
import { composeRegistry, type CapabilityRegistry } from '../registry.js';
import {
  authorizeCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type TierEnforcementAttempt,
} from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import { trustedCaller } from '../trusted-caller.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../mcp-tool-gate.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const DORKBOT_PATH = '/agents/dorkbot';

/** DorkBot, identified, with no extra ceiling. */
function dorkbot(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentPath: DORKBOT_PATH,
    displayName: 'DorkBot',
    tierCeiling: 'destructive',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let ran: string[] = [];

/** A capability in the Rooms area at a tier, recording that it ran. */
function roomsCapability(id: `${string}.${string}`, tier: 'observe' | 'act' | 'destructive') {
  return defineCapability({
    id,
    title: `Probe ${id}`,
    description: 'A probe capability in the Rooms permission area.',
    tier,
    area: 'rooms',
    approvalDisplayFields: ['name'],
    input: z.object({ name: z.string() }),
    output: z.unknown(),
    surfaces: {},
    invoke: async () => {
      ran.push(id);
      return { ok: true };
    },
  });
}

/** A capability with no area, whose tier alone decides. */
const NO_AREA = defineCapability({
  id: 'probe.plain',
  title: 'Probe plain',
  description: 'A probe capability with no permission area.',
  tier: 'act',
  area: null,
  areaNote: 'a test probe',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: {},
  invoke: async () => {
    ran.push('probe.plain');
    return { ok: true };
  },
});

const DOMAINS = [
  {
    name: 'rooms',
    capabilities: [roomsCapability('rooms.create', 'act'), roomsCapability('rooms.merge', 'act')],
  },
  {
    name: 'probe',
    capabilities: [
      roomsCapability('probe.read', 'observe'),
      roomsCapability('probe.destroy', 'destructive'),
      NO_AREA,
    ],
  },
];

const INPUT = { name: 'release-work' };

describe('the permission decision at the tier gate', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let attempts: TierEnforcementAttempt[];
  let preset: PermissionPreset | null;
  let agent: AgentPermissions | undefined | Error;

  beforeEach(() => {
    ran = [];
    attempts = [];
    preset = null;
    agent = undefined;
    db = createTestDb();
    approvals = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals, onAttempt: (attempt) => attempts.push(attempt) });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => {
        if (agent instanceof Error) throw agent;
        return agent;
      },
    });
    registry = composeRegistry(DOMAINS, {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  /** Invoke through `registry.invoke`, returning the refusal payload or 'ran'. */
  async function viaRegistry(id: string, identity: AgentIdentity | null = dorkbot()) {
    try {
      await registry.invoke(id, INPUT, {
        ...(identity ? { identity } : {}),
        retryChannel: 'mcp-argument',
      });
      return 'ran' as const;
    } catch (err) {
      return (err as { decision: { payload: Record<string, unknown> } }).decision.payload;
    }
  }

  /** Decide through `authorizeCapability`. */
  function viaAuthorize(id: string, identity: AgentIdentity | null = dorkbot()) {
    return authorizeCapability(registry, id, INPUT, {
      ...(identity ? { identity } : {}),
      retryChannel: 'http-header',
    });
  }

  /** Call the probe hand-registered tool through the MCP tool gate. */
  async function viaToolGate(identity: AgentIdentity | null = dorkbot()) {
    const probe: SdkMcpTool = {
      name: 'probe_rooms_tool',
      description: 'probe',
      inputSchema: { name: z.string() },
      handler: async () => {
        ran.push('probe_rooms_tool');
        return { content: [{ type: 'text' as const, text: '{"ok":true}' }] };
      },
    };
    const [tool] = gateHandRegisteredMcpTools(
      [probe],
      identity ? async () => ({ identity }) : undefined
    );
    const result = await tool!.handler(INPUT, {});
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : '';
    return ran.includes('probe_rooms_tool') ? ('ran' as const) : JSON.parse(text);
  }

  const pendingCount = () => approvals.listPending().length;

  describe('the phase-1 outcome', () => {
    it('runs DorkBot create_room on a Full power install with no settings change', async () => {
      preset = 'full';
      agent = undefined; // DorkBot's manifest carries no `permissions`.

      expect(await viaRegistry('rooms.create')).toBe('ran');
      expect((await viaAuthorize('rooms.create')).outcome).toBe('allowed');
      expect(await viaToolGate()).toBe('ran');
    });

    it('keeps an undecided install as it was: create Blocked, merge runs', async () => {
      preset = null;

      expect(await viaRegistry('rooms.create')).toMatchObject({
        reason: 'permission_blocked',
        approvable: true,
      });
      expect(await viaRegistry('rooms.merge')).toBe('ran');
    });
  });

  describe('Blocked', () => {
    beforeEach(() => {
      agent = { areas: { rooms: 'blocked' } };
      preset = 'full';
    });

    it('refuses at every choke point and mints no approval', async () => {
      expect(await viaRegistry('rooms.create')).toMatchObject({
        status: 'denied',
        reason: 'permission_blocked',
        // A person COULD say yes, through the request tool; a direct call still
        // raises no card (spec `agent-permissions` D8).
        approvable: true,
        message:
          'Rooms is blocked for this agent. You can ask the person with the tool ending in ' +
          '`request_permission`: name the action, pass the exact arguments, and say why.',
      });
      const authorized = await viaAuthorize('rooms.create');
      expect(authorized).toMatchObject({
        outcome: 'denied',
        payload: { reason: 'permission_blocked' },
      });
      expect(await viaToolGate()).toMatchObject({ reason: 'permission_blocked' });
      expect(ran).toEqual([]);
      expect(pendingCount()).toBe(0);
    });

    /** A direct call presenting a token, returning the refusal payload or 'ran'. */
    async function withToken(id: string, approvalToken: string) {
      try {
        await registry.invoke(id, INPUT, {
          identity: dorkbot(),
          approvalToken,
          retryChannel: 'mcp-argument',
        });
        return 'ran' as const;
      } catch (err) {
        return (err as { decision: { payload: Record<string, unknown> } }).decision.payload;
      }
    }

    it('refuses a direct call that presents a made-up token, and mints nothing', async () => {
      // A token is not a way past Blocked: only `request_permission` is. Were a
      // token enough to reach the card path, an agent could mint a card that
      // skips the blocked-request limits by inventing one.
      expect(await withToken('rooms.create', 'a'.repeat(64))).toMatchObject({
        status: 'denied',
        reason: 'permission_blocked',
      });
      expect(ran).toEqual([]);
      expect(pendingCount()).toBe(0);
    });

    it("refuses a direct call that presents another action's valid token", async () => {
      // One action in the area is set to Ask, so the agent can hold a real,
      // granted token, for that action.
      agent = { areas: { rooms: 'blocked' }, actions: { 'rooms.merge': 'ask' } };
      const asked = (await viaRegistry('rooms.merge')) as {
        approvalId: string;
        approvalToken: string;
      };
      approvals.grant(asked.approvalId);
      expect(pendingCount()).toBe(0);

      expect(await withToken('rooms.create', asked.approvalToken)).toMatchObject({
        status: 'denied',
        reason: 'permission_blocked',
      });
      expect(ran).toEqual([]);
      expect(pendingCount()).toBe(0);
    });

    it('refuses reads in the area too', async () => {
      expect(await viaRegistry('probe.read')).toMatchObject({ reason: 'permission_blocked' });
    });

    it('audits the refusal with the permission that decided it', async () => {
      await viaRegistry('rooms.create');
      const denied = attempts.find((a) => a.decision.outcome === 'denied');
      expect(denied?.permission).toEqual({ state: 'blocked', source: 'agent-area' });
    });
  });

  describe('Ask', () => {
    beforeEach(() => {
      agent = { areas: { rooms: 'ask' } };
      preset = 'full';
    });

    it('mints exactly one approval for an act call, at every choke point', async () => {
      expect(await viaRegistry('rooms.create')).toMatchObject({
        status: 'approval_required',
        reason: 'no_approval',
        message: '"Probe rooms.create" is set to ask a person first. DorkOS has asked them.',
      });
      expect(pendingCount()).toBe(1);

      expect((await viaAuthorize('rooms.create')).outcome).toBe('approval_required');
      expect(pendingCount()).toBe(2);

      expect(await viaToolGate()).toMatchObject({ status: 'approval_required' });
      expect(pendingCount()).toBe(3);
      expect(ran).toEqual([]);
    });

    it('lets a read in the area through without a card', async () => {
      expect(await viaRegistry('probe.read')).toBe('ran');
      expect(pendingCount()).toBe(0);
    });

    it('runs once a person grants the card, with the token on the retry', async () => {
      const payload = (await viaRegistry('rooms.create')) as {
        approvalId: string;
        approvalToken: string;
      };
      approvals.grant(payload.approvalId);

      await registry.invoke('rooms.create', INPUT, {
        identity: dorkbot(),
        approvalToken: payload.approvalToken,
        retryChannel: 'mcp-argument',
      });
      expect(ran).toEqual(['rooms.create']);
    });

    it('records who asked and the area, so the card can offer Always allow', async () => {
      const payload = (await viaRegistry('rooms.create')) as { approvalId: string };
      expect(approvals.answerScope(payload.approvalId)).toMatchObject({
        agentPath: DORKBOT_PATH,
        area: 'rooms',
        alwaysOffered: true,
        blockedRequest: false,
      });
      expect(approvals.getPending(payload.approvalId)).toMatchObject({
        area: 'rooms',
        alwaysOffered: true,
      });
    });
  });

  describe('Allowed', () => {
    it('runs', async () => {
      agent = { areas: { rooms: 'allowed' } };
      expect(await viaRegistry('rooms.create')).toBe('ran');
      expect(await viaToolGate()).toBe('ran');
    });

    it('still asks for a destructive action allowed only at the area level', async () => {
      agent = { areas: { rooms: 'allowed' } };
      expect(await viaRegistry('probe.destroy')).toMatchObject({ status: 'approval_required' });
    });

    it('runs a destructive action allowed at the action level, and says so in the audit', async () => {
      agent = { actions: { 'probe.destroy': 'allowed' } };

      expect(await viaRegistry('probe.destroy')).toBe('ran');
      const auto = attempts.find((a) => a.decision.outcome === 'allowed');
      expect(auto?.decision).toMatchObject({
        outcome: 'allowed',
        approval: { via: 'permission', source: 'agent-action' },
      });
    });
  });

  describe('failing closed', () => {
    it('blocks a revoked identity, whatever its manifest allows, and offers no approval', async () => {
      agent = { areas: { rooms: 'allowed' } };
      preset = 'full';

      const payload = await viaRegistry('rooms.create', dorkbot({ inactive: 'expired' }));

      expect(payload).toMatchObject({ reason: 'permission_blocked', approvable: false });
      expect(pendingCount()).toBe(0);
    });

    it('refuses when the manifest read throws, rather than reading a broken disk as a yes', async () => {
      preset = 'full';
      agent = new Error('EIO');

      expect(await viaRegistry('rooms.create')).toMatchObject({
        reason: 'permission_blocked',
        approvable: false,
      });
      expect(await viaToolGate()).toMatchObject({ reason: 'permission_blocked' });
      expect(ran).toEqual([]);
    });

    it('gives an unidentified caller the defaults, never an agent layer', async () => {
      agent = { areas: { rooms: 'allowed' } };
      preset = null;

      expect(await viaRegistry('rooms.create', null)).toMatchObject({
        reason: 'permission_blocked',
      });
    });
  });

  describe('coexistence with the tier gate', () => {
    it('keeps a no-area action on its tier alone', async () => {
      preset = null;
      agent = { areas: { rooms: 'blocked' } };
      expect(await viaRegistry('probe.plain')).toBe('ran');
    });

    it('refuses an observe-ceiling agent rooms.create even on Full power', async () => {
      preset = 'full';

      const payload = await viaRegistry('rooms.create', dorkbot({ tierCeiling: 'observe' }));

      expect(payload).toMatchObject({ reason: 'tier_ceiling', approvable: false });
      expect(ran).toEqual([]);
    });

    it('lets a trusted caller past without resolving any permission', async () => {
      // A person is not an agent: no agent permission governs them, so even a
      // manifest read that would throw is never reached.
      agent = new Error('never read for a person');
      preset = null;
      const trusted = trustedCaller({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
        loginEnabled: () => false,
      })!;
      await registry.invoke('rooms.create', INPUT, { trusted });
      expect(ran).toEqual(['rooms.create']);
    });
  });
});
