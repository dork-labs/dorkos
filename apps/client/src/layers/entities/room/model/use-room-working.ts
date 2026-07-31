/**
 * Which rooms have an agent working in them, for rooms nobody has open.
 *
 * The sibling of the presence store, one grain coarser and one stream over. A
 * room's own signals reach only the reader inside it, so the sidebar — which
 * draws every room at once — rides the global `room_presence` fan-out instead
 * and gets a bare count per room (room-presence spec §6).
 *
 * The same liveness rules apply, for the same reason: nothing here is persisted
 * anywhere, so what is stored is only ever the recent past.
 *
 * - A count of `0` is a STATEMENT, not a heartbeat. It is kept, un-aged, until
 *   something replaces it — it is what makes the dot go out, and expiring it
 *   would resurrect a stale dot from a room list fetched minutes ago.
 * - A count above zero that nothing restates within {@link PRESENCE_TTL_MS}
 *   BECOMES that statement rather than disappearing. This is the crash story: a
 *   server that dies mid-turn stops republishing and every open sidebar goes
 *   quiet within thirty seconds — and it only stays quiet because a dead
 *   heartbeat leaves a zero behind. Deleting the record instead would hand the
 *   row back to the room list, which is cached, never invalidated by presence,
 *   and still remembers the turn that died — so the dot would come back on and
 *   stay on for as long as the tab is open.
 * - Until anything has been heard, the room list's own `working` field answers,
 *   so a freshly loaded cockpit draws its dots immediately rather than after the
 *   first republish tick.
 *
 * @module entities/room/model/use-room-working
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { PRESENCE_TICK_MS, PRESENCE_TTL_MS } from './use-room-presence';

/** The last thing the fan-out said about one room. */
interface WorkingRecord {
  /** How many agents were working in it. */
  working: number;
  /** This client's clock at that moment. */
  lastSeenAt: number;
}

/** Every room the fan-out has spoken about lately. */
interface RoomWorkingStoreState {
  /** Room id → the last count heard for it. */
  rooms: Record<string, WorkingRecord>;
}

/** Ways the picture of which rooms are busy changes. */
interface RoomWorkingActions {
  /**
   * Take in one `room_presence` event off the global stream.
   *
   * The payload arrives as `unknown` — the fan-out is a string-keyed channel and
   * nothing types the two ends together — so it is checked rather than trusted.
   * A malformed event is dropped silently: this draws a dot, and a dot is not
   * worth a console the operator has to read past.
   *
   * @param payload - The event body, straight off the stream.
   * @param now - This client's clock, injectable for tests.
   */
  observe: (payload: unknown, now?: number) => void;
  /**
   * Turn every count nothing has restated within {@link PRESENCE_TTL_MS} into a
   * zero.
   *
   * A silence is an answer here, so the record is REPLACED rather than removed —
   * see the module doc for what removing it would let back in. Zeroes are
   * already at rest and are left alone.
   *
   * @param now - This client's clock, injectable for tests.
   */
  prune: (now?: number) => void;
}

/** Is this an event that says how many agents are working in a room? */
function isPresenceCount(payload: unknown): payload is { roomId: string; working: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const { roomId, working } = payload as { roomId?: unknown; working?: unknown };
  return typeof roomId === 'string' && roomId.length > 0 && typeof working === 'number';
}

/** The working-count store. Read it through {@link useRoomWorking}. */
export const useRoomWorkingStore = create<RoomWorkingStoreState & RoomWorkingActions>()(
  devtools(
    (set) => ({
      rooms: {},

      observe: (payload, now = Date.now()) => {
        if (!isPresenceCount(payload)) return;
        const { roomId, working } = payload;
        set(
          (held) => ({
            rooms: { ...held.rooms, [roomId]: { working: Math.max(0, working), lastSeenAt: now } },
          }),
          false,
          'roomWorking/observe'
        );
      },

      prune: (now = Date.now()) =>
        set(
          (held) => {
            let changed = false;
            const rooms: RoomWorkingStoreState['rooms'] = {};
            for (const [roomId, record] of Object.entries(held.rooms)) {
              if (record.working > 0 && now - record.lastSeenAt >= PRESENCE_TTL_MS) {
                changed = true;
                rooms[roomId] = { working: 0, lastSeenAt: record.lastSeenAt };
                continue;
              }
              rooms[roomId] = record;
            }
            return changed ? { rooms } : held;
          },
          false,
          'roomWorking/prune'
        ),
    }),
    { name: 'RoomWorkingStore' }
  )
);

