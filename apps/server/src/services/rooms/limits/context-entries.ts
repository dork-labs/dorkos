/**
 * Which room messages a turn's context puts in front of the agent, so the turn can be marked on
 * what it was shown and not only on what it answers (DOR-4453 F1).
 *
 * @module server/services/rooms/limits/context-entries
 */
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import { strangerMarkForEntries } from './turn-ceiling.js';

/**
 * The id of every room message a built context shows the agent besides the one it answers: the
 * unread window, a gathered burst, a thread turn's channel glance, and the thread opener's excerpt.
 *
 * The agent's own recent posts are left out: it wrote them. So are the short labels a context
 * also carries: canvas document titles and links, roster names, a forum topic's name and a bridged
 * chat's title. Each is a few sanitized words a non-owner may have chosen, not a message, and the
 * canvas names its author by handle only. That gap is accepted, not overlooked: no check may rely
 * on the mark covering those words.
 *
 * @param context - The context `buildRoomContext` returned for this turn.
 */
export function contextEntryIds(context: RoomContextData): string[] {
  return [
    ...context.pending.map((entry) => entry.id),
    ...(context.gathered ?? []).map((entry) => entry.id),
    ...(context.channelTail ?? []).map((entry) => entry.id),
    ...(context.thread ? [context.thread.rootEntryId] : []),
  ];
}

/** What {@link strangerMarkForShown} reads: the room log, its authors and who owns the install. */
export interface ShownMarkDeps {
  store: { listEntriesByIds(roomId: string, ids: string[]): RoomEntry[] };
  authors: AuthorRegistry;
  isOwnerAuthor: (authorId: string) => boolean;
}

/**
 * DOR-3858's stranger mark over every message a room turn answers AND every message its context
 * showed, so a non-owner's unaddressed post in the window marks the turn as surely as one that
 * named the agent. Nothing is read while the boot flag is off.
 *
 * @param enabled - Whether `DORKOS_MARK_STRANGER_TURNS` is on.
 * @param deps - See {@link ShownMarkDeps}.
 * @param roomId - The room the turn runs in.
 * @param answered - The messages the turn answers; empty for an aside, which answers nothing.
 * @param context - The context built for this turn.
 */
export function strangerMarkForShown(
  enabled: boolean,
  deps: ShownMarkDeps,
  roomId: string,
  answered: readonly Pick<RoomEntry, 'authorId'>[],
  context: RoomContextData
): { carriedOutsider?: true } {
  if (!enabled) return {};
  const shown = deps.store.listEntriesByIds(roomId, contextEntryIds(context));
  return strangerMarkForEntries(true, deps.authors, [...answered, ...shown], deps.isOwnerAuthor);
}
