/**
 * The `compact_my_session` declaration (DOR-2732), driven through the real
 * registry and the real permission gate: whose conversation it reaches, and
 * who decides whether the agent may ask.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../core/approvals/index.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { SESSION_COMPACT_CAPABILITY_ID, sessionDomain } from '../compaction-capabilities.js';
import type { AgentCompactionService } from '../agent-compaction-service.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/coordinator',
  displayName: 'Coordinator',
  createdAt: new Date().toISOString(),
};

describe('compact_my_session — the declaration', () => {
  let registry: CapabilityRegistry;
  let request: Mock<AgentCompactionService['request']>;
  let preset: PermissionPreset | null;
  let agent: AgentPermissions | undefined;

  beforeEach(() => {
    preset = null;
    agent = undefined;
    request = vi.fn<AgentCompactionService['request']>(async () => ({
      status: 'scheduled',
      message: 'Scheduled.',
    }));
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agent,
    });
    registry = composeRegistry([sessionDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      sessionCompactionDeps: { compaction: { request } },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  /** Call as the agent from `sessionId`, returning 'ran' or the gate's refusal. */
  async function callFrom(sessionId: string | undefined, input: unknown = {}) {
    try {
      await registry.invoke(SESSION_COMPACT_CAPABILITY_ID, input, {
        identity: AGENT,
        ...(sessionId !== undefined ? { sessionId } : {}),
        retryChannel: 'mcp-argument',
      });
      return 'ran' as const;
    } catch (err) {
      return (err as { decision: { payload: Record<string, unknown> } }).decision.payload;
    }
  }

  it('takes no session argument: its input names only the note', () => {
    const entry = registry
      .catalog()
      .capabilities.find((c) => c.id === SESSION_COMPACT_CAPABILITY_ID);
    expect(Object.keys((entry!.inputSchema as { properties: object }).properties)).toEqual([
      'note',
    ]);
  });

  it('is offered on the in-session server only, where a call has a session', () => {
    expect(sessionDomain.capabilities[0]!.surfaces.mcp).toMatchObject({
      toolName: 'compact_my_session',
      servers: ['in-session'],
    });
  });

  it('only ever reaches the session the call came from, whatever the input says', async () => {
    expect(await callFrom('session-a', { note: 'keep the plan', sessionId: 'session-b' })).toBe(
      'ran'
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ sessionId: 'session-a', note: 'keep the plan' });
  });

  it('passes no session at all when the call came from none, so the service refuses', async () => {
    await callFrom(undefined);
    expect(request).toHaveBeenCalledWith({});
  });

  it.each([null, 'careful', 'balanced', 'full'] as const)(
    'is allowed by default on the %s preset',
    async (chosen) => {
      preset = chosen;
      expect(await callFrom('session-a')).toBe('ran');
    }
  );

  it('is refused, with nothing scheduled, when the owner blocked it for this agent', async () => {
    preset = 'full';
    agent = { actions: { [SESSION_COMPACT_CAPABILITY_ID]: 'blocked' } };

    expect(await callFrom('session-a')).toMatchObject({
      status: 'denied',
      reason: 'permission_blocked',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
