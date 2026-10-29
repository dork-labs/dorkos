/**
 * A turn that carries an outsider's words on runs at its agent's own level (DOR-3390), so the
 * mark has to stop what such words must never do unasked: send email, change a calendar, or make
 * a standing change every later turn inherits with no mark (Security's Must 4 and M-C on #3242).
 * Each asks in a carried turn and runs as before in an unmarked one, under Trusted.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { gatedActionForMcpTool } from '../../mcp-tool-tiers.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../permission-enforcement.js';
import { HELD_IN_A_MARKED_TURN, principalTurnOf } from '../marked-turn-holds.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/lifeos',
  displayName: 'LifeOS',
  createdAt: new Date().toISOString(),
};

let counter = 0;
const fresh = () => `marked-holds-${(counter += 1)}`;

/**
 * Run one turn in a chat set to `stored`. Accept edits by default: a chat set to Full asks
 * nobody anything (DOR-3394), so the holds below are pinned below Full. These turns ran at Full
 * until then.
 */
async function ran(sessionId: string, opts?: MessageOpts, stored = 'acceptEdits') {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** Every action the set names, as the gate receives it. */
function heldActions(): (GatedAction & PermissionGatedAction)[] {
  const registry = composeCapabilityRegistryForDocs().capabilities;
  return [...HELD_IN_A_MARKED_TURN].map(
    (id) => registry.find((capability) => capability.id === id) ?? gatedActionForMcpTool(id)
  );
}

/** What the gate decides for one call by LifeOS in this session. */
async function decide(action: GatedAction & PermissionGatedAction, sessionId: string) {
  const permission = await resolveCallPermission({ action, identity: AGENT, sessionId, input: {} });
  return enforceCapabilityTier({
    action,
    input: {},
    permission,
    identity: AGENT,
    retryChannel: 'mcp-argument',
  }).outcome;
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
});
afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  vi.restoreAllMocks();
});

describe('a carried turn asks before what outlives it or acts outside', () => {
  it('names every action the review asked for', () => {
    expect([...HELD_IN_A_MARKED_TURN].sort()).toEqual(
      expect.arrayContaining([
        'binding_create',
        'connectors.execute_write',
        'marketplace.install',
        'marketplace.update',
        'mcp.add',
        'operator.config_patch',
        'operator.update_agent',
      ])
    );
    // Each is a real action: the registry or the hand-tool table knows it.
    for (const action of heldActions()) expect(action.tier).not.toBe('observe');
  });

  for (const id of HELD_IN_A_MARKED_TURN) {
    it(`${id} asks in a carried turn`, async () => {
      const carried = fresh();
      await ran(carried, { permissionCeiling: CARRIED_OUTSIDER_LEVEL });
      const action = heldActions().find((a) => a.id === id)!;
      expect(await decide(action, carried)).toBe('approval_required');
    });
  }

  it('a connector write (Gmail send) asks in a carried turn and runs on an unmarked Full turn', async () => {
    const action = heldActions().find((a) => a.id === 'connectors.execute_write')!;
    const carried = fresh();
    const plain = fresh();
    await ran(carried, { permissionCeiling: CARRIED_OUTSIDER_LEVEL });
    await ran(plain, undefined, 'bypassPermissions');
    expect(
      await resolveCallPermission({ action, identity: AGENT, sessionId: carried, input: {} })
    ).toMatchObject({ area: 'connections', state: 'ask' });
    expect(await decide(action, carried)).toBe('approval_required');
    // Unmarked at Full: no area, so the tier decides, as before.
    expect(
      await resolveCallPermission({ action, identity: AGENT, sessionId: plain, input: {} })
    ).toBeNull();
    expect(await decide(action, plain)).toBe('allowed');
  });

  it('reads the turn a connector principal names, when the call carries nothing else', async () => {
    const action = heldActions().find((a) => a.id === 'connectors.execute_write')!;
    const carried = fresh();
    await ran(carried, { permissionCeiling: CARRIED_OUTSIDER_LEVEL });
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local' },
      agentPath: AGENT.agentPath,
      agentId: 'lifeos',
      canonicalSessionId: carried,
    } as never);
    expect(
      await resolveCallPermission({ action, input: {}, ...principalTurnOf(principal) })
    ).toMatchObject({ state: 'ask' });
    expect(principalTurnOf(undefined)).toEqual({});
  });

  it('the mark holds nothing in a chat set to Full: each decides as unmarked (DOR-3394)', async () => {
    const atFull = fresh();
    const plain = fresh();
    await ran(atFull, { permissionCeiling: CARRIED_OUTSIDER_LEVEL }, 'bypassPermissions');
    await ran(plain, undefined, 'bypassPermissions');
    for (const action of heldActions()) {
      expect(await decide(action, atFull), action.id).toBe(await decide(action, plain));
    }
    for (const id of ['connectors.execute_write', 'binding_create', 'marketplace.install']) {
      const action = heldActions().find((a) => a.id === id)!;
      expect(await decide(action, atFull), id).toBe('allowed');
    }
  });

  it('a standing change runs, recorded, in an unmarked turn under Trusted', async () => {
    const plain = fresh();
    await ran(plain);
    for (const id of ['binding_create', 'marketplace.install', 'operator.config_patch']) {
      const action = heldActions().find((a) => a.id === id)!;
      expect(await decide(action, plain)).toBe('allowed');
    }
  });
});
