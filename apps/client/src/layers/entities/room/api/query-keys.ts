/**
 * Query keys for the room entity. One factory so every consumer — the sidebar,
 * the room view, and the mutations that invalidate them — agrees on the shape.
 *
 * @module entities/room/api/query-keys
 */
import type { RoomKind } from '@dorkos/shared/room-schemas';

/** TanStack Query keys for rooms. */
export const roomKeys = {
  /** Root key — invalidating this refreshes every room query. */
  all: ['rooms'] as const,
  /** The room list, optionally filtered to one kind. */
  list: (kind?: RoomKind) => ['rooms', 'list', kind ?? null] as const,
  /** Every room list, whatever its filter. */
  lists: () => ['rooms', 'list'] as const,
  /**
   * The archived-inclusive lookup of one well-known room (`#team`).
   *
   * **Deliberately NOT under `list`**, even though it reads the same route. The
   * list keys are written by PREFIX — `applyReadCursor` patches every match of
   * `lists()` at once, and a patch that maps over its data would throw on this
   * entry, whose data is one room or `null` rather than an array. A prefixed
   * writer cannot know the shape of every key it matches, so the honest fix is
   * for this key not to be one of them. Its freshness is bought explicitly
   * instead: `useRoomListStream` and `refreshRoom` invalidate
   * {@link roomKeys.wellKnowns} by name.
   */
  wellKnown: (key: string) => ['rooms', 'well-known', key] as const,
  /** Every well-known lookup — what the room-list events invalidate. */
  wellKnowns: () => ['rooms', 'well-known'] as const,
  /** One room with its roster. */
  detail: (roomId: string) => ['rooms', 'detail', roomId] as const,
  /**
   * Every room's detail, whatever the id.
   *
   * Its own factory rather than `all` for the same reason `lists()` is: `all`
   * is a PREFIX, so invalidating it reaches `entries` too — and a room's
   * history is owned by its live stream, which means sweeping it discards
   * entries the socket delivered and the server will never re-send. Anything
   * that wants "every room read except the histories" reaches for these three.
   */
  details: () => ['rooms', 'detail'] as const,
  /**
   * Every thread the reader takes part in, across every room. Not under
   * `list`, because it is not a room list — invalidating the room lists must
   * not have to know about it, and the two are refreshed by the same events
   * from one place rather than by being spelled alike.
   */
  threads: () => ['rooms', 'threads'] as const,
  /** One room's history. */
  entries: (roomId: string) => ['rooms', 'entries', roomId] as const,
};
