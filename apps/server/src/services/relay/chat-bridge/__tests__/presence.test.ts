/**
 * `ChatBridgePresence` — the bridge-side presence forwarder in isolation
 * (chats-as-channels spec §6.8).
 *
 * These are unit tests of {@link ChatBridgePresence.forward} against fake
 * deps: they pin the routing decisions (which room gets forwarded, which
 * state maps to which signal) without paying for a real dispatcher. The
 * dispatcher-driven acceptance test — a real turn claim producing this
 * forwarder's output, and its release clearing it — lives in
 * `presence-bridge.test.ts`, alongside the deliberately unbridged no-op.
 */
import { describe, it, expect, vi } from 'vitest';
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

describe('ChatBridgePresence.forward (chats-as-channels §6.8)', () => {
  it('forwards a working claim as an active signal on the bridge subject', () => {
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => bridge() });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].subject).toBe('relay.human.telegram.tg-main.555111');
    // `'active'` is exactly the value `handleTypingSignal`
    // (`packages/relay/src/adapters/telegram/outbound.ts`) reads to start the
    // Telegram typing loop — the whole contract this forwarder exists to feed.
    expect(emitted[0].signal).toMatchObject({
      type: 'progress',
      state: 'active',
      endpointSubject: 'relay.human.telegram.tg-main.555111',
    });
  });

  it('forwards the still-working late state as the same active signal', () => {
    // `working_late` is a re-statement of the same held claim (room-presence
    // spec §2), not a new lifecycle — Telegram has one chat action, so both
    // states that mean "still claimed" map to the same `'active'` value.
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => bridge() });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working_late',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted[0].signal.state).toBe('active');
  });

  it('forwards a release as a non-active signal, clearing the indicator', () => {
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => bridge() });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    // Anything other than `'active'` clears the loop in `handleTypingSignal`;
    // `'stopped'` is the readable choice, not a value the handler singles out.
    expect(emitted[0].signal.state).not.toBe('active');
  });

  it('makes no platform call for a room with no live bridge (A6.8 unbridged case)', () => {
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => null });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted).toEqual([]);
  });

  it('makes no platform call for a bridge that has been archived', () => {
    const { presence, emitted } = makePresence({
      findBridgeByRoom: () => bridge({ archivedAt: '2026-08-02T00:00:00.000Z' }),
    });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted).toEqual([]);
  });

  it('makes no platform call when the subject cannot be resolved', () => {
    const { presence, emitted } = makePresence({
      findBridgeByRoom: () => bridge(),
      resolveSubject: () => null,
    });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted).toEqual([]);
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

    expect(() =>
      presence.forward(ROOM_ID, AUTHOR_ID, {
        state: 'working',
        entryId: 'entry-1',
        since: '2026-08-03T04:00:00.000Z',
      })
    ).not.toThrow();
  });

  it('resolves a fresh bridge lookup on every call, never a captured snapshot', () => {
    let archived = false;
    const findBridgeByRoom = vi.fn(() =>
      bridge({ archivedAt: archived ? '2026-08-02T00:00:00.000Z' : null })
    );
    const { presence, emitted } = makePresence({ findBridgeByRoom });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });
    archived = true;
    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    // The lookup itself IS fresh on both calls — that part of the original
    // claim this test pins still holds.
    expect(findBridgeByRoom).toHaveBeenCalledTimes(2);
    // What changed under review (a real, reproduced bug): a release for a
    // claim this instance actually told 'active' MUST still clear the
    // indicator, even though the room archived out from under it before the
    // release. Without the `lastActiveSubject` fallback, this second call
    // would return early — the room's fresh lookup finds an archived bridge —
    // and Telegram would show "typing…" for up to TYPING_INACTIVITY_MS (60s,
    // `outbound.ts`) on a chat that is not even bridged anymore. The
    // regression test in `presence-bridge.test.ts` reproduces this end to end
    // through the real dispatcher; this is the same property pinned at the
    // unit level.
    expect(emitted).toHaveLength(2);
    expect(emitted[0].signal.state).toBe('active');
    expect(emitted[1].signal.state).toBe('stopped');
    // Delivered to the SAME subject the 'active' went to — the remembered
    // one, not a re-resolution against the now-archived bridge (which would
    // have returned null and had nothing to send to).
    expect(emitted[1].subject).toBe(emitted[0].subject);
    // And the fallback is one-shot: nothing left to leak or double-fire.
    expect(presence.trackedClaimCount).toBe(0);
  });

  it('does not fall back for a claim this instance never told active — the genuinely unrelated case', () => {
    // The scenario the original version of the test above actually meant to
    // pin, now isolated from the archive-mid-claim case above (which review
    // showed has the opposite correct answer): a 'done' for a room with no
    // live bridge AND nothing remembered — because 'active' was never
    // forwarded for this claim in the first place — has nothing to fall back
    // to, so it stays a silent no-op, the same as an ordinary unbridged room.
    const { presence, emitted } = makePresence({ findBridgeByRoom: () => null });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted).toEqual([]);
    expect(presence.trackedClaimCount).toBe(0);
  });

  it('falls back to the last-claimed subject exactly once, even if asked twice', () => {
    // Not a shape the dispatcher actually produces (a claim releases once),
    // but the map's one-shot guarantee is what stands between "guards against
    // unbounded growth" and a genuine leak, so it is worth pinning directly:
    // a second 'done' for a claim already cleared finds nothing remembered.
    let archived = false;
    const { presence, emitted } = makePresence({
      findBridgeByRoom: () => (archived ? null : bridge()),
    });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });
    archived = true;
    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });
    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });

    expect(emitted.map((e) => e.signal.state)).toEqual(['active', 'stopped']);
    expect(presence.trackedClaimCount).toBe(0);
  });

  it('tracks claims independently per (roomId, authorId), even through the fallback', () => {
    // Two live, distinctly-bridged rooms, each with its own working claim —
    // then only ONE room's bridge archives mid-claim. The fix must clear
    // exactly that one claim's entry and leave the other's remembered subject
    // untouched; a shared key (or a key that ignored one of the two ids)
    // would either cross-clear the wrong claim or leak the archived one.
    let archivedRoom: string | null = null;
    const { presence, emitted } = makePresence({
      findBridgeByRoom: (roomId) => (roomId === archivedRoom ? null : bridge({ roomId })),
      resolveSubject: (b) => `relay.human.telegram.tg-main.${b.roomId}`,
    });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'working',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });
    presence.forward('room-2', 'author-bo', {
      state: 'working',
      entryId: 'entry-2',
      since: '2026-08-03T04:05:00.000Z',
    });
    expect(presence.trackedClaimCount).toBe(2);

    archivedRoom = 'room-2';
    presence.forward('room-2', 'author-bo', {
      state: 'done',
      entryId: 'entry-2',
      since: '2026-08-03T04:05:00.000Z',
    });

    // room-2's claim fell back and cleared; room-1's is untouched.
    expect(presence.trackedClaimCount).toBe(1);
    expect(emitted.at(-1)).toMatchObject({
      subject: 'relay.human.telegram.tg-main.room-2',
      signal: { state: 'stopped' },
    });

    presence.forward(ROOM_ID, AUTHOR_ID, {
      state: 'done',
      entryId: 'entry-1',
      since: '2026-08-03T04:00:00.000Z',
    });
    expect(presence.trackedClaimCount).toBe(0);
  });
});
