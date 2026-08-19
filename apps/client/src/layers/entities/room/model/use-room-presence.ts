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
 * **One state here is not work at all.** `held` says this room's message has NOT
 * started, because the agent is mid-turn in a different room that shares its
 * checkout. It lives in the same store because it has the same shape and the same
 * life — one ephemeral publish per dispatcher record, restated on the same tick,
 * cleared by the same `done` — but it is read through {@link useRoomHolds} and
 * excluded from every "who is working" reader, because an agent that has not
 * started is not somebody this room is waiting on in the same sense.
 *
 * @module entities/room/model/use-room-presence
 */
import { useEffect, useMemo, useReducer } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  RoomHeldBehind,
  RoomPresenceState,
  RoomSignalEvent,
} from '@dorkos/shared/room-schemas';

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

/**
 * Where a live indicator is, as this client holds it — every state except the
 * one that deletes the record.
 */
type LiveState = Exclude<RoomPresenceState, 'done'>;

/** Where a WORKING indicator is. `held` is not one of these: nothing is running. */
type WorkingState = Exclude<LiveState, 'held'>;

/** An indicator that is still live, as far as this client can tell. */
interface PresenceRecord {
  /** The agent the indicator is about. */
  authorId: string;
  /** The entry whose trigger this indicator answers. */
  entryId: string;
  /** Where it is: working, working late, or waiting to start. */
  state: LiveState;
  /** ISO 8601 — when the work, or the wait, started. Never when the event was sent. */
  since: string;
  /**
   * What a `held` indicator is waiting behind, or `undefined` on every other
   * state.
   *
   * Stored as it arrived. The room id is resolved to a NAME by the surface that
   * draws it, against the rooms that reader can already see — this store holds
   * no roster and must not start guessing at one.
   */
  heldBehind?: RoomHeldBehind;
  /** This client's clock at the publish that last restated it. */
  lastSeenAt: number;
}

/** One agent on the presence line, with its elapsed time already worked out. */
export interface RoomPresenceAuthor {
  /** The agent doing the work. */
  authorId: string;
  /**
   * The entry whose trigger its OLDEST live claim answers.
   *
   * What "replying to …" in the live lane's peek points at. It rides on the
   * summarised row rather than being looked up again because the collapse to one
   * row per agent has already chosen which claim speaks for it, and a second
   * lookup could choose a different one.
   */
  entryId: string;
  /** Whether the room is still waiting for it, or has stopped. */
  state: WorkingState;
  /** ISO 8601 — when its oldest live claim started. */
  since: string;
  /** How long that claim has been running, by this client's clock. */
  elapsedMs: number;
}

/**
 * One agent whose message in this room has not started, because it is working
 * somewhere else.
 *
 * Deliberately NOT a {@link RoomPresenceAuthor}: nothing is running, so it has
 * no `state` to be late in and no elapsed WORK to report — the number beside it
 * is how long the person has been waiting, which is a different fact with the
 * same units.
 */
