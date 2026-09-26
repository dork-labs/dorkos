/**
 * `permissions.change` (`change_permission`): an agent asking to change a
 * permission, which is always a person's yes (spec `agent-permissions` D9,
 * task 3.3). Driven through the real registry, the real gate, the real approval
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
import { ApprovalService, isAlwaysOffered } from '../../approvals/index.js';
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
    preset = 'full';
    own = undefined;
    world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
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

  it('asks every time, and changes nothing until a person answers', async () => {
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    expect(decision?.outcome).toBe('approval_required');
    expect(world.agentArea('agent-test', 'rooms')).toBeUndefined();
  });

  it('still asks when the agent itself holds an Allowed for it', async () => {
    // A stored Allowed on a floor-area action is refused on write and clamped on
    // read, so even a hand-edited file cannot make this run on its own.
    own = { actions: { 'permissions.change': 'allowed' } };
    const { decision } = await call(OPEN_TEST_BOT_ROOMS);
    expect(decision?.outcome).toBe('approval_required');
  });

  it('never offers Always allow on its card', async () => {
    await call(OPEN_TEST_BOT_ROOMS);
    const [pending] = approvals.listPending();
    expect(pending).toMatchObject({ area: 'permissions', alwaysOffered: false });
    expect(
      isAlwaysOffered({
        requestedByPath: DORKBOT.agentPath,
        area: 'permissions',
        authorityBindingDigest: null,
      })
    ).toBe(false);
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
