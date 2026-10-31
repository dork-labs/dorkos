/**
 * `permissions.change` (`change_permission`): an agent changing a permission
 * (spec `agent-permissions` D9, task 3.3). It runs when the Permissions area is
 * Allowed and asks otherwise; Permissions stopped being a floor with ADR
 * `261006-225605`. Driven through the real registry, the real gate, the real approval
 * service and the real permission service over an in-memory world.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';

import {
  CapabilityGateRefusal,
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityDeps,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { permissionsDomain } from '../permission-capabilities.js';
import { createPermissionWorld, TWO_AGENTS } from './permission-fixtures.js';

/** DorkBot, identified. */
const DORKBOT: AgentIdentity = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  createdAt: new Date().toISOString(),
};

describe('permissions.change', () => {
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let world: ReturnType<typeof createPermissionWorld>;
  let preset: PermissionPreset | null;
  let own: AgentPermissions | undefined;

  beforeEach(() => {
    preset = 'balanced';
    own = undefined;
    world = createPermissionWorld({ preset: 'balanced', agents: TWO_AGENTS });
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => own,
    });
    const deps: CapabilityDeps = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      permissionService: world.service,
    };
    registry = composeRegistry([permissionsDomain], deps);
    deps.registry = registry;
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  const OPEN_TEST_BOT_ROOMS = { target: 'agent-test', area: 'rooms', state: 'allowed' };

  /** Call as DorkBot; hand back the gate's decision when it refused. */
  async function call(input: unknown, token?: string) {
    try {
      return {
        result: await registry.invoke('permissions.change', input, {
          identity: DORKBOT,
          ...(token ? { approvalToken: token } : {}),
        }),
      };
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) return { decision: err.decision };
      throw err;
    }
  }

  it('is refused under the Full preset, with no card, and changes nothing (DOR-3440)', async () => {
    preset = 'full';
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    expect(decision?.outcome).toBe('denied');
    expect(approvals.listPending()).toHaveLength(0);
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();
  });

  it('asks under a preset whose Permissions area asks, and changes nothing until a person answers', async () => {
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    expect(decision?.outcome).toBe('approval_required');
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();
  });

  // DOR-3107 (Security and the PM): an agent's change that could loosen any
  // agent's settings always asks a person, whatever the preset, and nothing is
  // written until the person says yes. Only Blocked, which can only tighten,
  // still runs on its own where Permissions is Allowed.
  it('asks before loosening another agent, even under Trusted', async () => {
    preset = 'trusted';
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    expect(decision?.outcome).toBe('approval_required');
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();
  });

  it('asks before an agent loosens itself, and writes nothing until a person says yes', async () => {
    preset = 'trusted';
    own = { actions: { 'permissions.change': 'allowed' } };
    const self: AgentIdentity = { ...DORKBOT, agentPath: '/agents/test-bot' };
    const raise = { target: 'agent-test', area: 'rooms', state: 'allowed' };
    let refusal: unknown;
    try {
      await registry.invoke('permissions.change', raise, { identity: self });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(CapabilityGateRefusal);
    const decision = (refusal as CapabilityGateRefusal).decision;
    expect(decision.outcome).toBe('approval_required');
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();

    if (decision.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(decision.payload.approvalId);
    await registry.invoke('permissions.change', raise, {
      identity: self,
      approvalToken: decision.payload.approvalToken,
    });
    expect(world.agentArea('agent-test', 'rooms')).toBe('allowed');
  });

  it('runs without a card under Trusted when the change can only tighten', async () => {
    preset = 'trusted';
    const block = { target: 'agent-test', area: 'rooms', state: 'blocked' };
    const { result, decision } = await call(block);
    expect(decision).toBeUndefined();
    expect(result).toBeDefined();
    expect(world.agentArea('agent-test', 'rooms')).toBe('blocked');
    expect(approvals.listPending()).toEqual([]);
    // The history names the agent and claims no yes nobody gave.
    const [changed] = world.events.filter((e) => e.eventType === 'permission.changed');
    expect(changed).toMatchObject({
      actorLabel: 'DorkBot',
      metadata: { surface: 'agent-request', attribution: 'agent' },
    });
    expect(changed!.metadata).not.toHaveProperty('approvalId');
  });

  // Every loosening asks (DOR-3107), so an Always allow would do nothing.
  it('never offers Always allow on its card', async () => {
    await call(OPEN_TEST_BOT_ROOMS);
    const [pending] = approvals.listPending();
    expect(pending).toMatchObject({ area: 'permissions', alwaysOffered: false });
  });

  it('writes the change once approved, with one event saying who asked', async () => {
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    if (decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(decision.payload.approvalId);
    await call(OPEN_TEST_BOT_ROOMS, decision.payload.approvalToken);

    expect(world.agentArea('agent-test', 'rooms')).toBe('allowed');
    const changed = world.events.filter((e) => e.eventType === 'permission.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      actorLabel: 'DorkBot asked, you said yes',
      metadata: {
        surface: 'agent-request',
        attribution: 'agent-request-approved',
        approvalId: decision.payload.approvalId,
      },
    });
  });

  it('changes a default for everyone, and "default" removes a change', async () => {
    const ask = { target: 'everyone', area: 'tasks', state: 'blocked' };
    const first = await call(ask);
    if (first.decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(first.decision.payload.approvalId);
    await call(ask, first.decision.payload.approvalToken);
    expect(world.config.defaults.areas.tasks).toBe('blocked');

    const back = { target: 'everyone', area: 'tasks', state: 'default' };
    const second = await call(back);
    if (second.decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(second.decision.payload.approvalId);
    await call(back, second.decision.payload.approvalToken);
    expect(world.config.defaults.areas.tasks).toBeUndefined();
  });

  it('refuses a floor area set to Allowed, after the yes, with a plain sentence', async () => {
    const ask = { target: 'everyone', area: 'reach', state: 'allowed' };
    const { decision } = await call(ask);
    if (decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(decision.payload.approvalId);
    await expect(
      registry.invoke('permissions.change', ask, {
        identity: DORKBOT,
        approvalToken: decision.payload.approvalToken,
      })
    ).rejects.toMatchObject({
      name: 'CapabilityToolError',
      payload: { code: 'FLOOR_NEVER_ALLOWED', error: expect.stringContaining('never Allowed') },
    });
    expect(world.config.defaults.areas.reach).toBeUndefined();
  });

  it('refuses a request naming both an area and an action', async () => {
    const ask = {
      target: 'everyone',
      area: 'rooms',
      action: 'rooms.create',
      state: 'ask',
    };
    const { decision } = await call(ask);
    if (decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(decision.payload.approvalId);
    await expect(
      registry.invoke('permissions.change', ask, {
        identity: DORKBOT,
        approvalToken: decision.payload.approvalToken,
      })
    ).rejects.toMatchObject({ payload: { code: 'AREA_OR_ACTION' } });
  });
});
