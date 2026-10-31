/**
 * The event-wake hooks where they live (spec `heartbeats` §3.3, PR 3 review A1,
 * B1): the room refusal guard (strangers, beat posts, self-rooted depth
 * refusals), the connector registry's sign-in hooks, and a relay turn's
 * stranger flag reaching a capability.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { EventWakes } from '../event-wakes.js';
import { noteBeatRoomPost } from '../event-wakes.js';
import { systemClock } from '../beat-scheduler.js';
import { resetBeatTurns } from '../beat-turns.js';
import { shouldWakeForRefusal, wakeForRefusedRoomTurn } from '../room-wakes.js';
import { noteEntryLevel } from '../../core/turn-power/turn-levels.js';
import type { BeatWake } from '../beat-runner.js';
import { ConnectorRegistry } from '../../connectors/registry.js';

let beats: Array<{ agentId: string; wake: BeatWake }>;
let hub: EventWakes;

/** Authors by id: a local person, another agent, and a stranger on Telegram. */
const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(
      ids.flatMap((id) => {
        const record = {
          'h-dorian': { kind: 'human', naturalKey: 'owner:acct-1' },
          'a-otto': { kind: 'agent', naturalKey: '/agents/otto' },
          'x-stranger': { kind: 'external', naturalKey: 'platform:telegram:bot:555' },
        }[id];
        return record ? [[id, record]] : [];
      })
    ),
} as never;

const JUNO = { kind: 'agent', naturalKey: '/agents/juno' };

beforeEach(() => {
  vi.useFakeTimers();
  beats = [];
  hub = new EventWakes({
    clock: systemClock,
    localDay: () => '2026-10-12',
    beat: (agentId, wake) => beats.push({ agentId, wake }),
    agentIdAt: (path) => (path === '/agents/juno' ? 'agent-juno' : undefined),
    agentsForConnection: (id) => (id === 'conn-1' ? ['agent-juno'] : []),
    noteNewManager: () => undefined,
    refresh: () => undefined,
  });
  hub.install();
});

afterEach(() => {
  hub.uninstall();
  resetBeatTurns();
  vi.useRealTimers();
});

describe('a refused room turn', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    id: 'e1',
    authorId: 'h-dorian',
    cascadeRoot: 'root-0',
    sessionId: null,
    ...overrides,
  });

  it("wakes the agent a local person's message named", () => {
    wakeForRefusedRoomTurn(JUNO, 'mention', entry(), 'repeat', AUTHORS);
    vi.advanceTimersByTime(60_000);
    expect(beats.map((b) => b.agentId)).toEqual(['agent-juno']);
  });

  it("never wakes for a stranger's message", () => {
    expect(
      shouldWakeForRefusal(JUNO, 'mention', entry({ authorId: 'x-stranger' }), 'repeat', AUTHORS)
    ).toBe(false);
  });

  it("never wakes for an agent's post made outside its own room turn", () => {
    // A beat's direct post and the outbox's both reach the room with no session.
    expect(
      shouldWakeForRefusal(JUNO, 'mention', entry({ authorId: 'a-otto' }), 'budget', AUTHORS)
    ).toBe(false);
    // Inside its room turn the room stamps the session, and a real chain wakes.
    expect(
      shouldWakeForRefusal(
        JUNO,
        'mention',
        entry({ authorId: 'a-otto', sessionId: 'otto-room-chat' }),
        'repeat',
        AUTHORS
      )
    ).toBe(true);
  });

  // A teammate's chain is a record for the space's limit, and blocks no wake (DOR-3440). A post that
  // carried a stranger's words on wakes it too (DOR-3390, Security): the beat gathers it with its
  // marks, so it runs as a marked turn whose risky actions ask.
  it('wakes for a teammate’s chain, and for a post that carried outside words', () => {
    const level = { asks: 'always', reach: 'read' } as const;
    noteEntryLevel('marked-teammate', {
      ...level,
      outsider: true,
      teammate: [{ roomId: 'space', authorId: 'priya' }],
    });
    noteEntryLevel('marked-outsider', { ...level, outsider: true });
    noteEntryLevel('unmarked', level);
    const fromOtto = (id: string) => entry({ id, authorId: 'a-otto', sessionId: 'otto-chat' });
    expect(
      shouldWakeForRefusal(JUNO, 'mention', fromOtto('marked-teammate'), 'repeat', AUTHORS)
    ).toBe(true);
    expect(
      shouldWakeForRefusal(JUNO, 'mention', fromOtto('marked-outsider'), 'repeat', AUTHORS)
    ).toBe(true);
    expect(shouldWakeForRefusal(JUNO, 'mention', fromOtto('unmarked'), 'repeat', AUTHORS)).toBe(
      true
    );
  });

  it('never wakes for a post the outbox made, even one that borrowed a room turn’s session', () => {
    noteBeatRoomPost('outbox-entry');
    expect(
      shouldWakeForRefusal(
        JUNO,
        'mention',
        entry({ id: 'outbox-entry', authorId: 'a-otto', sessionId: 'otto-room-chat' }),
        'repeat',
        AUTHORS
      )
    ).toBe(false);
  });

  it('never wakes for a depth refusal of a post that started its own cascade', () => {
    const selfRooted = entry({ authorId: 'a-otto', cascadeRoot: 'e1', sessionId: 's' });
    expect(shouldWakeForRefusal(JUNO, 'mention', selfRooted, 'depth', AUTHORS)).toBe(false);
    expect(
      shouldWakeForRefusal(
        JUNO,
        'mention',
        entry({ authorId: 'a-otto', sessionId: 's' }),
        'depth',
        AUTHORS
      )
    ).toBe(true);
  });

  it('wakes for a lead or a conversation a person is owed, never for an ambient reason', () => {
    for (const reason of ['lead', 'conversation']) {
      expect(shouldWakeForRefusal(JUNO, reason, entry(), 'budget', AUTHORS)).toBe(true);
    }
    for (const reason of ['window', 'always', 'seat']) {
      expect(shouldWakeForRefusal(JUNO, reason, entry(), 'budget', AUTHORS)).toBe(false);
    }
    expect(
      shouldWakeForRefusal(JUNO, 'lead', entry({ authorId: 'x-stranger' }), 'budget', AUTHORS)
    ).toBe(false);
  });
});

describe('the connector registry', () => {
  it('wakes the agents a connection serves when its sign-in ends', () => {
    const registry = new ConnectorRegistry({
      db: createTestDb(),
      connectionStore: {
        health: () => ({ status: 'ready' }),
        markSignInEnded: () => true,
      } as never,
    });
    registry.markSignInEnded('conn-1' as never, 'expired');
    vi.advanceTimersByTime(60_000);
    expect(beats).toEqual([{ agentId: 'agent-juno', wake: { wake: 'event:connection-lost' } }]);
  });
});
