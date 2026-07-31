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
  /** One room with its roster. */
  detail: (roomId: string) => ['rooms', 'detail', roomId] as const,
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
