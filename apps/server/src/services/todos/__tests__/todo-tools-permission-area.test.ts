/**
 * DOR-3953: every to-do tool follows the To-dos permission area, with `DORKOS_TODOS_ENABLED` on
 * and off. Before, the flag-gated `todos.*` tools (the ones that start another agent's turn) had
 * no area, so a person who set To-dos to Blocked still left the stronger tools running.
 *
 * Driven through the boot composer, the real registry and the real permission gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type {
  AgentPermissions,
  PermissionPreset,
  PermissionState,
} from '@dorkos/shared/permissions';

import { env } from '../../../env.js';
import { composeDorkOsCapabilityRegistry } from '../../core/self-description/dorkos-registry.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import type { CapabilityRegistry } from '../../core/capabilities/registry.js';
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
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-22T09:00:00.000Z',
};

/** Every to-do tool, flag-gated or not, with an input it accepts and whether it only reads. */
const CALLS = [
  ['todo_promises.add', { what: 'Send the made-up quote' }, 'write'],
  ['todo_promises.update', { id: 'todo-1', state: 'kept' }, 'write'],
  ['todo_promises.list', {}, 'read'],
  ['todos.add', { what: 'Draft the made-up brief', assignee: 'agent-bo' }, 'write'],
  ['todos.update', { id: 'todo-1', state: 'kept' }, 'write'],
  ['todos.list', {}, 'read'],
] as const;

/** The flag-gated ids, present only with the flag on. */
const FLAG_GATED = new Set(['todos.add', 'todos.update', 'todos.list']);

/** The flag, written directly: the registry reads it when it is composed. */
const flags = env as { DORKOS_TODOS_ENABLED: boolean };
const AMBIENT_FLAG = flags.DORKOS_TODOS_ENABLED;

describe.each([true, false])(
  'every to-do tool and the To-dos area, DORKOS_TODOS_ENABLED=%s (DOR-3953)',
  (flagOn) => {
    let registry: CapabilityRegistry;
    let reached: Mock;
    let preset: PermissionPreset | null;
    let defaults: {
      areas: Record<string, PermissionState>;
      actions: Record<string, PermissionState>;
    };
    let agent: AgentPermissions | undefined;

    /** The calls this registry carries: all six with the flag on, the promise three with it off. */
    const present = CALLS.filter(([id]) => flagOn || !FLAG_GATED.has(id));

    beforeEach(() => {
      flags.DORKOS_TODOS_ENABLED = flagOn;
      preset = null;
      defaults = { areas: {}, actions: {} };
      agent = undefined;
      reached = vi.fn(() => ({ id: 'todo-1' }));
      vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
      initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
      initPermissionGate({
        readConfig: () => ({ preset, defaults }),
        readAgentPermissions: async () => agent,
      });
      const deps: CapabilityDeps = {
        logger: noopLogger,
        todoPromiseDeps: {
          service: {
            create: reached,
            update: reached,
            list: vi.fn((...args: unknown[]) => (reached(...args), [])),
            get: vi.fn(() => undefined),
          } as never,
          agentIdForPath: () => 'agent-ana',
        },
        todoDeps: {
          todos: {
            create: reached,
            update: reached,
            list: vi.fn((...args: unknown[]) => (reached(...args), { todos: [] })),
          } as never,
          agentIdForPath: () => 'agent-ana',
          parentOf: () => undefined,
          readSource: () => undefined,
          agentInRoom: () => false,
        },
      };
      registry = composeDorkOsCapabilityRegistry(deps);
    });

    afterEach(() => {
      flags.DORKOS_TODOS_ENABLED = AMBIENT_FLAG;
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

    it(flagOn ? 'carries all six to-do tools' : 'carries only the promise tools', () => {
      const ids = registry.capabilities.map((c) => c.id).filter((id) => /^todo/.test(id));
      expect(ids.sort()).toEqual(present.map(([id]) => id).sort());
    });

    it('declares the To-dos area on every to-do tool it carries', () => {
      for (const capability of registry.capabilities.filter((c) => /^todo/.test(c.id))) {
        expect(capability.area, capability.id).toBe('todos');
      }
    });

    it('runs every to-do tool when nothing is set (the control)', async () => {
      for (const [id, input] of present) expect(await callAsAna(id, input), id).toBe('ran');
      expect(reached).toHaveBeenCalled();
    });

    it("refuses every to-do tool, reaching nothing, when the agent's To-dos area is Blocked", async () => {
      agent = { areas: { todos: 'blocked' } };
      for (const [id, input] of present) {
        expect(await callAsAna(id, input), id).toMatchObject({
          status: 'denied',
          reason: 'permission_blocked',
        });
      }
      expect(reached).not.toHaveBeenCalled();
    });

    it('refuses every to-do tool when the To-dos area is Blocked for everyone', async () => {
      defaults = { areas: { todos: 'blocked' }, actions: {} };
      for (const [id, input] of present) {
        expect(await callAsAna(id, input), id).toMatchObject({ reason: 'permission_blocked' });
      }
      expect(reached).not.toHaveBeenCalled();
    });

    it('asks before every writing to-do tool when the To-dos area is Ask', async () => {
      agent = { areas: { todos: 'ask' } };
      for (const [id, input] of present.filter(([, , kind]) => kind === 'write')) {
        expect(await callAsAna(id, input), id).toMatchObject({ status: 'approval_required' });
      }
      expect(reached).not.toHaveBeenCalled();
    });

    it('lets the reading to-do tools through on Ask, as every read is', async () => {
      agent = { areas: { todos: 'ask' } };
      for (const [id, input] of present.filter(([, , kind]) => kind === 'read')) {
        expect(await callAsAna(id, input), id).toBe('ran');
      }
    });

    it('runs every to-do tool when the To-dos area is Allowed', async () => {
      agent = { areas: { todos: 'allowed' } };
      for (const [id, input] of present) expect(await callAsAna(id, input), id).toBe('ran');
      expect(reached).toHaveBeenCalled();
    });

    if (!flagOn) {
      it('has no flag-gated to-do tool to reach at all', async () => {
        for (const id of FLAG_GATED) {
          expect(registry.get(id), id).toBeUndefined();
          await expect(registry.invoke(id, {}, { identity: ANA })).rejects.toThrow(
            /no capability registered/
          );
        }
        expect(reached).not.toHaveBeenCalled();
      });
    }
  }
);
