/**
 * The small pieces a beat is made of: the beat chat's day and title in the
 * person's zone, the chat list's "Heartbeat" label, the prompt, who a raise may
 * name, and whether a room post reaches a person (spec `heartbeats` §7, §8, §9).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, rooms, sessionMetadata } from '@dorkos/db';
import type { Session } from '@dorkos/shared/types';
import { applyHeartbeatOriginOverlay, beatChatTitle, resolveBeatChat } from '../beat-chat.js';
import { BUILT_IN_CHECKLIST, URGENT_DEFINITION, buildBeatPrompt } from '../beat-prompt.js';
import {
  beatChatResolver,
  createDeliveries,
  createRecipientCheck,
  roomReachesPerson,
} from '../heartbeat-adapters.js';
import type { Change } from '../gatherers/index.js';
import { HEARTBEAT_MAX_CHARS } from '@dorkos/shared/convention-files';
import { HeartbeatStore } from '../heartbeat-store.js';
import { planBeat } from '../beat-plan.js';

describe('the beat chat', () => {
  // 03:30 UTC on Tuesday is still Monday evening in New York.
  const LATE_MONDAY_NY = new Date('2026-10-13T03:30:00Z');

  it("is titled and dated in the person's own zone", () => {
    expect(beatChatTitle(LATE_MONDAY_NY, 'America/New_York')).toBe('Heartbeat · Monday Oct 12');
    expect(beatChatTitle(LATE_MONDAY_NY, 'Europe/Berlin')).toBe('Heartbeat · Tuesday Oct 13');
  });

  it("reuses today's chat and opens a new one when the person's day turns", () => {
    const stored = { beatChatId: 'chat-mon', beatChatDate: '2026-10-12' };
    expect(resolveBeatChat(stored, LATE_MONDAY_NY, 'America/New_York', () => 'new')).toMatchObject({
      sessionId: 'chat-mon',
      isNew: false,
    });
    const afterMidnight = new Date('2026-10-13T04:30:00Z');
    expect(
      resolveBeatChat(stored, afterMidnight, 'America/New_York', () => 'chat-tue')
    ).toMatchObject({
      sessionId: 'chat-tue',
      date: '2026-10-13',
      isNew: true,
    });
  });
});

describe('the chat list label', () => {
  it('labels every beat chat by what started it, not only today’s', () => {
    const db = createTestDb();
    for (const [sessionId, launchOrigin] of [
      ['beat-mon', 'heartbeat'],
      ['beat-tue', 'heartbeat'],
      ['mine', 'interactive'],
    ] as const) {
      db.insert(sessionMetadata)
        .values({
          sessionId,
          runtime: 'claude-code',
          launchOrigin,
          createdAt: '2026-10-12T00:00:00Z',
        } as never)
        .run();
    }
    const sessions = ['beat-mon', 'beat-tue', 'mine'].map(
      (id) => ({ id, originRoomId: 'r1' }) as unknown as Session
    );
    applyHeartbeatOriginOverlay(sessions, beatChatResolver(db));
    expect(sessions.map((s) => s.originLabel ?? null)).toEqual(['Heartbeat', 'Heartbeat', null]);
    expect('originRoomId' in sessions[0]!).toBe(false);
  });
});

describe('the beat prompt', () => {
  const change: Change = {
    gatherer: 'addressed',
    key: 'room-entry:e1',
    summary: 'Dorian wrote to you directly (room r1).',
    at: '2026-10-12T13:55:00Z',
    signal: 'unanswered',
  };
  const prompt = (overrides: Partial<Parameters<typeof buildBeatPrompt>[0]> = {}) =>
    buildBeatPrompt({
      agentName: 'Juno',
      kind: 'pulse',
      changes: [change],
      commitments: [],
      openRaises: [],
      checklist: null,
      newManager: false,
      ...overrides,
    });

  it('opens as a heartbeat, carries the changes with their keys, and ends with end_beat', () => {
    const text = prompt();
    expect(text.startsWith('This is a heartbeat, not a message from a person.')).toBe(true);
    expect(text).toContain('Dorian wrote to you directly (room r1). [room-entry:e1]');
    expect(text).toContain(URGENT_DEFINITION);
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/end_beat/);
  });

  it('uses the built-in seven steps with no HEARTBEAT.md, and the file’s body with one', () => {
    expect(prompt()).toContain(`7. ${BUILT_IN_CHECKLIST[6]}`);
    const own = prompt({ checklist: '- Invoices past 14 days get a reminder.' });
    expect(own).toContain('- Invoices past 14 days get a reminder.');
    expect(own).not.toContain(BUILT_IN_CHECKLIST[0]);
  });

  it('says so when its manager changed', () => {
    expect(prompt({ newManager: true })).toContain('Who you report to changed.');
    expect(prompt()).not.toContain('Who you report to changed.');
  });
});

describe('who a raise may name', () => {
  const check = createRecipientCheck(
    () => ({ get: (id: string) => (id === 'agent-otto' ? ({} as never) : undefined) }),
    {
      names: (id) => ['owner', 'acct-owner', 'acct-guest'].includes(id),
      canonical: (id) => (id === 'owner' ? 'acct-owner' : id),
    },
    () => 'acct-owner'
  );

  it('takes an agent, and the owner by any id they are known by', () => {
    expect(check('agent-otto')).toEqual({ ok: true, accountId: 'agent-otto' });
    expect(check('owner')).toEqual({ ok: true, accountId: 'acct-owner' });
  });

  it('refuses a person delivery cannot reach yet, and anybody unknown', () => {
    expect(check('acct-guest')).toMatchObject({ ok: false, code: 'PERSON_UNREACHABLE' });
    expect(check('who@example.com')).toMatchObject({ ok: false, code: 'UNKNOWN_RECIPIENT' });
  });
});

describe('whether a room post reaches a person', () => {
  it('is true in a DM room, or when the text names a person by handle', () => {
    const db = createTestDb();
    const at = '2026-10-01T00:00:00Z';
    db.insert(rooms)
      .values([
        { id: 'r-dm', kind: 'dm', title: 'Dorian', createdAt: at, lastActivityAt: at },
        { id: 'r-eng', kind: 'channel', title: 'eng', createdAt: at, lastActivityAt: at },
      ] as never)
      .run();
    db.insert(authors)
      .values([
        {
          id: 'h1',
          kind: 'human',
          naturalKey: 'owner:1',
          displayName: 'Dorian',
          handle: 'dorian',
          createdAt: at,
        },
        {
          id: 'a1',
          kind: 'agent',
          naturalKey: '/a/otto',
          displayName: 'Otto',
          handle: 'otto',
          createdAt: at,
        },
      ] as never)
      .run();
    expect(roomReachesPerson(db, 'r-dm', 'Build is green.')).toBe(true);
    expect(roomReachesPerson(db, 'r-eng', 'Build is green.')).toBe(false);
    expect(roomReachesPerson(db, 'r-eng', '@otto the build is green.')).toBe(false);
    expect(roomReachesPerson(db, 'r-eng', 'Build is green, @dorian.')).toBe(true);
  });
});

describe('a DM or note to a person', () => {
  const juno = { id: 'agent-juno', name: 'Juno', runtime: 'claude-code', projectPath: '/a/juno' };

  /** The delivery seams over a fake in-app DM that records what it posted. */
  function deliveries() {
    const post = vi.fn(() => ({ id: 'entry-1' }));
    // Asked only when a note heads for a bound chat; off, so it falls to the DM.
    const relayOn = vi.fn(() => false);
    const ways = createDeliveries(
      {
        db: createTestDb(),
        rooms: { postFromTool: vi.fn() } as never,
        roomAuthors: { resolveAgent: vi.fn() } as never,
        notifyDm: {
          rooms: { createRoom: () => ({ id: 'dm-owner' }), post },
          authors: { resolveAgent: () => ({ id: 'author-juno' }) },
          mesh: { getProjectPath: () => '/a/juno', get: () => ({ name: 'Juno' }) },
          operatorAuthorId: () => 'author-owner',
          logger: { warn: () => undefined },
        },
        relay: () => ({ isRelayEnabled: relayOn }),
      },
      (id) => id === 'acct-owner'
    );
    return { ways, post, relayOn };
  }

  it("lands in the owner's DM for the owner", async () => {
    const { ways, post } = deliveries();
    expect(await ways.deliverDm(juno, 'acct-owner', 'Acme paid.')).toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("never lands in the owner's DM for somebody else", async () => {
    const { ways, post, relayOn } = deliveries();
    expect(await ways.deliverDm(juno, 'acct-manager', 'Acme paid.')).toMatchObject({ ok: false });
    // An agent that was removed since is nobody's account: never the owner's DM.
    expect(await ways.deliverDm(juno, 'agent-gone', 'Acme paid.')).toMatchObject({ ok: false });
    expect(await ways.deliverNote(juno, 'acct-manager', 'Acme paid.')).toMatchObject({ ok: false });
    expect(post).not.toHaveBeenCalled();
    // Nor in a chat bound for the owner.
    expect(relayOn).not.toHaveBeenCalled();
  });
});

describe('a HEARTBEAT.md longer than beats read', () => {
  it('is cut to the cap in the plan, so it cannot swell every beat prompt', async () => {
    const store = new HeartbeatStore(createTestDb());
    const body = 'Check the invoices. '.repeat(HEARTBEAT_MAX_CHARS);
    const plan = await planBeat(
      {
        store,
        readHeartbeat: async () => ({
          kind: 'valid',
          frontmatter: { wake: 'events' },
          body,
          hash: 'h1',
          mtimeMs: 1,
        }),
      },
      { id: 'agent-juno', name: 'Juno', projectPath: '/a/juno' }
    );
    expect(plan.checklist).toBe(body.slice(0, HEARTBEAT_MAX_CHARS));
  });
});
