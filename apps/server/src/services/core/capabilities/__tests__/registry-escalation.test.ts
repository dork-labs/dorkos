/**
 * Proof D6, fixture part (spec `computer-side-starts-alone` §5.1, step C8): a
 * capability's `escalate` field, run in `registry.invoke`, decides a call the
 * way the hand-registered tool gate decides it for a tool with an escalator
 * registered by name. Each case drives ONE escalator through both gates and
 * expects the same answer, so a tool moved from one to the other decides the
 * same either way.
 *
 * The hand gate needs a tool in its tier table, so `relay_enable_adapter`
 * stands in, with the fixture escalator registered under its name in place of
 * its own. The fixture capability copies that row's tier and area.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../mcp-tool-gate.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { defineCapability } from '../capability-definition.js';
import { composeRegistry, type CapabilityRegistry } from '../registry.js';
import {
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import { initPermissionGate, resetPermissionGate } from '../permission-enforcement.js';
import { registerPreGateRefusal } from '../pre-gate-refusals.js';
import { trustedCaller } from '../trusted-caller.js';
import {
  escalatedGrantFor,
  registerToolCallEscalator,
  type EscalatedGrant,
  type ToolCallEscalator,
} from '../tool-call-escalation.js';

const AGENT: AgentIdentity = {
  agentPath: '/made-up/agents/porter',
  displayName: 'Porter',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const HAND_TOOL = 'relay_enable_adapter';
const CAPABILITY = 'probe.enable';
const RAISED = 'probe.raised';
const CHANGE = 'Turn the probe connection back on, so its people can reach your agents.';

let config: PermissionConfigInput;
let approvals: ApprovalService;
let registry: CapabilityRegistry;
let unregister: () => void;
/** What the fixture escalator answers; each test sets it. */
let decide: ToolCallEscalator;
/** The action id each escalator call was asked about. */
let asked: string[];
/** The input object each handler received. */
let reached: unknown[];

/** Decide the call as {@link RAISED}, asking for a person unless it is Blocked. */
const raiseToCard: ToolCallEscalator = async ({ action, permission }) => ({
  action: { ...action, id: RAISED, title: 'Raise the probe' },
  permission:
    permission?.state === 'blocked'
      ? permission
      : { area: 'connections', state: 'ask', source: 'always-asks', layer: 'floor' },
  change: CHANGE,
});

/** The fixture escalator, as both gates ask it. */
const fixture: ToolCallEscalator = (call) => {
  asked.push(call.action.id);
  return decide(call);
};

const probeInput = z.object({ id: z.string() });

/** The fixture capability with an `escalate` field. */
const probe = defineCapability({
  id: CAPABILITY,
  title: 'Turn a chat connection on',
  description: 'A probe whose arguments can reach an action of their own.',
  tier: 'act',
  area: 'connections',
  approvalDisplayFields: ['id'],
  input: probeInput,
  output: z.object({ ran: z.boolean() }),
  surfaces: {},
  escalate: async (_deps, call) => fixture(call),
  invoke: async (_deps, input) => {
    reached.push(input);
    return { ran: true };
  },
});

/** The same probe, sealed by an early refusal (registered once, below). */
const sealed = defineCapability({ ...probe, id: 'probe.sealed' });
registerPreGateRefusal('probe.sealed', () => 'That folder is protected.');

/** The hand tool, behind the hand gate, as an agent's own chat. */
const handTool: SdkMcpTool = {
  name: HAND_TOOL,
  description: 'probe',
  inputSchema: {},
  handler: (async (input: unknown) => {
    reached.push(input);
    return { content: [{ type: 'text', text: JSON.stringify({ ran: true }) }] };
  }) as unknown as SdkMcpTool['handler'],
};

type Answer = Record<string, unknown>;

/** Each gate, called as an agent in its own chat; a refusal comes back as its payload. */
const GATES: Record<'registry' | 'hand', (input: unknown, token?: string) => Promise<Answer>> = {
  registry: async (input, token) => {
    try {
      return (await registry.invoke(CAPABILITY, input, {
        identity: AGENT,
        mcpServer: 'in-session',
        sessionId: 'ses-a',
        ...(token ? { approvalToken: token } : {}),
      })) as Answer;
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) return { ...err.decision.payload };
      throw err;
    }
  },
  hand: async (input, token) => {
    const [tool] = gateHandRegisteredMcpTools(
      [handTool],
      async () => ({ identity: AGENT }),
      undefined,
      () => ({ sessionId: 'ses-a' })
    );
    const args = { ...(input as object), ...(token ? { approvalToken: token } : {}) };
    const result = (await tool!.handler(args as never, {})) as CallToolResult;
    return JSON.parse((result.content[0] as { text: string }).text) as Answer;
  },
};

/** The gate's own action id: what an escalation that keeps the tool's action names. */
const OWN_ID = { registry: CAPABILITY, hand: HAND_TOOL } as const;

/** How the last call reached its handler, as the gate noted it. */
function lastGrant(): EscalatedGrant | undefined {
  return escalatedGrantFor(reached.at(-1));
}

