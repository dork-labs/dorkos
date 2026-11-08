/**
 * The turn gate for changing another agent's access (spec
 * `agent-grant-autonomy` §4.1, §4.4): refused for every turn DorkOS marks,
 * every turn another agent started, and every turn it can't read.
 */
import { describe, expect, it, vi } from 'vitest';
import { anotherAgentTurnRefusal, type TurnGateSources } from '../access/turn-gate.js';

const CLEAN: TurnGateSources = {
  hasTurnRecord: () => true,
  marked: () => false,
  agentSenders: () => [],
  launchOrigin: () => 'interactive',
};

const caller = { sessionId: 'session-a', agentPath: '/agents/a' };

describe('another-agent turn gate', () => {
  it('allows a clean turn a person started', () => {
    expect(anotherAgentTurnRefusal(caller, CLEAN)).toBeNull();
    for (const origin of ['room', 'session-relay']) {
      expect(anotherAgentTurnRefusal(caller, { ...CLEAN, launchOrigin: () => origin })).toBeNull();
    }
  });

  it('refuses a marked turn (outsider room or chat text, Wi-Fi hold)', () => {
    expect(anotherAgentTurnRefusal(caller, { ...CLEAN, marked: () => true })).toBe(
      'GRANT_MARKED_TURN'
    );
    for (const origin of ['relay-binding', 'outside-sender', 'connector-event']) {
      expect(anotherAgentTurnRefusal(caller, { ...CLEAN, launchOrigin: () => origin })).toBe(
        'GRANT_MARKED_TURN'
      );
    }
  });

  it("refuses a turn another agent's message, report, steer or room post started", () => {
    expect(anotherAgentTurnRefusal(caller, { ...CLEAN, agentSenders: () => ['session-b'] })).toBe(
      'GRANT_AGENT_STARTED'
    );
    for (const origin of ['agent-dm', 'agent-launch', 'chat-message', 'extension-message']) {
      expect(anotherAgentTurnRefusal(caller, { ...CLEAN, launchOrigin: () => origin })).toBe(
        'GRANT_AGENT_STARTED'
      );
    }
  });

  it("fails closed when it can't tell (E2)", () => {
    expect(anotherAgentTurnRefusal({ sessionId: undefined, agentPath: undefined }, CLEAN)).toBe(
      'GRANT_MARKS_UNREADABLE'
    );
    expect(anotherAgentTurnRefusal(caller, { ...CLEAN, hasTurnRecord: () => false })).toBe(
      'GRANT_MARKS_UNREADABLE'
    );
    expect(anotherAgentTurnRefusal(caller, { ...CLEAN, launchOrigin: () => null })).toBe(
      'GRANT_MARKS_UNREADABLE'
    );
    // A schedule, or a beat another agent's room post may have woken (PR B review M2).
    for (const origin of ['schedule', 'heartbeat']) {
      expect(anotherAgentTurnRefusal(caller, { ...CLEAN, launchOrigin: () => origin })).toBe(
        'GRANT_MARKS_UNREADABLE'
      );
    }
    expect(
      anotherAgentTurnRefusal(caller, {
        ...CLEAN,
        marked: () => {
          throw new Error('unreadable');
        },
      })
    ).toBe('GRANT_MARKS_UNREADABLE');
  });
});

// §4.4's wording rule: until DOR-3969, nothing an agent reads may claim a read
// through a tool or a connected app is caught. The descriptions name the turns
// DorkOS marks and say plainly what isn't covered.
describe('what the narrowing tools say about their limits', () => {
  const BANNED = [/outside content/i, /after reading/i, /external content/i];

  it('never claims to catch a read through a connected app, and says so plainly', async () => {
    const { ACCESS_CHANGE_CAPABILITIES } = await import('../access/access-change-capabilities.js');
    const { NARROWING_MESSAGES } = await import('../access/access-narrowing.js');
    const texts = [
      ...ACCESS_CHANGE_CAPABILITIES.map((capability) => capability.description),
      ...Object.values(NARROWING_MESSAGES),
    ];
    for (const text of texts) {
      for (const pattern of BANNED) expect(text).not.toMatch(pattern);
    }
    const other = ACCESS_CHANGE_CAPABILITIES.find(
      (capability) => capability.id === 'connectors.narrow_agent_access'
    );
    expect(other?.description).toContain('these limits don’t cover that case');
  });
});

// Giving up your own access skips the gate, so the tool must never reach
// another agent: its input has no agent field, and it always targets the caller.
describe('narrow_own_access only ever reaches the caller', () => {
  it('refuses any agent field, and narrows the calling agent', async () => {
    const { ACCESS_CHANGE_CAPABILITIES } = await import('../access/access-change-capabilities.js');
    const { createServerPrincipal } = await import('../principal/server-principal.js');
    const own = ACCESS_CHANGE_CAPABILITIES.find(
      (capability) => capability.id === 'connectors.narrow_own_access'
    )!;

    for (const field of ['agentId', 'targetAgentId']) {
      expect(
        own.input.safeParse({ connectionId: 'connection-a', to: 'none', [field]: 'agent-b' })
          .success
      ).toBe(false);
    }

    const narrow = vi.fn().mockResolvedValue({ changed: true, changeId: 'change-1' });
    const serverPrincipal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-1' },
      bindingId: 'binding-1',
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/a',
    });
    await own.invoke(
      { accessChangeDeps: { narrowing: { narrow }, db: {} } } as never,
      { connectionId: 'connection-a', to: 'none' } as never,
      { serverPrincipal } as never
    );
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(narrow.mock.calls[0]![0]).toMatchObject({ agentId: 'agent-a' });
    expect(narrow.mock.calls[0]![1]).toMatchObject({ targetAgentId: 'agent-a' });
  });
});
