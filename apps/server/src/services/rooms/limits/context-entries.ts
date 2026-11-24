/**
 * Which room messages a turn's context puts in front of the agent, so the turn can be marked on
 * what it was shown and not only on what it answers (DOR-4453 F1).
 *
 * @module server/services/rooms/limits/context-entries
 */
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import {
  answersOutsideWords,
  isEntryAuthorExternal,
  strangerMarkForEntries,
  type ReadEntry,
} from './turn-ceiling.js';

/**
 * The id of every room message a built context shows the agent besides the one it answers: the
 * unread window, a gathered burst, a thread turn's channel glance, and the thread opener's excerpt.
 *
 * The agent's own recent posts are left out: it wrote them. So is room text that is not a
 * message, which a non-owner may have written. That gap is accepted, pending Security's sign-off,
 * and no check may rely on the mark covering it:
 *
 * - the room's topic, up to 500 characters, rendered on every turn. No editor is recorded for it,
 *   so a turn cannot be marked by who set it;
 * - canvas document titles and links, whose author the canvas names by handle only;
 * - roster names and a forum topic's name.
 *
 * A bridged group's far-end title is not shown at all while it still names the room
 * (`room-context.ts` `roomName`), so it needs no mark.
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

/** What {@link marksForShown} reads: the room log, its reactions, its authors and the owner. */
export interface ShownMarkDeps {
  store: { listEntriesByIds(roomId: string, ids: string[]): RoomEntry[] };
  reactions: {
    listFor(roomId: string, entryIds: readonly string[]): Map<string, RoomEntryReaction[]>;
  };
  authors: AuthorRegistry;
  isOwnerAuthor: (authorId: string) => boolean;
}

/**
 * Everyone whose reaction stands on the agent's own recent posts, the posts whose reactions the
 * context shows as acknowledgments, leaving out the agent itself (DOR-4144). The context renders
 * at most five of them by name, beside the emoji; reading every one can only add a mark. Who
 * reacted is someone the turn was shown, as a line's author is.
 *
 * @param deps - The room's reactions.
 * @param roomId - The room.
 * @param context - The context built for this turn.
 * @param selfAuthorId - The author id of the agent taking the turn.
 */
function shownReactors(
  deps: Pick<ShownMarkDeps, 'reactions'>,
  roomId: string,
  context: RoomContextData,
  selfAuthorId: string
): ReadEntry[] {
  if (context.ownRecent.length === 0) return [];
  const pills = deps.reactions.listFor(
    roomId,
    context.ownRecent.map((entry) => entry.id)
  );
  const reactors = new Set<string>();
  for (const row of pills.values())
    for (const pill of row) for (const authorId of pill.authorIds) reactors.add(authorId);
  reactors.delete(selfAuthorId);
  return [...reactors].map((authorId) => ({ authorId }));
}

/** A message a room turn answers, with what says where its words came from. */
type AnsweredEntry = Pick<RoomEntry, 'id' | 'authorId'> & Pick<ReadEntry, 'body'>;

/**
 * What a room turn carries for every message it answers AND every message its context showed,
 * read from the room log once:
 *
 * - the outsider mark (`carriedOutsider`): a non-owner's unaddressed post in the window marks the
 *   turn as surely as one that named the agent (DOR-3858, behind its boot flag), and so does a
 *   mini app's post or forward, whatever the flag (DOR-4587, `strangerMarkForEntries`);
 * - the outside-words note (`outsideWords`): a turn shown outside words is marked the same as one
 *   that answered them, so a later raise asks (DOR-4144). A stamp, never a ceiling: it lowers
 *   nothing (Security M4).
 *
 * Both read the messages {@link contextEntryIds} names, so neither counts the agent's own recent
 * posts, and both read who reacted to those posts ({@link shownReactors}): a stranger's reaction
 * shown as an acknowledgment counts as a stranger's line does (DOR-4144). The note also leaves out any shown message the turn's own agent wrote, which today can
 * only be the opener of a thread it started: a noted chat's posts are kept with the outsider mark,
 * so counting its own post would keep the chat noted by what it wrote itself, turn after turn,
 * for as long as the thread is in use. The mark still counts that opener (DOR-4453).
 *
 * @param enabled - Whether `DORKOS_MARK_STRANGER_TURNS` is on.
 * @param deps - See {@link ShownMarkDeps}.
 * @param roomId - The room the turn runs in.
 * @param answered - The messages the turn answers; empty for an aside, which answers nothing.
 * @param context - The context built for this turn.
 * @param selfAuthorId - The author id of the agent taking the turn.
 */
export function marksForShown(
  enabled: boolean,
  deps: ShownMarkDeps,
  roomId: string,
  answered: readonly AnsweredEntry[],
  context: RoomContextData,
  selfAuthorId: string
): { carriedOutsider?: true; outsideWords?: true } {
  const shown = deps.store.listEntriesByIds(roomId, contextEntryIds(context));
  const others = shown.filter((entry) => entry.authorId !== selfAuthorId);
  const reactors = shownReactors(deps, roomId, context, selfAuthorId);
  return {
    ...strangerMarkForEntries(
      enabled,
      deps.authors,
      [...answered, ...shown, ...reactors],
      deps.isOwnerAuthor,
      roomId
    ),
    ...(answersOutsideWords(deps.authors, [...answered, ...others], roomId) ||
    reactors.some((reactor) => isEntryAuthorExternal(deps.authors, reactor.authorId))
      ? { outsideWords: true as const }
      : {}),
  };
}