beforeEach(() => {
  asked = [];
  reached = [];
  decide = raiseToCard;
  config = { preset: 'trusted', defaults: { areas: {}, actions: {} } };
  approvals = new ApprovalService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  initPermissionGate({ readConfig: () => config });
  registry = composeRegistry([{ name: 'probe', capabilities: [probe, sealed] }], {
    logger: noopLogger,
  });
  unregister = registerToolCallEscalator(HAND_TOOL, fixture);
});

afterEach(() => {
  unregister();
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

describe.each(['registry', 'hand'] as const)('an escalator on the %s gate', (gate) => {
  const call = GATES[gate];

  it('raises its own escalated card, and the yes lets this exact call through, noted', async () => {
    const first = await call({ id: 'tg' });
    expect(first).toMatchObject({
      status: 'approval_required',
      capabilityId: RAISED,
      capabilityTitle: 'Raise the probe',
    });
    expect(asked).toEqual([OWN_ID[gate]]);
    expect(reached).toEqual([]);
    expect(JSON.stringify(approvals.listPending())).toContain(CHANGE);

    approvals.grant(first.approvalId as string);
    expect(await call({ id: 'tg' }, first.approvalToken as string)).toEqual({ ran: true });
    expect(lastGrant()).toEqual({
      actionId: RAISED,
      via: 'card',
      approvalId: first.approvalId,
      origin: 'session',
      change: CHANGE,
    });
  });

  it('notes a grant a setting allowed, with no card', async () => {
    decide = async ({ action }) => ({
      action: { ...action, id: RAISED, title: 'Raise the probe' },
      permission: { area: 'connections', state: 'allowed', source: 'preset', layer: 'default' },
    });
    expect(await call({ id: 'tg' })).toEqual({ ran: true });
    expect(lastGrant()).toEqual({ actionId: RAISED, via: 'allowed', origin: 'session' });
  });

  it('is told a Blocked permission, and cannot lift it by deciding the call as another action', async () => {
    config.defaults.areas.connections = 'blocked';
    let told: string | undefined;
    decide = async ({ action, permission }) => {
      told = permission?.state;
      return {
        action: { ...action, id: RAISED },
        permission: { area: 'connections', state: 'allowed', source: 'preset', layer: 'default' },
      };
    };
    const answer = await call({ id: 'tg' });
    expect(told).toBe('blocked');
    expect(answer).toMatchObject({ status: 'denied', reason: 'permission_blocked' });
    expect(reached).toEqual([]);
  });

  it('cannot lower an Ask to Allowed by deciding the call as another action', async () => {
    config.defaults.areas.connections = 'ask';
    decide = async ({ action }) => ({
      action: { ...action, id: RAISED },
      permission: { area: 'connections', state: 'allowed', source: 'preset', layer: 'default' },
    });
    expect(await call({ id: 'tg' })).toMatchObject({
      status: 'approval_required',
      capabilityId: RAISED,
    });
    expect(reached).toEqual([]);
  });

  it('cannot lower the tier, so a read-tier answer still asks', async () => {
    config.defaults.areas.connections = 'ask';
    decide = async ({ action, permission }) => ({
      action: { ...action, id: RAISED, tier: 'observe' },
      permission,
    });
    expect(await call({ id: 'tg' })).toMatchObject({ status: 'approval_required' });
    expect(reached).toEqual([]);
  });

  it('may let a call through as its own action, for the handler to refuse', async () => {
    // The one looser answer (the tool refuses a call nobody could approve
    // whole): the note names the tool's own action, never the one it reaches.
    config.defaults.areas.connections = 'ask';
    decide = async ({ action }) => ({
      action,
      permission: { area: 'connections', state: 'allowed', source: 'floor', layer: 'floor' },
    });
    expect(await call({ id: 'tg' })).toEqual({ ran: true });
    expect(lastGrant()).toEqual({ actionId: OWN_ID[gate], via: 'allowed', origin: 'session' });
  });

  it('refuses the call with no card when the escalator throws', async () => {
    decide = async () => {
      throw new Error('cannot read the task');
    };
    expect(await call({ id: 'tg' })).toMatchObject({ status: 'denied', approvable: false });
    expect(approvals.listPending()).toEqual([]);
    expect(reached).toEqual([]);
  });

  it('leaves a call it returns null for to the tool’s own permission', async () => {
    decide = async () => null;
    expect(await call({ id: 'tg' })).toEqual({ ran: true });
    expect(lastGrant()).toBeUndefined();
  });
});

describe('a capability escalator is not asked', () => {
  it('when the input does not parse', async () => {
    await expect(registry.invoke(CAPABILITY, { id: 7 }, { identity: AGENT })).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it('when an early refusal answers first', async () => {
    await expect(
      registry.invoke('probe.sealed', { id: 'tg' }, { identity: AGENT })
    ).rejects.toMatchObject({ decision: { outcome: 'denied' } });
    expect(asked).toEqual([]);
  });

  it('for a trusted caller, a person whom no agent permission governs', async () => {
    const trusted = trustedCaller({
      agentIdentityPresented: false,
      approvalTokenPresented: false,
      loginEnabled: () => false,
    })!;
    expect(await registry.invoke(CAPABILITY, { id: 'tg' }, { trusted })).toEqual({ ran: true });
    expect(asked).toEqual([]);
    expect(lastGrant()).toBeUndefined();
  });
});
