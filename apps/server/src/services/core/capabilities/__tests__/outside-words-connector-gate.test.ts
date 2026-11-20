/**
 * A turn noted as having read words from outside the team (`noteRoomTurnWords`: a room turn that
 * answered a mini app's post, a stranger on a bridged chat, or another chat that had read such
 * words) is held by the connector gates exactly as a turn carrying the outsider mark is (DOR-4587).
 * At Full, a send that reaches people outside the team asks, and a destructive action keeps its
 * card instead of the cancel window; a draft still runs unasked. Below Full, both ask. The note
 * is per turn: the chat's next clean room turn clears it.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime, MessageOpts, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../turn-power/turn-levels.js';
import { noteRoomTurnWords } from '../../turn-power/outside-words.js';
import { chatReadOutsideWords } from '../../turn-power/chat-outside-words.js';
import { setContinuationHoldDb } from '../../turn-power/continuation-hold.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { runtimeRegistry } from '../../runtime-registry.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { createCapabilityAuthorityBinding } from '../../../connectors/principal/capability-authority-binding.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import {
  holdRequesterFor,
  type HoldEligibilitySources,
} from '../../../connectors/execution/destructive-hold-window.js';
import { composeRegistry, defineCapability } from '../index.js';
import type { CapabilityInvocationContext, CapabilityPreflightResult } from '../registry.js';
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
const fresh = () => `outside-words-${(counter += 1)}`;

/** Run one turn in a chat set to `stored`: clean unless `opts` carries a mark. */
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

/** A clean turn in `stored` whose room turn answered words from outside the team. */
async function ranAnsweringOutsideWords(sessionId: string, stored: string) {
  noteRoomTurnWords(sessionId, true);
  await ran(sessionId, stored);
}

/** A stand-in for `connectors.execute_write`, whose preflight reads a send as outward. */
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

/** Invoke one operation as LifeOS in `sessionId`; what ran lands in `sent`. */
async function invoke(sessionId: string, operation: 'send' | 'draft', sent: string[]) {
  const registry = composeRegistry([{ name: 'connectors', capabilities: [connectorWrite(sent)] }], {
    logger: noopLogger,
  });
  return registry.invoke('connectors.execute_write', { operation }, { identity: AGENT, sessionId });
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

describe('a connected-app send at Full from a turn that answered outside words', () => {
  it('shows a card and sends nothing', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'bypassPermissions');
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).rejects.toMatchObject({
      decision: { outcome: 'approval_required' },
    });
    expect(sent).toEqual([]);
  });

  it('still runs a draft with no card', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'bypassPermissions');
    const sent: string[] = [];
    await expect(invoke(chat, 'draft', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['draft']);
  });

  it('asks when only the turn-bound principal names the chat', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'bypassPermissions');
    const action = { id: 'connectors.execute_write', tier: 'act' as const, area: null };
    expect(
      await resolveCallPermission({
        action,
        principalTurn: { sessionId: chat, agentPath: AGENT.agentPath },
        outward: true,
      })
    ).toMatchObject({ area: 'connections', state: 'ask' });
  });

  it('sends with no card once the next room turn answered only the team', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'bypassPermissions');
    noteRoomTurnWords(chat, false);
    await ran(chat, 'bypassPermissions');
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });
});

describe('a connected-app send at Full from a Telegram or Slack stranger', () => {
  it('shows a card and sends nothing', async () => {
    const chat = fresh();
    // What the bridge sends with a turn a non-owner's message starts (DOR-3858).
    await ran(chat, 'bypassPermissions', { carriedMarks: { outsider: true } });
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).rejects.toMatchObject({
      decision: { outcome: 'approval_required' },
    });
    expect(sent).toEqual([]);
  });
});

describe("a connected-app send at Full from the owner's own Telegram or Slack", () => {
  it('sends with no card: trust follows who wrote, not which app carried it', async () => {
    const chat = fresh();
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockReturnValue('relay-binding');
    // The bridge marks nothing for an account on the connection's approver allowlist.
    await ran(chat, 'bypassPermissions');
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });
});