/**
 * How many agents are working in one room, as far as this client can tell.
 *
 * The stream wins over the list whenever it has spoken, because the list is a
 * snapshot from whenever it was last fetched and the stream is now — including
 * the case that matters most, a `0` that has to be able to switch a dot off
 * while a cached list still remembers the turn.
 *
 * The timer runs only while this reader is looking at a room the stream says is
 * busy, which for a sidebar full of quiet rooms is never. It carries no re-render
 * of its own — unlike the presence line, which redraws every second to tick an
 * elapsed time, a dot has nothing that changes between events. The one thing the
 * timer can change is the store, and the store already re-renders its readers.
 *
 * @param roomId - The room the row is for.
 * @param listed - The count the room list carried, if it carried one.
 * @returns The number of agents working there. `0` when nobody is.
 */
export function useRoomWorking(roomId: string, listed: number | undefined): number {
  const record = useRoomWorkingStore((held) => held.rooms[roomId]);
  const ageing = record !== undefined && record.working > 0;

  useEffect(() => {
    if (!ageing) return;
    const timer = setInterval(() => useRoomWorkingStore.getState().prune(), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [ageing]);

  return countNow(record, listed);
}

/**
 * How many agents are working in the room that is OPEN.
 *
 * The same answer {@link useRoomWorking} gives a sidebar row, for a surface that
 * does not have a `RoomSummary` in its hand: the open room is read as a
 * `RoomWithRoster`, which carries no count, so the seed comes out of the room
 * list this cockpit has already fetched.
 *
 * **The seed is the whole point.** Opening a room mid-turn is the case a live
 * signal cannot cover: the room's own stream publishes presence, but the next
 * republish is up to ten seconds away, so for those ten seconds a reader who
 * opened a working room would be told nothing is happening. The list's `working`
 * field is a live read of the same claim map, taken when the list was fetched,
 * and it fills exactly that gap — then the stream takes over, as it does for the
 * sidebar.
 *
 * **It never fetches.** `enabled: false` makes this an observer on a cache the
 * sidebar already fills; a room's masthead is not worth a request, and mounting
 * a second fetching observer on a stale list query would start a background
 * refetch to decorate a chip.
 *
 * @param roomId - The room on screen.
 * @returns The number of agents working there. `0` when nobody is, and when
 *   this client has never read a room list.
 */
export function useOpenRoomWorking(roomId: string): number {
  const transport = useTransport();
  const listed = useQuery({
    queryKey: roomKeys.list(),
    queryFn: () => transport.listRooms(),
    enabled: false,
  }).data?.find((room) => room.id === roomId)?.working;
  return useRoomWorking(roomId, listed);
}

/**
 * What one row draws, right now.
 *
 * **It reads the clock itself**, like the presence line's own summary and for
 * the same reason: a row that mounted between two prunes would otherwise draw a
 * dot the store is about to drop, and "how long ago was this said" is a question
 * about now that something has to ask.
 *
 * @param record - The last count heard for this room, if any.
 * @param listed - The count the room list carried, if it carried one.
 */
function countNow(record: WorkingRecord | undefined, listed: number | undefined): number {
  if (record === undefined) return listed ?? 0;
  if (record.working > 0 && Date.now() - record.lastSeenAt >= PRESENCE_TTL_MS) return 0;
  return record.working;
}
