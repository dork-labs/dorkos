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

    expect(findBridgeByRoom).toHaveBeenCalledTimes(2);
    // Only the first call landed; the room archived out from under it by the
    // second, and that release must not reach a chat that is no longer live.
    expect(emitted).toHaveLength(1);
  });
});