describe('local work from a turn that answered outside words', () => {
  // The mark holds outward, destructive and standing actions only; the turn keeps its level.
  const localWrite = { id: 'files.write_note', tier: 'act' as const, area: null };

  it('runs unasked on a turn carrying the mark itself, at Full and below Full', async () => {
    for (const stored of ['bypassPermissions', 'acceptEdits']) {
      const chat = fresh();
      await ran(chat, stored, { carriedMarks: { outsider: true } });
      expect(
        await resolveCallPermission({ action: localWrite, identity: AGENT, sessionId: chat }),
        stored
      ).toBeNull();
    }
  });

  it('runs unasked at Full and below Full', async () => {
    for (const stored of ['bypassPermissions', 'acceptEdits']) {
      const chat = fresh();
      await ranAnsweringOutsideWords(chat, stored);
      expect(
        await resolveCallPermission({ action: localWrite, identity: AGENT, sessionId: chat }),
        stored
      ).toBeNull();
    }
  });
});

describe('a connected-app write below Full from a turn that answered outside words', () => {
  it('a clean turn at the same level sends with no card', async () => {
    const chat = fresh();
    await ran(chat, 'acceptEdits');
    const sent: string[] = [];
    await expect(invoke(chat, 'send', sent)).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });

  it('asks for a send and a draft', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'acceptEdits');
    for (const operation of ['send', 'draft'] as const) {
      const sent: string[] = [];
      await expect(invoke(chat, operation, sent), operation).rejects.toMatchObject({
        decision: { outcome: 'approval_required' },
      });
      expect(sent).toEqual([]);
    }
  });
});

describe('a destructive connected-app call from a turn that answered outside words', () => {
  const FULL: TurnPermissionLevel = { asks: 'never', reach: 'everything' };
  const preflight = {
    approvalServiceAction: { actionName: 'Delete email', serviceName: 'Gmail' },
    authorityBinding: { approvalScope: { digest: 'digest-a' } },
  } as unknown as CapabilityPreflightResult;

  /** A Trusted install, a known agent, Wi-Fi closed; the stranger check is the live one. */
  const sources: Omit<HoldEligibilitySources, 'strangerTurn'> = {
    trusted: () => true,
    describeAgent: async () => AGENT,
    turnLevel: () => FULL,
    plainWifiOpen: () => false,
    chosenFull: () => true,
  };

  /** The context a turn-bound runtime principal for `sessionId` presents. */
  function contextFor(sessionId: string): CapabilityInvocationContext {
    return {
      identity: AGENT,
      sessionId,
      serverPrincipal: createServerPrincipal({
        kind: 'runtime',
        owner: { kind: 'local_install', installationId: 'install-a' },
        bindingId: 'binding-a',
        runtime: 'claude-code',
        canonicalSessionId: sessionId,
        agentId: 'agent-lifeos',
        agentPath: AGENT.agentPath,
        canonicalCwd: AGENT.agentPath,
      }),
    } as unknown as CapabilityInvocationContext;
  }

  it('keeps its card at Full instead of the cancel window', async () => {
    const chat = fresh();
    await ranAnsweringOutsideWords(chat, 'bypassPermissions');
    expect(await holdRequesterFor(contextFor(chat), preflight, sources)).toBeUndefined();
  });

  it('a clean turn at Full still waits out the cancel window', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    expect(await holdRequesterFor(contextFor(chat), preflight, sources)).toMatchObject({
      sessionId: chat,
    });
  });
});

// Security M1 on 8cfce13: a continuation turn (a verdict wake, a resume) of a stranger's bridged
// chat carries no mark of its own, so what its words carry on reads whose words the chat holds,
// which a continuation never writes (DOR-4593).
describe('words a bridged chat sends on after a continuation turn', () => {
  beforeEach(() => setContinuationHoldDb(createTestDb()));
  afterEach(() => setContinuationHoldDb(undefined));

  it("a stranger's still carry outside words", async () => {
    const chat = fresh();
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockReturnValue('relay-binding');
    await ran(chat, 'bypassPermissions', { carriedMarks: { outsider: true } });
    await ran(chat, 'bypassPermissions', {
      permissionCeiling: 'runtime-default',
      continuationHold: true,
    });
    expect(chatReadOutsideWords(chat, AGENT.agentPath, true)).toBe(true);
  });

  it("the owner's own linked chat's stay clean", async () => {
    const chat = fresh();
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockReturnValue('relay-binding');
    await ran(chat, 'bypassPermissions', { turnStarter: 'telegram' });
    await ran(chat, 'bypassPermissions', {
      permissionCeiling: 'runtime-default',
      continuationHold: true,
    });
    expect(chatReadOutsideWords(chat, AGENT.agentPath, true)).toBe(false);
  });
});
