/**
 * Read the rooms this cockpit can see (spec `rooms` §7).
 *
 * One query holds every non-archived room and callers partition it by kind, so
 * the sidebar's two sections share a single request and a single cache to
 * invalidate.
 *
 * @module entities/room/model/use-rooms
 */
import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { roomName } from '../lib/room-display';

/** How long a room list stays fresh before a refocus refetches it. */
const ROOMS_STALE_TIME_MS = 30_000;

/**
 * How two channel names compare. `numeric` so `#room-2` precedes `#room-10`
 * rather than following it, and `sensitivity: 'base'` so case never decides an
 * order — a case-only difference is a tie, and ties are broken on the id below.
 */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Channels, alphabetically.
 *
 * Slack orders channels by name for one reason: the list stops moving, so you
 * learn where things are and can hit the same row without reading it. Ordering
 * them by recency instead — which is what the server returns — reorders the
 * sidebar under the pointer every time anybody says anything
 * (`research/20260727_chat-navigation-quick-switcher-patterns.md`).
 *
 * The id breaks a tie. Two live channels cannot share a slug, but a channel
 * whose slug is missing falls back to its title, and two of those can collide.
 */
function compareChannels(a: RoomSummary, b: RoomSummary): number {
  return byName.compare(roomName(a), roomName(b)) || a.id.localeCompare(b.id);
}

/**
 * Direct messages, most recent first.
 *
 * The opposite call from channels, and deliberately: a DM is a conversation, not
 * a place, so the one you spoke in last is the one you want at the top.
 *
 * `lastActivityAt` is always a UTC ISO-8601 timestamp, so comparing the strings
 * compares the instants. The id breaks a tie descending too, which puts the
 * newer ULID first — the same direction the sort itself runs.
 */
function compareDirectMessages(a: RoomSummary, b: RoomSummary): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
}

/**
 * Fetch every room the caller may see, newest activity first.
 *
 * Each summary carries `unreadCount`, which is `null` for a room the caller has
 * not joined. That is not zero — see {@link RoomSummary}.
 *
 * @param options.enabled - Ask the server at all. `false` holds the query idle
 *   for a caller that is mounted but not showing anything, which is a real case
 *   here: the recents panel is mounted on every room composer and offered on
 *   one. It cannot suppress a fetch somebody else wants — TanStack runs a query
 *   while ANY of its observers is enabled — so the sidebar's copy is untouched.
 * @param options.includeArchived - Take archived rooms too. Off by default, and
 *   opt-in for one caller only: the command palette, so a channel somebody
 *   closed can still be searched for. It buys its own cache entry
 *   ({@link roomKeys.listWithArchived}) rather than widening this one, because
 *   every other reader — the sidebar, the room view, the presence strip — draws
 *   from `roomKeys.list()` and must never be handed an archived room by a
 *   consumer it has never heard of.
 */
export function useRooms(
  options: { enabled?: boolean; includeArchived?: boolean } = {}
): UseQueryResult<RoomSummary[]> {
  const transport = useTransport();
  const includeArchived = options.includeArchived ?? false;
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: includeArchived ? roomKeys.listWithArchived() : roomKeys.list(),
    // The flag is OMITTED when off, never sent as `false`. `GET /api/rooms`
    // parses it with `z.coerce.boolean()`, and a query string carries `false` as
    // the four-character string `"false"` — which coerces to `true`. Spelling
    // out the negative would switch archived rooms on for every caller.
    queryFn: () =>
      includeArchived ? transport.listRooms({ includeArchived: true }) : transport.listRooms(),
    staleTime: ROOMS_STALE_TIME_MS,
  });
}

/** A room list split into the two kinds the sidebar renders. */
export interface RoomsByKind {
  channels: RoomSummary[];
  dms: RoomSummary[];
}

/**
 * Split a room list into channels and direct messages, each in the order its
 * own kind wants: channels by name, direct messages by recency.
 *
 * There is no third partition and no row to drop: a thread is a relation
 * between entries inside a room's own log (ADR 260728-022013), so it is not in
 * this list at all. The sidebar's Threads section is a section, not a kind —
 * it reads {@link useThreads}, which asks a different question of a different
 * route.
 *
 * **Why the order is decided here and not in the query.** `GET /api/rooms`
 * answers with every kind in one list, and a SQL `ORDER BY` can only impose one
 * total order on that — so "channels by name, DMs by recency" would have to
 * become a synthetic sort key that also groups the kinds, an ordering no caller
 * asked for. The kinds are already told apart here,
 * once; the server keeps the single honest contract it documents (recency), and
 * ordering stays a presentation choice — which it has to be, since the command
 * palette will want the same rooms unread-first (spec `rooms` §13.2).
 *
 * Both comparators end on the room id, so rows that tie never swap places
 * between renders.
 *
 * @param rooms - The full room list, or undefined while it loads.
 */
export function useRoomsByKind(rooms: RoomSummary[] | undefined): RoomsByKind {
  return useMemo(
    () => ({
      channels: (rooms ?? []).filter((room) => room.kind === 'channel').sort(compareChannels),
      dms: (rooms ?? []).filter((room) => room.kind === 'dm').sort(compareDirectMessages),
    }),
    [rooms]
  );
}
