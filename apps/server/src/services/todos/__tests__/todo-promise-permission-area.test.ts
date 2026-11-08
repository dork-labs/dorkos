/**
 * DOR-3936: the three to-do promise tools are decided in their own To-dos area (`todos`), driven
 * through the real registry and the real permission gate. Before, they had no area, so a person's
 * Blocked stored for one of them was read by nothing and the call still ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { foldRenamedPermissionActions } from '@dorkos/shared/mesh-schemas';
import type {
  AgentPermissions,
  PermissionPreset,
  PermissionState,
} from '@dorkos/shared/permissions';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { renameTodoPromiseActions } from '../../core/config-manager.js';
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import { todoPromisesDomain } from '../todo-promise-capabilities.js';
import type { TodoPromiseService } from '../todo-promise-service.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-08T09:00:00.000Z',
};

/** Each tool, with an input it accepts. */
const CALLS = [
  ['todo_promises.add', { what: 'Send the made-up quote' }],
  ['todo_promises.update', { id: 'todo-1', state: 'kept' }],
  ['todo_promises.list', {}],
] as const;

describe('the to-do promise tools — the To-dos permission area (DOR-3936)', () => {
  let registry: CapabilityRegistry;
  let service: {
    create: Mock<TodoPromiseService['create']>;
    update: Mock<TodoPromiseService['update']>;
    list: Mock<TodoPromiseService['list']>;
  };
  let preset: PermissionPreset | null;
  let defaults: {
    areas: Record<string, PermissionState>;
    actions: Record<string, PermissionState>;
  };
  let agent: AgentPermissions | undefined;

  beforeEach(() => {
    preset = null;
    defaults = { areas: {}, actions: {} };
    agent = undefined;
    service = {
      create: vi.fn(() => ({ id: 'todo-1' }) as never),
      update: vi.fn(() => ({ id: 'todo-1' }) as never),
      list: vi.fn(() => []),
    };
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset, defaults }),
      readAgentPermissions: async () => agent,
    });
    registry = composeRegistry([todoPromisesDomain], {
      logger: noopLogger,
      todoPromiseDeps: { service, agentIdForPath: () => 'agent-ana' },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  /** Call as Ana, returning 'ran' or the gate's refusal payload. */
  async function callAsAna(id: string, input: unknown) {
    try {
      await registry.invoke(id, input, {
        identity: ANA,
        sessionId: 'session-ana',
        retryChannel: 'mcp-argument',
      });
      return 'ran' as const;
    } catch (err) {
      const decision = (err as { decision?: { payload: Record<string, unknown> } }).decision;
      if (!decision) throw err;
      return decision.payload;
    }
  }

  /** How many times the service was reached, across all three tools. */
  function serviceCalls(): number {
    return (
      service.create.mock.calls.length +
      service.update.mock.calls.length +
      service.list.mock.calls.length
    );
  }

  it('declares the To-dos area on all three', () => {
    for (const capability of todoPromisesDomain.capabilities) {
      expect(capability.area, capability.id).toBe('todos');
    }
  });

  it.each([null, 'careful', 'balanced', 'full', 'trusted'] as const)(
    'runs all three by default on the %s preset (the control)',
    async (chosen) => {
      preset = chosen;
      for (const [id, input] of CALLS) expect(await callAsAna(id, input), id).toBe('ran');
      expect(serviceCalls()).toBe(3);
    }
  );

  it.each(CALLS)(
    'refuses %s, reaching nothing, when the agent has it Blocked',
    async (id, input) => {
      agent = { actions: { [id]: 'blocked' } };
      expect(await callAsAna(id, input)).toMatchObject({
        status: 'denied',
        reason: 'permission_blocked',
      });
      expect(serviceCalls()).toBe(0);
    }
  );

  it.each(CALLS)('refuses %s when the To-dos area is Blocked for everyone', async (id, input) => {
    defaults = { areas: { todos: 'blocked' }, actions: {} };
    expect(await callAsAna(id, input)).toMatchObject({ reason: 'permission_blocked' });
    expect(serviceCalls()).toBe(0);
  });

  it.each(CALLS)('refuses %s when the action is Blocked for everyone', async (id, input) => {
    defaults = { areas: {}, actions: { [id]: 'blocked' } };
    expect(await callAsAna(id, input)).toMatchObject({ reason: 'permission_blocked' });
    expect(serviceCalls()).toBe(0);
  });

  it.each(CALLS.slice(0, 2))('asks before %s when the To-dos area is Ask', async (id, input) => {
    agent = { areas: { todos: 'ask' } };
    expect(await callAsAna(id, input)).toMatchObject({ status: 'approval_required' });
    expect(serviceCalls()).toBe(0);
  });

  it('lets todo_promises.list through on Ask, as every read is (only Blocked stops a read)', async () => {
    agent = { areas: { todos: 'ask' } };
    expect(await callAsAna(...CALLS[2])).toBe('ran');
  });

  it('blocks only the action named, and leaves the other two running', async () => {
    agent = { actions: { 'todo_promises.add': 'blocked' } };
    expect(await callAsAna(...CALLS[0])).toMatchObject({ reason: 'permission_blocked' });
    expect(await callAsAna(...CALLS[1])).toBe('ran');
    expect(await callAsAna(...CALLS[2])).toBe('ran');
  });

  it('is not decided by another area a person set', async () => {
    agent = { areas: { agents: 'blocked', tasks: 'blocked', own_chat: 'blocked' } };
    for (const [id, input] of CALLS) expect(await callAsAna(id, input), id).toBe('ran');
  });

  it.each([
    ['commitments.add', ...CALLS[0]],
    ['commitments.update', ...CALLS[1]],
    ['commitments.list', ...CALLS[2]],
  ] as const)(
    "applies an agent's Blocked stored under the pre-0.133 id %s",
    async (oldId, id, input) => {
      // The manifest read every agent file goes through folds the old id to the new one.
      const raw = foldRenamedPermissionActions({
        permissions: { actions: { [oldId]: 'blocked' } },
      });
      agent = (raw as { permissions: AgentPermissions }).permissions;
      expect(await callAsAna(id, input)).toMatchObject({ reason: 'permission_blocked' });
      expect(serviceCalls()).toBe(0);
    }
  );

  it.each([
    ['commitments.add', ...CALLS[0]],
    ['commitments.update', ...CALLS[1]],
    ['commitments.list', ...CALLS[2]],
  ] as const)(
    'applies an everyone Blocked stored in config under the pre-0.133 id %s',
    async (oldId, id, input) => {
      // The 0.133.0 config migration moves the old id; the gate then reads the moved setting.
      const stored: Record<string, unknown> = {
        permissions: { preset: null, defaults: { areas: {}, actions: { [oldId]: 'blocked' } } },
      };
      renameTodoPromiseActions({
        get: (key) => stored[key],
        set: (key, value) => {
          stored[key] = value;
        },
      });
      defaults = (stored.permissions as { defaults: typeof defaults }).defaults;
      expect(defaults.actions).toEqual({ [id]: 'blocked' });
      expect(await callAsAna(id, input)).toMatchObject({ reason: 'permission_blocked' });
      expect(serviceCalls()).toBe(0);
    }
  );
});
