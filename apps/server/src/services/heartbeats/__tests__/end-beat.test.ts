/**
 * `end_beat` and the live beat-turn registry (spec `heartbeats` §7.2, §8), and
 * the stranger's-turn flag a capability reads (PRINCIPLES §1).
 *
 * Driven through the real `registry.invoke` with the real permission resolver,
 * so "cannot be blocked by an area" is the gate's answer, not a restatement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';
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
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import {
  heartbeatDomain,
  setRaiseRecipientCheck,
  withBeatBypassCount,
} from '../heartbeat-capabilities.js';
import {
  isBeatTurn,
  liveBeatTurn,
  noteBeatBypass,
  noteNonBeatMessage,
  noteTurnStarted,
  registerBeatTurn,
  resetBeatTurns,
  settleBeatTurn,
} from '../beat-turns.js';
import { commitmentsDomain } from '../../commitments/commitment-capabilities.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../session/origin/outsider-turns.js';

const juno: AgentIdentity = {
  agentPath: '/agents/juno',
  displayName: 'Juno',
  createdAt: '2026-10-10T09:00:00.000Z',
};

let registry: CapabilityRegistry;
let preset: PermissionPreset | null;
let agentPermissions: AgentPermissions | undefined;

beforeEach(() => {
  preset = null;
  agentPermissions = undefined;
  const db = createTestDb();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(db) });
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => agentPermissions,
  });
  registry = composeRegistry([heartbeatDomain, commitmentsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    commitmentDeps: {
      service: { create: vi.fn(), update: vi.fn(), list: vi.fn(() => []) },
      agentIdForPath: () => 'agent-juno',
    },
  });
});

afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  resetBeatTurns();
  resetOutsiderTurns();
  setRaiseRecipientCheck(undefined);
  vi.restoreAllMocks();
});

/** Call `end_beat` from a chat, as the in-session server does. */
function endBeat(sessionId: string, input: Record<string, unknown> = { summary: 'Checked.' }) {
  return registry.invoke('heartbeat.end_beat', input, {
    identity: juno,
    sessionId,
    mcpServer: 'in-session',
    retryChannel: 'mcp-argument',
  }) as Promise<{ ok: boolean; code?: string }>;
}

