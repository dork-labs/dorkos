/**
 * Who is working in a room, right now.
 *
 * The server publishes one ephemeral `progress` signal per claim its dispatcher
 * holds — `working` when the claim is taken, `working_late` once the room has
 * stopped waiting, `done` after the durable entry that explains the release
 * (room-presence spec §3.3). Signals never replay, so every publish is
 * self-contained and the whole state of the world is what has arrived recently.
 *
 * That makes this store a **liveness cache with an expiry, not a log**. Three
 * rules keep it from claiming work that has stopped:
 *
 * - `done` deletes its key the moment it lands.
 * - Anything not restated within {@link PRESENCE_TTL_MS} expires. The server
 *   republishes every live claim every 10s, so a server that dies mid-turn —
 *   claims are memory-only — stops republishing and every open client clears
 *   itself within 30s. That is the entire crash story; nothing is persisted.
 * - An entry by X clears every indicator of X's in that room. A reply is
 *   durable and replays on reconnect; the `done` beside it is ephemeral and does
 *   not — so without this rule a reconnecting client draws "working" under an
 *   answer already on screen. Keyed on the AUTHOR, not on which entry the reply
 *   answers: nothing durable links the two today, and X's latest word is the
 *   honest signal either way. A second claim that is genuinely still live is
 *   restored by the next republish, within 10s.
 *
 * @module entities/room/model/use-room-presence
 */
import { useEffect, useReducer } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { RoomPresenceState, RoomSignalEvent } from '@dorkos/shared/room-schemas';

/**
 * How long an indicator survives without being restated.
 *
 * Three times the server's 10s republish, which is the flap margin the same
 * pattern uses elsewhere: one dropped publish must not blink the line off. It is
 * also the worst-case dishonesty window after a server dies mid-turn, which is
 * why it is seconds rather than minutes.
 */
export const PRESENCE_TTL_MS = 30_000;

/**
 * How often an open room re-reads the clock.
 *
 * One timer does both jobs — it ticks the elapsed time on screen and prunes what
 * has expired — so what is stored and what is drawn can never disagree by more
 * than a second. Elapsed time is derived from each claim's own `since`, so no
 * per-second traffic exists or is wanted.
 *
 * @internal Exported for testing.
 */
export const PRESENCE_TICK_MS = 1_000;

/** A claim that is still running, as far as this client can tell. */
interface PresenceRecord {
  /** The agent doing the work. */
  authorId: string;
  /** The entry whose trigger this claim answers. */
  entryId: string;
  /** Whether the room is still waiting for it, or has stopped. */
  state: Exclude<RoomPresenceState, 'done'>;
  /** ISO 8601 — when the work started. Never when the event was sent. */
  since: string;
  /** This client's clock at the publish that last restated it. */
  lastSeenAt: number;
}

/** One agent on the presence line, with its elapsed time already worked out. */
export interface RoomPresenceAuthor {
  /** The agent doing the work. */
  authorId: string;
  /** Whether the room is still waiting for it, or has stopped. */
  state: Exclude<RoomPresenceState, 'done'>;
  /** ISO 8601 — when its oldest live claim started. */
  since: string;
  /** How long that claim has been running, by this client's clock. */
  elapsedMs: number;
}

/** Every room's live indicators, keyed room → indicator. */
interface RoomPresenceStoreState {
  /**
   * Room id → indicator key → the claim behind it.
   *
   * The indicator's identity is `(authorId, entryId)`, the dispatcher's own
   * grain: one agent answering two triggers in the same room holds two claims,
   * and a `done` for one must not clear the other.
   */
  rooms: Record<string, Record<string, PresenceRecord>>;
}

