/**
 * Keeper 1 at Full (DOR-3417): an agent changing a level or a standing grant is refused at every
 * level: `change_permission` loosening a permission, and `config_patch` reaching a setting only a
 * person may change. Below Full that refusal is a card for a person; a chat set to Full asks nobody, so a
 * marked turn there is refused with a plain reason and one Activity line, never a card.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { resetChosenTurns, setMarkedFullActivity } from '../../turn-power/full-autonomy.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../tier-enforcement.js';
import {
  initPermissionGate,
  MARKED_FULL_PERMISSION_REFUSAL,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../permission-enforcement.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/lifeos',
  displayName: 'LifeOS',
  createdAt: new Date().toISOString(),
};

let counter = 0;
const fresh = () => `marked-full-keeper-${(counter += 1)}`;

/** Run one turn in a chat set to `stored`. */
async function ran(sessionId: string, stored: string, opts?: MessageOpts) {
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

/** A capability, as the gate receives it. */
function capability(id: string): GatedAction & PermissionGatedAction {
  const found = composeCapabilityRegistryForDocs().capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`${id} is not registered`);
  return found as unknown as GatedAction & PermissionGatedAction;
}

/** What the gate decides for one call of `id` by LifeOS in this session. */
async function decide(
  sessionId: string,
  input: Record<string, unknown>,
  id = 'permissions.change'
) {
  const action = capability(id);
  const permission = await resolveCallPermission({ action, identity: AGENT, sessionId, input });
  return enforceCapabilityTier({
    action,
    input,
    permission,
    identity: AGENT,
    retryChannel: 'mcp-argument',
  });
}

const LOOSEN = { target: 'everyone', area: 'tasks', state: 'allowed' };
const TIGHTEN = { target: 'everyone', area: 'tasks', state: 'blocked' };
const MARKED: MessageOpts = { permissionCeiling: 'runtime-default' };

const emit = vi.fn(async () => undefined);

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
  emit.mockClear();
  setMarkedFullActivity({ emit } as never);
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
  resetChosenTurns();
  setMarkedFullActivity(undefined);
  vi.restoreAllMocks();
});

describe('change_permission in a marked turn (DOR-3417)', () => {
  it('at Full, loosening is refused with a plain reason, no card, and one Activity line', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions', MARKED);
    const decision = await decide(session, LOOSEN);
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    expect(decision.payload.message).toBe(MARKED_FULL_PERMISSION_REFUSAL);
    expect(decision.payload.approvable).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      eventType: 'agent.marked_full_action',
      resourceId: 'permissions.change',
      metadata: { refused: true, sessionId: session },
    });
  });

  it('at Full, tightening to Blocked is not refused', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions', MARKED);
    const decision = await decide(session, TIGHTEN);
    expect(decision.outcome).not.toBe('denied');
    expect(emit).not.toHaveBeenCalled();
  });

  it('below Full, loosening still raises its card, with no Activity line', async () => {
    const session = fresh();
    await ran(session, 'acceptEdits', MARKED);
    expect((await decide(session, LOOSEN)).outcome).toBe('approval_required');
    expect(emit).not.toHaveBeenCalled();
  });

  it('at Full in an unmarked turn, nothing changes: loosening still asks', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions');
    expect((await decide(session, LOOSEN)).outcome).toBe('approval_required');
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('config_patch in a marked turn (DOR-3417)', () => {
  const PERSON_ONLY = { patch: { server: { boundary: '/' } } };
  const PREFERENCE = { patch: { ui: { theme: 'dark' } } };

  it('at Full, a patch reaching a person’s setting is refused plainly, no card, one line', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions', MARKED);
    const decision = await decide(session, PERSON_ONLY, 'operator.config_patch');
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') return;
    // Named since DOR-3426: the setting and the area it belongs to.
    expect(decision.payload.message).toContain('`server.boundary` (Reach & secrets)');
    expect(decision.payload.approvable).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      resourceId: 'operator.config_patch',
      metadata: { refused: true },
    });
  });

  it('at Full, a plain preference is not refused', async () => {
    const session = fresh();
    await ran(session, 'bypassPermissions', MARKED);
    const decision = await decide(session, PREFERENCE, 'operator.config_patch');
    expect(decision.outcome).not.toBe('denied');
    expect(emit.mock.calls.some((c) => JSON.stringify(c).includes('"refused":true'))).toBe(false);
  });

  it('below Full, a patch reaching a person’s setting still raises its card', async () => {
    const session = fresh();
    await ran(session, 'acceptEdits', MARKED);
    expect((await decide(session, PERSON_ONLY, 'operator.config_patch')).outcome).toBe(
      'approval_required'
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