describe('end_beat', () => {
  it('refuses outside a beat with NOT_A_BEAT', async () => {
    expect(await endBeat('chat-1')).toMatchObject({ ok: false, code: 'NOT_A_BEAT' });
  });

  it('hands the ending to the runner once, then refuses with ALREADY_ENDED', async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    const first = await endBeat('beat-chat', {
      summary: 'Sent the reminder.',
      raises: [{ text: 'Acme paid.', rung: 'dm' }],
    });
    expect(first).toEqual({ ok: true, raises: 1 });
    expect(liveBeatTurn('beat-chat')?.ended?.summary).toBe('Sent the reminder.');
    expect(await endBeat('beat-chat')).toMatchObject({ ok: false, code: 'ALREADY_ENDED' });
  });

  it("treats a person's turn in the beat chat as ordinary, not a beat", async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    noteTurnStarted('beat-chat', 'm1');
    expect(isBeatTurn('beat-chat')).toBe(true);
    // The person types: their message starts a turn of its own.
    noteTurnStarted('beat-chat', 'person-message');
    expect(isBeatTurn('beat-chat')).toBe(false);
    expect(await endBeat('beat-chat')).toMatchObject({ ok: false, code: 'NOT_A_BEAT' });
  });

  it('takes no call once the beat settled, but is still a beat for the racing status change', async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    settleBeatTurn('beat-chat');
    expect(isBeatTurn('beat-chat')).toBe(true);
    expect(await endBeat('beat-chat')).toMatchObject({ ok: false, code: 'NOT_A_BEAT' });
  });

  it('cannot be stopped by an area set to Blocked or Ask', async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    preset = 'careful';
    agentPermissions = {
      areas: Object.fromEntries(PERMISSION_AREA_IDS.map((area) => [area, 'blocked'])),
    } as AgentPermissions;
    expect(await endBeat('beat-chat')).toMatchObject({ ok: true });

    resetBeatTurns();
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b2', messageId: 'm2' });
    agentPermissions = {
      areas: Object.fromEntries(PERMISSION_AREA_IDS.map((area) => [area, 'ask'])),
    } as AgentPermissions;
    expect(await endBeat('beat-chat')).toMatchObject({ ok: true });
  });

  it('stops being a beat once a message that is not the beat enters the chat', async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    noteNonBeatMessage('beat-chat');
    expect(await endBeat('beat-chat')).toMatchObject({ ok: false, code: 'NOT_A_BEAT' });
  });

  it('refuses a raise to somebody unknown, ends nothing, and resolves a known one', async () => {
    setRaiseRecipientCheck((to) =>
      to === 'owner-alias'
        ? { ok: true, accountId: 'acct-owner' }
        : { ok: false, code: 'UNKNOWN_RECIPIENT', error: `Nobody here has the id "${to}".` }
    );
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    const refused = await endBeat('beat-chat', {
      summary: 'x',
      raises: [{ text: 'Hi', rung: 'dm', to: 'stranger@example.com' }],
    });
    expect(refused).toMatchObject({ ok: false, code: 'UNKNOWN_RECIPIENT' });
    expect(liveBeatTurn('beat-chat')?.ended).toBeNull();
    expect(
      await endBeat('beat-chat', {
        summary: 'x',
        raises: [{ text: 'Hi', rung: 'dm', to: 'owner-alias' }],
      })
    ).toMatchObject({ ok: true });
    expect(liveBeatTurn('beat-chat')?.ended?.raises?.[0]?.to).toBe('acct-owner');
  });

  it('is declared in no permission area, in-session only', () => {
    const capability = heartbeatDomain.capabilities[0]!;
    expect(capability.area).toBeNull();
    expect(capability.tier).toBe('act');
    expect(capability.surfaces.mcp?.servers).toEqual(['in-session']);
  });
});

describe('bypass counting', () => {
  it("counts a beat's direct room post and note, and nothing outside a beat", () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    const observer = withBeatBypassCount();
    const roomPost = { id: 'rooms.post' } as never;
    observer({ capability: roomPost, context: { sessionId: 'beat-chat' }, ok: true });
    observer({ capability: roomPost, context: { sessionId: 'other-chat' }, ok: true });
    observer({ capability: roomPost, context: { sessionId: 'beat-chat' }, ok: false });
    noteBeatBypass('beat-chat');
    // A note from another chat of the same agent is not the beat's.
    noteBeatBypass('agent-juno-other-chat');
    expect(liveBeatTurn('beat-chat')?.bypass).toBe(2);
  });
});

describe("a stranger's turn", () => {
  it('reads nobody’s promises on a turn an outsider started', async () => {
    noteTurnOrigin('room-chat', { kind: 'room', externalAuthor: true });
    const refused = await registry.invoke(
      'commitments.list',
      {},
      { identity: juno, sessionId: 'room-chat', mcpServer: 'in-session' }
    );
    expect(refused).toMatchObject({ ok: false, code: 'OUTSIDER_TURN' });

    // The next turn in the same chat is a local author's: the list is readable again.
    noteTurnOrigin('room-chat', { kind: 'room', externalAuthor: false });
    const listed = await registry.invoke(
      'commitments.list',
      {},
      { identity: juno, sessionId: 'room-chat', mcpServer: 'in-session' }
    );
    expect(listed).toEqual({ commitments: [], truncated: false });
  });

  it('treats a bridged chat as a stranger’s on every turn', async () => {
    noteTurnOrigin('telegram-chat', { kind: 'relay-binding' });
    const refused = await registry.invoke(
      'commitments.list',
      {},
      { identity: juno, sessionId: 'telegram-chat', mcpServer: 'in-session' }
    );
    expect(refused).toMatchObject({ ok: false, code: 'OUTSIDER_TURN' });
  });
});