/** Ways the picture of who is working changes. */
interface RoomPresenceActions {
  /**
   * Take in one signal off a room's stream.
   *
   * Signals that carry no COMPLETE lifecycle are ignored rather than stored, and
   * that is two cases, not one. A `typing` signal has no `state`, `entryId` or
   * `since` at all. A `progress` signal can also arrive PARTIAL — the community
   * port's presence payload makes `entryId` and `since` optional, so a remote
   * backend that can only say "somebody is working" produces one — and it is
   * dropped for the same reason: an indicator with no key to age or clear it by
   * is one nothing could ever release, so rendering it would strand the room
   * with a worker who never stops. Dropping is the whole mitigation; nothing
   * downstream re-checks.
   *
   * @param roomId - The room the signal arrived on.
   * @param event - The signal, straight off the wire.
   * @param now - This client's clock, injectable for tests.
   */
  observe: (roomId: string, event: RoomSignalEvent, now?: number) => void;
  /**
   * Drop every indicator an author holds in one room, whatever its state.
   *
   * What an arriving entry means: this author has just spoken, so whatever it
   * was working on, its latest word is on the log.
   *
   * @param roomId - The room the entry landed in.
   * @param authorId - Who wrote it.
   */
  clearAuthor: (roomId: string, authorId: string) => void;
  /**
   * Forget everything about one room.
   *
   * A stream this client cannot read is presence it must not claim to know.
   *
   * @param roomId - The room whose stream has stopped.
   */
  clearRoom: (roomId: string) => void;
  /**
   * Drop every indicator nothing has restated within {@link PRESENCE_TTL_MS}.
   *
   * @param now - This client's clock, injectable for tests.
   */
  prune: (now?: number) => void;
}

/** The indicator key: the dispatcher's `(author, entry)` grain, flattened. */
function indicatorKey(authorId: string, entryId: string): string {
  return `${authorId}\u0000${entryId}`;
}

/**
 * Put a room's indicators back, dropping the room entirely once it has none.
 *
 * Empty rooms are removed rather than left as `{}` so that "is anything
 * happening here" is a key lookup, and so the hook's timer can stop.
 */
function withRoom(
  rooms: RoomPresenceStoreState['rooms'],
  roomId: string,
  indicators: Record<string, PresenceRecord>
): RoomPresenceStoreState['rooms'] {
  const next = { ...rooms };
  if (Object.keys(indicators).length === 0) delete next[roomId];
  else next[roomId] = indicators;
  return next;
}

/** The presence store. Read it through {@link useRoomPresence}. */
export const useRoomPresenceStore = create<RoomPresenceStoreState & RoomPresenceActions>()(
  devtools(
    (set) => ({
      rooms: {},

      observe: (roomId, event, now = Date.now()) => {
        const { state, entryId, since } = event;
        if (state === undefined || entryId === undefined || since === undefined) return;
        const key = indicatorKey(event.authorId, entryId);
        set(
          (held) => {
            const indicators = held.rooms[roomId];
            if (state === 'done') {
              if (indicators?.[key] === undefined) return held;
              const next = { ...indicators };
              delete next[key];
              return { rooms: withRoom(held.rooms, roomId, next) };
            }
            const record: PresenceRecord = {
              authorId: event.authorId,
              entryId,
              state,
              since,
              lastSeenAt: now,
            };
            return { rooms: { ...held.rooms, [roomId]: { ...indicators, [key]: record } } };
          },
          false,
          `roomPresence/${state}`
        );
      },

      clearAuthor: (roomId, authorId) =>
        set(
          (held) => {
            const indicators = held.rooms[roomId];
            if (indicators === undefined) return held;
            const next = Object.fromEntries(
              Object.entries(indicators).filter(([, record]) => record.authorId !== authorId)
            );
            if (Object.keys(next).length === Object.keys(indicators).length) return held;
            return { rooms: withRoom(held.rooms, roomId, next) };
          },
          false,
          'roomPresence/clearAuthor'
        ),

      clearRoom: (roomId) =>
        set(
          (held) => {
            if (held.rooms[roomId] === undefined) return held;
            const next = { ...held.rooms };
            delete next[roomId];
            return { rooms: next };
          },
          false,
          'roomPresence/clearRoom'
        ),

      prune: (now = Date.now()) =>
        set(
          (held) => {
            let changed = false;
            const rooms: RoomPresenceStoreState['rooms'] = {};
            for (const [roomId, indicators] of Object.entries(held.rooms)) {
              const kept = Object.fromEntries(
                Object.entries(indicators).filter(
                  ([, record]) => now - record.lastSeenAt < PRESENCE_TTL_MS
                )
              );
              if (Object.keys(kept).length !== Object.keys(indicators).length) changed = true;
              if (Object.keys(kept).length > 0) rooms[roomId] = kept;
            }
            return changed ? { rooms } : held;
          },
          false,
          'roomPresence/prune'
        ),
    }),
    { name: 'RoomPresenceStore' }
  )
);

