/**
 * A directly bound Telegram turn carries DOR-3858's outsider mark through the
 * relay runtime seam, and a connected-app send from it is driven all the way
 * through the capability registry: a stranger at Full is held by default
 * (DOR-4453), the owner on the approver list is not, and nothing is held with
 * the flag switched off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentRuntimeLike, RelayPublisher } from '@dorkos/relay';
import { handleAgentMessage } from '../../../../../../packages/relay/src/adapters/claude-code/agent-handler.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, marksOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { wordsAreUntrusted } from '../platform-identity.js';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { composeRegistry, defineCapability } from '../../core/capabilities/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import { createCapabilityAuthorityBinding } from '../../connectors/principal/capability-authority-binding.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { env } from '../../../env.js';

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0);
const AGENT_PATH = '/agents/scout';

interface RelayTurnResult {
  sessionId: string;
  level: TurnPermissionLevel;
  marked: boolean;
}

function envelope(subject: string, senderId: string, approvers: readonly string[]): RelayEnvelope {
  const payload = {
    content: 'send the launch update',
    platformData: { chatType: 'private', fromId: senderId },
  };
  return {
    id: `message-${senderId}`,
    subject,
    from: 'relay.human.telegram.bot-example.private-chat',
    replyTo: 'relay.inbox.power-example',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: NOW + 60_000,
      callBudgetRemaining: 8,
    },
    createdAt: new Date(NOW).toISOString(),
    payload: {
      ...payload,
      __untrustedWords: wordsAreUntrusted(payload, undefined, approvers),
      __bindingPermissions: { permissionMode: 'bypassPermissions' },
    },
  };
}

/**
 * Run one Telegram-bound turn through the relay handler and level recorder. Leave
 * `markStrangerTurns` out to use this boot's parsed flag, the value the adapter factory hands the
 * handler (`adapter-factory-stranger-mark.test.ts` pins that wiring).
 */
async function runTelegramTurn(input: {
  senderId: string;
  approvers: readonly string[];
  markStrangerTurns?: boolean;
}): Promise<RelayTurnResult> {
  const subject = `relay.agent.default.scout-${input.senderId}`;
  let sentSessionId = '';
  const base = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    ensureSession: vi.fn(),
    sendMessage(sessionId: string): AsyncGenerator<StreamEvent> {
      sentSessionId = sessionId;
      return (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })();
    },
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as AgentRuntime;
  const runtime = recordTurnLevels(base, () => 'bypassPermissions');
  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'reply-power-example', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  await handleAgentMessage(
    subject,
    envelope(subject, input.senderId, input.approvers),
    { agent: { directory: AGENT_PATH } } as never,
    NOW,
    {
      agentManager: runtime as unknown as AgentRuntimeLike,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      markStrangerTurns: input.markStrangerTurns ?? env.DORKOS_MARK_STRANGER_TURNS,
      now: () => NOW,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    relay
  );

  return {
    sessionId: sentSessionId,
    level: lastTurnLevelOf(sentSessionId)!,
    marked: marksHold(marksOf(sentSessionId, AGENT_PATH)),
  };
}

beforeEach(() => {
  resetChosenTurns();
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
});

afterEach(() => {
  resetPermissionGate();
  resetChosenTurns();
});

/**
 * A stand-in for `connectors.execute_write`, as `full-outsider-connector-card.test.ts` builds it:
 * its preflight reads a send as reaching people outside (`reaches-outside.ts`) and its handler
 * records what ran.
 */
function connectorSendCapability(sent: string[]) {
  return defineCapability({
    id: 'connectors.execute_write',
    title: 'Change something in a connected app',
    description: 'Test stand-in for a connected-app send.',
    tier: 'act',
    area: null,
    input: z.object({ operation: z.literal('send') }),
    output: z.object({ ok: z.boolean() }),
    surfaces: {},
    preflight: async () => ({
      authorityBinding: createCapabilityAuthorityBinding({
        digest: 'authority-send',
        ownerKind: 'local_install',
        ownerId: 'install-example',
        agentId: 'scout',
        connectionId: 'gmail-example',
        operationRevisionId: 'send',
      }),
      outward: true,
    }),
    invoke: async (_deps, input) => {
      sent.push(input.operation);
      return { ok: true };
    },
  });
}

describe('a connected-app send from a bridged Telegram turn at Full (DOR-3858)', () => {
  beforeEach(() => {
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
  });
  afterEach(() => {
    resetCapabilityTierGate();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  /** Send through the registry from the turn's session; what ran lands in the returned list. */
  async function send(turn: RelayTurnResult): Promise<{ result: unknown; sent: string[] }> {
    const sent: string[] = [];
    const registry = composeRegistry(
      [{ name: 'connectors', capabilities: [connectorSendCapability(sent)] }],
      { logger: noopLogger }
    );
    const result = await registry
      .invoke(
        'connectors.execute_write',
        { operation: 'send' },
        {
          identity: { agentPath: AGENT_PATH, displayName: 'Scout', createdAt: '2026-11-13' },
          sessionId: turn.sessionId,
        }
      )
      .catch((error: unknown) => error);
    return { result, sent };
  }

  // The gap the ticket named, now only where the operator switches the flag off: a stranger's
  // turn carries no mark, so a send runs with no card.
  it('sends with no card while unmarked (flag switched off)', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-stranger-send-off',
      approvers: ['telegram-owner'],
      markStrangerTurns: false,
    });

    const { result, sent } = await send(turn);

    expect(turn.level).toEqual({ asks: 'never', reach: 'everything' });
    expect(result).toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });

  // Held, and stricter than a card: nobody is watching a bridged run, so the person's OK it needs
  // can't be asked for in it, and the send is refused without asking. No flag is set here: this
  // is the default boot (DOR-4453).
  it('refuses the stranger’s send by default', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-stranger-send-on',
      approvers: ['telegram-owner'],
    });

    const { result, sent } = await send(turn);

    expect(env.DORKOS_MARK_STRANGER_TURNS).toBe(true);
    expect(turn.level).toEqual({ asks: 'never', reach: 'everything', outsider: true });
    expect(result).toMatchObject({
      decision: {
        outcome: 'denied',
        payload: { capabilityId: 'connectors.execute_write', approvable: false },
      },
    });
    // The agent is told the mark is why, not just that a person's OK is needed (DOR-4678).
    expect(JSON.stringify(result)).toContain("because this turn read words DorkOS can't vouch for");
    expect(sent).toEqual([]);
  });

  it('still sends with no card for the owner on the approver list, by default', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-owner-send',
      approvers: ['telegram-owner-send'],
    });

    const { result, sent } = await send(turn);

    expect(turn.marked).toBe(false);
    expect(result).toEqual({ ok: true });
    expect(sent).toEqual(['send']);
  });
});
