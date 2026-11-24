/**
 * `ChatBridgePresence` — the bridge-side presence forwarder in isolation
 * (chats-as-channels spec §6.8), for the cases the real dispatcher cannot
 * easily produce. The main path (a claim shows typing, a release clears it,
 * an unbridged room is a no-op, an archive mid-claim still clears) runs
 * through the real dispatcher in `presence-bridge.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { Signal } from '@dorkos/shared/relay-schemas';
import { ChatBridgePresence } from '../presence.js';
import type { Bridge } from '../bridge-store.js';

const ROOM_ID = 'room-1';
const AUTHOR_ID = 'author-ana';

/** A live (unarchived) bridge row, every field overridable. */
function bridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    roomId: ROOM_ID,
    adapterId: 'tg-main',
    chatId: '555111',
    channelType: null,
    platformChatType: 'private',
    bindingId: 'binding-ana',
    visibility: null,
    visibilityCheckedAt: null,
    platformTitle: null,
    deliverNotices: true,
    lastDeliveredSeq: 0,
    lastActivityAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

/** Build a presence forwarder over fakes, and expose the signals it emitted. */
function makePresence(opts: {
  findBridgeByRoom: (roomId: string) => Bridge | null;
  resolveSubject?: (bridge: Bridge) => string | null;
  now?: () => Date;
}): { presence: ChatBridgePresence; emitted: Array<{ subject: string; signal: Signal }> } {
  const emitted: Array<{ subject: string; signal: Signal }> = [];
  const presence = new ChatBridgePresence({
    bridges: { findBridgeByRoom: opts.findBridgeByRoom },
    resolveSubject: opts.resolveSubject ?? (() => 'relay.human.telegram.tg-main.555111'),
    publisher: { signal: (subject, signal) => emitted.push({ subject, signal }) },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { presence, emitted };
}

const SINCE = '2026-08-03T04:00:00.000Z';
const working = { state: 'working', entryId: 'entry-1', since: SINCE } as const;
const done = { state: 'done', entryId: 'entry-1', since: SINCE } as const;

describe('ChatBridgePresence.forward (chats-as-channels §6.8)', () => {
  it('forwards the still-working late state as the same active signal', () => {
    // `working_late` re-states the same held claim; Telegram has one chat action.
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => bridge() });
    presence.forward(ROOM_ID, AUTHOR_ID, { ...working, state: 'working_late' });
    expect(emitted[0].signal.state).toBe('active');
  });

  it.each<[string, Parameters<typeof makePresence>[0], typeof working | typeof done]>([
    ['an archived bridge', { findBridgeByRoom: () => bridge({ archivedAt: SINCE }) }, working],
    [
      'an unresolvable subject',
      { findBridgeByRoom: () => bridge(), resolveSubject: () => null },
      working,
    ],
    // Nothing was told 'active' for this claim, so there is nothing to fall back to.
    ['a release never told active, in an unbridged room', { findBridgeByRoom: () => null }, done],
  ])('makes no platform call for %s', (_label, opts, presenceState) => {
    const { presence, emitted } = makePresence(opts);
    presence.forward(ROOM_ID, AUTHOR_ID, presenceState);
    expect(emitted).toEqual([]);
    expect(presence.trackedClaimCount).toBe(0);
  });

  it('swallows a publisher that throws, rather than letting it escape', () => {
    const presence = new ChatBridgePresence({
      bridges: { findBridgeByRoom: () => bridge() },
      resolveSubject: () => 'relay.human.telegram.tg-main.555111',
      publisher: {
        signal: () => {
          throw new Error('the emitter is gone');
        },
      },
    });
    expect(() => presence.forward(ROOM_ID, AUTHOR_ID, working)).not.toThrow();
  });

  it('tracks claims per (roomId, authorId): an archive mid-claim falls back once, for that claim only', () => {
    let archivedRoom: string | null = null;
    const { presence, emitted } = makePresence({
      findBridgeByRoom: (roomId) => (roomId === archivedRoom ? null : bridge({ roomId })),
      resolveSubject: (b) => `relay.human.telegram.tg-main.${b.roomId}`,
    });
    presence.forward(ROOM_ID, AUTHOR_ID, working);
    presence.forward('room-2', 'author-bo', { ...working, entryId: 'entry-2' });
    expect(presence.trackedClaimCount).toBe(2);

    archivedRoom = 'room-2';
    presence.forward('room-2', 'author-bo', { ...done, entryId: 'entry-2' });
    // A second release finds nothing remembered: the fallback is one-shot.
    presence.forward('room-2', 'author-bo', { ...done, entryId: 'entry-2' });
    expect(presence.trackedClaimCount).toBe(1);
    expect(emitted.filter((e) => e.signal.state === 'stopped')).toEqual([
      expect.objectContaining({ subject: 'relay.human.telegram.tg-main.room-2' }),
    ]);

    presence.forward(ROOM_ID, AUTHOR_ID, done);
    expect(presence.trackedClaimCount).toBe(0);
  });
});