export interface RoomHoldRow {
  /** The agent the message is waiting for. */
  authorId: string;
  /** The first message this hold covers — the indicator's key. */
  entryId: string;
  /** ISO 8601 — when the wait started. */
  since: string;
  /** The room whose turn is in the way, as an id. The reader resolves the name. */
  behindRoomId: string;
  /** Whether this agent is holding a message in at least one other conversation. */
  othersWaiting: boolean;
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
              // Only a `held` frame carries one, and it is stored exactly as it
              // arrived: an id and a boolean. Spread conditionally so a frame
              // that changed state stops claiming to be waiting on anything.
              ...(state === 'held' && event.heldBehind !== undefined
                ? { heldBehind: event.heldBehind }
                : {}),
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
 * Which half of a room's presence a line is asking for, when a thread is open.
 *
 * **Presence follows you into a thread** (design record §3.2): the panel draws
 * the claims triggered inside the thread it is showing, and the room's line
 * draws everything else. The two are complements, so one claim renders exactly
 * once — without `inside: false` on the room's line, an agent working on a
 * thread reply would be announced twice, in two places, for the same work.
 *
 * **Scoped on the REPLIES, and deliberately not on the root.** A claim's
 * `entryId` is the entry whose trigger it answers, and the root is two things
 * at once: the head of the thread, and an ordinary message in the room's flow.
 * An agent triggered by the root was triggered before the thread existed and
 * its answer lands top-level, so counting the root in would move a room's wait
 * into an aside that has nothing to do with it. A reply is unambiguous.
 */
export interface PresenceScope {
  /** The ids of the open thread's replies. The root is not one of them. */
  replyIds: ReadonlySet<string>;
  /** `true` for the thread's own claims, `false` for everything else. */
  inside: boolean;
}

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
function summarize(
  indicators: Record<string, PresenceRecord> | undefined,
  scope: PresenceScope | undefined
): RoomPresenceAuthor[] {
  const oldest = oldestPerAuthor(indicators, scope, (record) => record.state !== 'held');
  if (oldest === null) return NOBODY;
  const now = Date.now();
  return [...oldest.values()]
    .sort(
      (a, b) => Date.parse(a.since) - Date.parse(b.since) || a.authorId.localeCompare(b.authorId)
    )
    .map((record) => ({
      authorId: record.authorId,
      entryId: record.entryId,
      // Narrowed by the filter above, which is the only place `held` can be
      // excluded once — a second `as` at each reader is how one of them ends up
      // drawing a working dot over a message that has not started.
      state: record.state as WorkingState,
      since: record.since,
      elapsedMs: Math.max(0, now - Date.parse(record.since)),
    }));
}

/**
 * Collapse a room's indicators to one row per agent, oldest first, for whichever
 * half of the store the caller wants.
 *
 * The shared body of {@link summarize} and {@link summarizeHolds}. The two halves
 * are complements — `held` in one, everything else in the other — so an agent
 * that is working here AND waiting here appears once in each, which is right:
 * they are two different messages.
 *
 * @param indicators - The room's raw indicators, or `undefined` for a quiet room.
 * @param scope - Which half of the room's presence to answer with, or `undefined`.
 * @param wanted - Which records this caller is asking about.
 * @returns One record per author, or `null` when there is nothing to report.
 */
function oldestPerAuthor(
  indicators: Record<string, PresenceRecord> | undefined,
  scope: PresenceScope | undefined,
  wanted: (record: PresenceRecord) => boolean
): Map<string, PresenceRecord> | null {
  if (indicators === undefined) return null;
  const now = Date.now();
  const oldest = new Map<string, PresenceRecord>();
  for (const record of Object.values(indicators)) {
    if (!wanted(record)) continue;
    if (now - record.lastSeenAt >= PRESENCE_TTL_MS) continue;
    // Filtered BEFORE the collapse to one row per agent, which matters: an
    // agent holding a claim in the room and another in the open thread is two
    // lines, in two places. Collapsing first would pick one claim for both and
    // draw the agent wherever that one happened to land.
    if (scope !== undefined && scope.replyIds.has(record.entryId) !== scope.inside) continue;
    const kept = oldest.get(record.authorId);
    if (kept === undefined || Date.parse(record.since) < Date.parse(kept.since)) {
      oldest.set(record.authorId, record);
    }
  }
  return oldest.size === 0 ? null : oldest;
}

/** One shared empty answer, so a room with nothing waiting never re-renders its reader. */
const NOTHING_WAITING: RoomHoldRow[] = [];

/**
 * Collapse a room's HELD indicators to one row per agent, oldest wait first.
 *
 * The complement of {@link summarize}, through the same scope filter — which
 * works for free, because a hold is keyed on the first held entry and a thread
 * reply scopes exactly like any other entry.
 *
 * @param indicators - The room's raw indicators, or `undefined` for a quiet room.
 * @param scope - Which half of the room's presence to answer with, or `undefined`.
 */
function summarizeHolds(
  indicators: Record<string, PresenceRecord> | undefined,
  scope: PresenceScope | undefined
): RoomHoldRow[] {
  const oldest = oldestPerAuthor(indicators, scope, (record) => record.state === 'held');
  if (oldest === null) return NOTHING_WAITING;
  return [...oldest.values()]
    .sort(
      (a, b) => Date.parse(a.since) - Date.parse(b.since) || a.authorId.localeCompare(b.authorId)
    )
    .map((record) => ({
      authorId: record.authorId,
      entryId: record.entryId,
      since: record.since,
      // A `held` record without its payload is one the producer could not
      // describe. It is still a real wait, so it is still reported — with no
      // room to point at, which the copy already has a sentence for.
      behindRoomId: record.heldBehind?.roomId ?? '',
      othersWaiting: record.heldBehind?.othersWaiting ?? false,
    }));
}

/**
 * Who is working in this room, oldest claim first, ticking.
 *
 * The timer runs only while the room has an indicator to draw, so a quiet room
 * costs nothing — and the moment the last one expires it stops itself.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param scope - Which half of the room's presence to answer with while a
 *   thread panel is open. Omit for all of it, which is the case whenever no
 *   thread is open — see {@link PresenceScope}.
 * @returns One entry per agent, oldest claim first. Empty when nobody is working.
 */
export function useRoomPresence(
  roomId: string | null,
  scope?: PresenceScope
): RoomPresenceAuthor[] {
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
  return summarize(indicators, scope);
}

/**
 * One agent's live claim in this room, WITHOUT the clock.
 *
 * Everything {@link RoomPresenceAuthor} carries except `elapsedMs`, which is the
 * only field that changes when nothing has happened.
 */
export type RoomPresenceClaimRow = Omit<RoomPresenceAuthor, 'elapsedMs'>;

/** One shared empty answer, so a quiet room never re-renders its reader. */
const NO_CLAIMS: RoomPresenceClaimRow[] = [];

/**
 * Who is working in this room, and on what — and NOT for how long.
 *
 * The question the live lane's host asks. It needs more than
 * {@link useRoomPresenceAuthorIds} gives (the state, the start, the entry each
 * claim answers) and strictly less than {@link useRoomPresence} gives: no
 * elapsed time, and therefore no re-render once a second.
 *
 * **That difference is the whole reason for a third hook.** The lane is mounted
 * by `RoomSurface`, which also mounts the timeline. Reading the ticking hook up
 * there would redraw every row in the room once a second for as long as any
 * agent was working — the exact regression `useRoomPresenceAuthorIds` was
 * written to undo, one layer up. Each row carries its immutable `since` and the
 * lane's own text node is what reads the clock.
 *
 * **One timer per reader, and it only prunes.** Expiry is a change to the STORE,
 * and the store already re-renders its readers, so nothing here needs a
 * re-render of its own. A quiet room runs no timer at all.
 *
 * **It excludes `held`**, which is the store's other half: a message waiting on
 * an agent that is working somewhere else has not started, so drawing it here
 * would put a working dot and a peek row under an agent doing nothing in this
 * room. {@link useRoomHolds} is where those live.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param scope - Which half of the room's presence to answer with while a thread
 *   panel is open. Omit for all of it — see {@link PresenceScope}.
 * @returns One row per agent, oldest claim first. Empty when nobody is working.
 */
export function useRoomPresenceClaims(
  roomId: string | null,
  scope?: PresenceScope
): readonly RoomPresenceClaimRow[] {
  const indicators = useRoomPresenceStore((held) =>
    roomId === null ? undefined : held.rooms[roomId]
  );
  const live = indicators !== undefined;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => useRoomPresenceStore.getState().prune(), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  return useMemo(() => {
    const working = summarize(indicators, scope);
    if (working.length === 0) return NO_CLAIMS;
    // `summarize` reads the clock to age records out, which is a filter here
    // rather than a value: the elapsed time it computed is dropped on this line,
    // so nothing this hook returns is a function of when it was called.
    return working.map(({ authorId, entryId, state, since }) => ({
      authorId,
      entryId,
      state,
      since,
    }));
  }, [indicators, scope]);
}

/** One shared empty answer, so a quiet room never re-renders its reader. */
const NO_IDS: string[] = [];

/**
 * What is WAITING in this room: one row per agent whose message here has not
 * started because it is working somewhere else.
 *
 * {@link useRoomPresenceClaims}'s complement, and the two never overlap — that
 * hook excludes `held` and this one is nothing but. Kept apart rather than
 * merged behind a flag because a waiting agent must never draw a working dot:
 * the whole value of the line is that it says work has NOT started.
 *
 * No clock, for the reason {@link useRoomPresenceClaims} has none: each row
 * carries its immutable `since` and the lane's own leaf reads the time.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param scope - Which half of the room's presence to answer with while a thread
 *   panel is open. Omit for all of it — see {@link PresenceScope}.
 * @returns One row per agent, oldest wait first. Empty when nothing is waiting.
 */
export function useRoomHolds(roomId: string | null, scope?: PresenceScope): readonly RoomHoldRow[] {
  const indicators = useRoomPresenceStore((held) =>
    roomId === null ? undefined : held.rooms[roomId]
  );
  const live = indicators !== undefined;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => useRoomPresenceStore.getState().prune(), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  return useMemo(() => summarizeHolds(indicators, scope), [indicators, scope]);
}

/**
 * WHO is working, without the clock.
 *
 * The same question {@link useRoomPresence} answers, minus the two things that
 * make that hook expensive to hold: the elapsed times, and the one-second timer
 * that keeps them true. A caller that only needs the names re-renders when the
 * names change and at no other moment.
 *
 * **That difference is worth a second hook.** The thread panel held the ticking
 * one for a list of author ids, so a panel with forty replies in it re-rendered
 * every reply, every reaction row and every action bar once a SECOND for as long
 * as an agent was working — to recompute a number the panel does not draw. The
 * elapsed time belongs to the line that shows it, which is a leaf, and this is
 * how everything else stops paying for it.
 *
 * Expired records are still filtered out, so a caller cannot read a claim that
 * has aged past {@link PRESENCE_TTL_MS} — but nothing here re-renders at the
 * moment one does. That is the trade, and it is the right one for a caller
 * asking "who has been working here lately".
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param scope - Which half of the room's presence to answer with while a
 *   thread panel is open. Omit for all of it — see {@link PresenceScope}.
 * @returns The author ids with a live claim, oldest claim first.
 */
export function useRoomPresenceAuthorIds(
  roomId: string | null,
  scope?: PresenceScope
): readonly string[] {
  const indicators = useRoomPresenceStore((held) =>
    roomId === null ? undefined : held.rooms[roomId]
  );
  return useMemo(() => {
    const working = summarize(indicators, scope);
    if (working.length === 0) return NO_IDS;
    return working.map((agent) => agent.authorId);
  }, [indicators, scope]);
}

/**
 * One agent's live claim, with the room it was taken in — and WITHOUT the
 * clock.
 *
 * It carries `since`, which never changes, rather than an elapsed time, which
 * changes every second. See {@link useRoomPresenceEverywhere} for why that is
 * the difference between a caller that re-renders on events and one that
 * re-renders forever.
 */
export interface RoomPresenceClaim extends Omit<RoomPresenceAuthor, 'elapsedMs'> {
  /** The room the claim was taken in. */
  roomId: string;
}

/** One shared empty answer, so a quiet cockpit never re-renders its reader. */
const NOBODY_ANYWHERE: RoomPresenceClaim[] = [];

/**
 * Who is working, in every room this client can hear at once.
 *
 * The same claims {@link useRoomPresence} answers with, unscoped to any one
 * room — for the surface that asks "who on this team is working right now"
 * rather than "is this room still waiting". The home header's presence strip is
 * that surface.
 *
 * **This is bounded by what the client can HEAR, and that is the honest
 * bound.** Claims reach the store from a room's own `/api/rooms/:id/events`
 * stream, so this answers for the rooms this client is subscribed to and says
 * nothing about the rest. The global fan-out carries a bare count per room
 * (`useRoomWorking`) with no author on it, so there is no second source to fold
 * in here that would not be an invention — a strip that guessed would be
 * exactly the lie the spec forbids.
 *
 * **No clock, for the reason {@link useRoomPresenceAuthorIds} exists.** This
 * answers with each claim's immutable `since` and never an elapsed time, so a
 * second passing changes nothing and the array it returns keeps its identity
 * until presence actually moves. Its caller is a header pinned above a feed:
 * handing it a number that changes every second would re-render that header,
 * its avatars and its hover cards once a second for as long as any agent
 * anywhere is working. The elapsed time belongs to the leaf that draws it.
 *
 * **One timer per reader, and it only prunes.** It runs while this reader has
 * live presence to hold, drops what has aged past {@link PRESENCE_TTL_MS}, and
 * carries no re-render of its own — expiry is a change to the STORE, and the
 * store already re-renders its readers (the same shape `useRoomWorking` uses).
 * A cockpit where nothing is working runs no timer at all.
 *
 * @returns One entry per agent per room, oldest claim first. Empty when nobody
 *   anywhere is working.
 */
export function useRoomPresenceEverywhere(): readonly RoomPresenceClaim[] {
  const rooms = useRoomPresenceStore((held) => held.rooms);
  const live = Object.keys(rooms).length > 0;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => useRoomPresenceStore.getState().prune(), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  return useMemo(() => {
    const claims: RoomPresenceClaim[] = [];
    for (const [roomId, indicators] of Object.entries(rooms)) {
      // `summarize` reads the clock to age records out, which is a filter here
      // rather than a value: its elapsed time is dropped on the next line, so
      // nothing this hook returns is a function of when it was called.
      for (const agent of summarize(indicators, undefined)) {
        claims.push({
          roomId,
          authorId: agent.authorId,
          entryId: agent.entryId,
          state: agent.state,
          since: agent.since,
        });
      }
    }
    if (claims.length === 0) return NOBODY_ANYWHERE;
    // Oldest claim first, exactly as within one room — the agent that has been
    // waiting longest is the one a person most needs to see, whichever room it
    // is in. The author id breaks ties so the order cannot flicker.
    return claims.sort(
      (a, b) => Date.parse(a.since) - Date.parse(b.since) || a.authorId.localeCompare(b.authorId)
    );
  }, [rooms]);
}