/** One shared empty answer, so a quiet room never re-renders its reader. */
const NOBODY: RoomPresenceAuthor[] = [];

/**
 * Collapse a room's indicators to one row per agent.
 *
 * A person cares that Kai is working, not how many claims the dispatcher holds
 * for it — so an agent answering two triggers is one row, shown at its OLDER
 * `since`. The older claim is also the one likelier to have outrun the room's
 * wait, which is why its `state` is the one that carries.
 *
 * Expired records are filtered here as well as pruned on the tick: a room nobody
 * has open runs no timer, so what is stored may outlive what is true.
 *
 * **It reads the clock itself**, rather than being handed one from the render
 * that calls it. "How long has this been running" is a question about now, so
 * something has to ask; asking here keeps the answer right on the render an
 * indicator ARRIVES on — a cold connect onto a four-minute-old claim draws `4m`
 * rather than `0s` corrected a second later — and the tick below is what bounds
 * how long any answer can stay stale.
 *
 * **The elapsed time is a subtraction across two clocks**, and that is the one
 * number here that can lie: `since` is the SERVER's wall clock, `Date.now()` is
 * this browser's, so a machine running two minutes fast draws `2m` the instant a
 * turn starts. It rides the wire shape — the signal carries a start, not an age
 * — and the honest fix, if dogfooding ever finds one, is to age it against the
 * event's own `at` rather than to invent a correction here. Only the running-slow
 * half is guarded: a negative age clamps to `0s` rather than counting backwards.
 */
function summarize(indicators: Record<string, PresenceRecord> | undefined): RoomPresenceAuthor[] {
  if (indicators === undefined) return NOBODY;
  const now = Date.now();
  const oldest = new Map<string, PresenceRecord>();
  for (const record of Object.values(indicators)) {
    if (now - record.lastSeenAt >= PRESENCE_TTL_MS) continue;
    const held = oldest.get(record.authorId);
    if (held === undefined || Date.parse(record.since) < Date.parse(held.since)) {
      oldest.set(record.authorId, record);
    }
  }
  if (oldest.size === 0) return NOBODY;
  return [...oldest.values()]
    .sort(
      (a, b) => Date.parse(a.since) - Date.parse(b.since) || a.authorId.localeCompare(b.authorId)
    )
    .map((record) => ({
      authorId: record.authorId,
      state: record.state,
      since: record.since,
      elapsedMs: Math.max(0, now - Date.parse(record.since)),
    }));
}

/**
 * Who is working in this room, oldest claim first, ticking.
 *
 * The timer runs only while the room has an indicator to draw, so a quiet room
 * costs nothing — and the moment the last one expires it stops itself.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @returns One entry per agent, oldest claim first. Empty when nobody is working.
 */
export function useRoomPresence(roomId: string | null): RoomPresenceAuthor[] {
  const indicators = useRoomPresenceStore((held) =>
    roomId === null ? undefined : held.rooms[roomId]
  );
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const live = indicators !== undefined;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      useRoomPresenceStore.getState().prune();
      tick();
    }, PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [live, tick]);

  // Recomputed every render rather than memoised: the elapsed times are a
  // function of the clock, so a cache keyed on the store would be a cache of
  // stale numbers. A room with nothing in it answers with one shared empty
  // array, so the quiet case — which is nearly always — costs nothing.
  return summarize(indicators);
}
