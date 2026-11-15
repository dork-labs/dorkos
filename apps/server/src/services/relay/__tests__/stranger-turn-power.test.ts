/**
 * A directly bound Telegram turn carries DOR-3858's outsider mark through the
 * shared relay runtime seam. The mark leaves Full unchanged and makes the
 * existing connected-app gate ask; the boot flag and owner allowlist exempt
 * the same turns they exempt in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { TelegramAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import type { StreamEvent, Task } from '@dorkos/shared/types';
import type { AgentRuntimeLike, RelayPublisher } from '@dorkos/relay';
import { handleAgentMessage } from '../../../../../../packages/relay/src/adapters/claude-code/agent-handler.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, marksOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
} from '../../core/capabilities/permission-enforcement.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { wordsAreUntrusted } from '../platform-identity.js';
import {
  decideAgentModeCall,
  type AgentModeDecision,
  type AgentModeSources,
} from '../../tasks/agent-mode/agent-mode-decision.js';

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0);
const AGENT_PATH = '/agents/scout';

interface RelayTurnResult {
  sessionId: string;
  level: TurnPermissionLevel;
  marked: boolean;
}

const MODE_SOURCES: AgentModeSources = {
  declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
  agentLevelMode: async () => 'bypassPermissions',
  agentPathOf: () => AGENT_PATH,
  readConfig: () => ({
    preset: 'trusted',
    defaults: { areas: {}, actions: { 'tasks.set_mode': 'allowed' } },
  }),
  readAgentPermissions: async () => undefined,
  startedBy: () => null,
  turnLevelOf: (sessionId) => lastTurnLevelOf(sessionId),
};

/** Decide a raise from Accept edits to Bypass for the relay turn. */
function decideRaise(turn: RelayTurnResult): Promise<AgentModeDecision> {
  const task = {
    id: 'task-example',
    name: 'send-update',
    prompt: 'Send the update',
    cron: '0 9 * * *',
    timezone: 'UTC',
    agentId: 'agent-scout',
    permissionMode: 'acceptEdits',
    status: 'active',
    runtime: null,
    model: null,
    account: null,
    filePath: '/agents/scout/tasks/send-update/SKILL.md',
    proposedByAgentPath: AGENT_PATH,
    proposedBySessionId: turn.sessionId,
  } as Task;
  return decideAgentModeCall(
    {
      door: 'update',
      body: { permissionMode: 'bypassPermissions' },
      task,
      edits: {
        lastEditedByAgentPath: AGENT_PATH,
        lastEditedBySessionId: turn.sessionId,
        agentApprovalKey: null,
      },
    },
    {
      structural: true,
      resolved: 'home',
      agentPath: AGENT_PATH,
      sessionId: turn.sessionId,
      marked: turn.marked,
    },
    MODE_SOURCES
  );
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

/** Run one Telegram-bound turn through the relay handler and level recorder. */
async function runTelegramTurn(input: {
  senderId: string;
  approvers: readonly string[];
  markStrangerTurns: boolean;
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
      markStrangerTurns: input.markStrangerTurns,
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

describe('Telegram stranger turns at Full (DOR-3858)', () => {
  const connectorSend = {
    id: 'connectors.execute_write',
    title: 'Send through a connected app',
    tier: 'act' as const,
    area: null,
  };

  it('keeps today’s no-card behavior while the flag is off', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-stranger-off',
      approvers: ['telegram-owner'],
      markStrangerTurns: false,
    });

    expect(turn.marked).toBe(false);
    expect(turn.level).toEqual({ asks: 'never', reach: 'everything' });
    await expect(
      resolveCallPermission({
        action: connectorSend,
        sessionId: turn.sessionId,
        identity: { agentPath: AGENT_PATH, displayName: 'Scout', createdAt: '2026-11-13' },
        outward: true,
      })
    ).resolves.toBeNull();
  });

  it('keeps Full but makes a stranger’s connector send ask while the flag is on', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-stranger-on',
      approvers: ['telegram-owner'],
      markStrangerTurns: true,
    });

    expect(turn.marked).toBe(true);
    expect(turn.level).toEqual({ asks: 'never', reach: 'everything', outsider: true });
    await expect(
      resolveCallPermission({
        action: connectorSend,
        sessionId: turn.sessionId,
        identity: { agentPath: AGENT_PATH, displayName: 'Scout', createdAt: '2026-11-13' },
        outward: true,
      })
    ).resolves.toMatchObject({ area: 'connections', state: 'ask' });
  });

  it('does not mark the owner in the same private chat', async () => {
    const turn = await runTelegramTurn({
      senderId: 'telegram-owner',
      approvers: ['telegram-owner'],
      markStrangerTurns: true,
    });

    expect(turn.marked).toBe(false);
    expect(turn.level).toEqual({ asks: 'never', reach: 'everything' });
  });

  // A marked turn keeps the cap every marked turn already has (`agent-mode-decision.ts`): a raise
  // past Don't ask is refused outright, which is stricter than a card. The owner's is allowed.
  it('refuses the stranger’s task-mode raise to Bypass while the owner’s goes through', async () => {
    const stranger = await runTelegramTurn({
      senderId: 'telegram-stranger-raise',
      approvers: ['telegram-owner-raise'],
      markStrangerTurns: true,
    });
    const owner = await runTelegramTurn({
      senderId: 'telegram-owner-raise',
      approvers: ['telegram-owner-raise'],
      markStrangerTurns: true,
    });

    await expect(decideRaise(stranger)).resolves.toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
    await expect(decideRaise(owner)).resolves.toMatchObject({
      kind: 'decided',
      state: 'allowed',
      asks: [],
    });
  });

  it('marks a non-owner sender when the Telegram direct-message policy is open', async () => {
    const config = TelegramAdapterConfigSchema.parse({
      token: 'made-up-token',
      dmPolicy: 'open',
      approverAllowlist: ['telegram-owner'],
    });
    const turn = await runTelegramTurn({
      senderId: 'telegram-open-chat-stranger',
      approvers: config.approverAllowlist,
      markStrangerTurns: true,
    });

    expect(config.dmPolicy).toBe('open');
    expect(turn.marked).toBe(true);
    expect(turn.level).toEqual({ asks: 'never', reach: 'everything', outsider: true });
    await expect(decideRaise(turn)).resolves.toMatchObject({
      kind: 'refuse',
      body: { code: 'above_ceiling' },
    });
  });
});
