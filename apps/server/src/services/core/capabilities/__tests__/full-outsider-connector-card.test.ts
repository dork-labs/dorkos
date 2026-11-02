/**
 * At Full autonomy, a turn that read an outsider's words asks a person before a connected-app
 * action that reaches people outside the team or cannot be undone (DOR-3683). It narrows the
 * owner's "Full asks nobody" rule (DOR-3394) for that one class and loosens nothing: a draft or a
 * read at Full runs unasked, a clean turn at Full runs unasked, and below Full a marked turn
 * asks as before.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { createCapabilityAuthorityBinding } from '../../../connectors/principal/capability-authority-binding.js';
import { composeRegistry, defineCapability } from '../index.js';
import { initCapabilityTierGate, resetCapabilityTierGate } from '../tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
} from '../permission-enforcement.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/lifeos',
  displayName: 'LifeOS',
  createdAt: new Date().toISOString(),
};

let counter = 0;
const fresh = () => `full-outsider-${(counter += 1)}`;

/** Run one turn in a chat set to `stored`, optionally carrying an outsider's words. */
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

const marked = { permissionCeiling: CARRIED_OUTSIDER_LEVEL } satisfies MessageOpts;

/**
 * A stand-in for `connectors.execute_write`: its preflight says whether the call reaches people
 * outside, as the real one does from the stored operation (`reaches-outside.ts`), and its
 * handler records what ran.
 */
function connectorWrite(sent: string[]) {
  return defineCapability({
    id: 'connectors.execute_write',
    title: 'Change something in a connected app',
    description: 'Test stand-in for a connected-app write.',
    tier: 'act',
    area: null,
    input: z.object({ operation: z.enum(['send', 'draft']) }),
    output: z.object({ ok: z.boolean() }),
    surfaces: {},
    preflight: async (_deps, input) => ({
      authorityBinding: createCapabilityAuthorityBinding({
        digest: `authority-${input.operation}`,
        ownerKind: 'local_install',
        ownerId: 'install-a',
        agentId: 'lifeos',
        connectionId: 'gmail-a',
        operationRevisionId: input.operation,
      }),
      outward: input.operation === 'send',
    }),
    invoke: async (_deps, input) => {
      sent.push(input.operation);
      return { ok: true };
    },
  });
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetChosenTurns();
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
  resetChosenTurns();
  vi.restoreAllMocks();
});

describe('a Gmail send at Full, through the registry', () => {
  /** Invoke one operation as LifeOS in `sessionId`; what ran lands in `sent`. */
  async function invoke(sessionId: string, operation: 'send' | 'draft', sent: string[]) {
    const registry = composeRegistry(
      [{ name: 'connectors', capabilities: [connectorWrite(sent)] }],
      { logger: noopLogger }
    );
    return registry.invoke(
      'connectors.execute_write',
      { operation },
      {
        identity: AGENT,
        sessionId,
      }
    );
  }

  it('after outsider words, shows a card and sends nothing', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions', marked);
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).rejects.toMatchObject({
      decision: { outcome: 'approval_required' },
    });
    expect(sent).toEqual([]);
  });

  it('on a clean turn, sends with no card', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });

  it('after outsider words, a draft still runs with no card', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions', marked);
    const sent: string[] = [];
    await expect(invoke(chat, 'draft', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['draft']);
  });

  it('below Full, a marked turn asks for a send and a draft, as before', async () => {
    const chat = fresh();
    await ran(chat, 'acceptEdits', marked);
    for (const operation of ['send', 'draft'] as const) {
      const sent: string[] = [];
      await expect(invoke(chat, operation, sent), operation).rejects.toMatchObject({
        decision: { outcome: 'approval_required' },
      });
      expect(sent).toEqual([]);
    }
  });
});

describe('the permission a marked Full turn resolves for a connector write', () => {
  const action = { id: 'connectors.execute_write', tier: 'act' as const, area: null };

  it('asks under Connections unless the preflight read the call as staying in the account', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions', marked);
    const ask = { area: 'connections', state: 'ask' };
    // Unknown counts as outward: a surface with no preflight cannot let a send through.
    expect(await resolveCallPermission({ action, identity: AGENT, sessionId: chat })).toMatchObject(
      ask
    );
    expect(
      await resolveCallPermission({ action, identity: AGENT, sessionId: chat, outward: true })
    ).toMatchObject(ask);
    expect(
      await resolveCallPermission({ action, identity: AGENT, sessionId: chat, outward: false })
    ).toBeNull();
  });

  it('a clean Full turn resolves nothing, outward or not', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    expect(await resolveCallPermission({ action, identity: AGENT, sessionId: chat })).toBeNull();
  });
});
