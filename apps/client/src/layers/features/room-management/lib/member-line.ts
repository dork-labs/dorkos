/**
 * The second line of a member's row — what this member has actually done here.
 *
 * Pure and separate from the row, because the whole difficulty is in the copy
 * rather than in the layout: every one of these sentences is a claim about
 * somebody's agent, and the cockpit only holds evidence for three of them.
 *
 * **What is deliberately not here: "hasn't spoken here yet".** It is the most
 * obvious line to write and it cannot be justified. The room's history reader
 * returns only the TRAILING page, so an agent that spoke five hundred messages
 * ago reads exactly like one that has never spoken — and the row would print a
 * libel about an agent that has been talking all week. Absence of evidence is
 * not evidence of silence, so the row falls back to a fact it always has.
 *
 * @module features/room-management/lib/member-line
 */
import { formatRelativeTime } from '@/layers/shared/lib';
import { presenceElapsed, type RoomPresenceAuthor } from '@/layers/entities/room';

/** Everything the row knows about what one member has done in this room. */
export interface MemberLineFacts {
  /**
   * This member's live work signal, or `null`.
   *
   * `null` covers two different worlds and correctly says the same thing about
   * both: nobody is working, and this client has no stream to be told on. The
   * room sheet opens over rooms that are not on screen, and those have no
   * subscription — see {@link memberSecondaryLine}.
   */
  presence: RoomPresenceAuthor | null;
  /** When this member last posted, if a post of theirs is in the loaded page. */
  lastSpokeAt: string | null;
  /** When this member joined. The one fact that is always there and always true. */
  joinedAt: string;
}

/**
 * The most useful true thing about this member, in one line.
 *
 * Priority, loudest first: what it is doing now, then the last time it said
 * something here, then when it arrived. Each rung is skipped when the evidence
 * for it is missing rather than guessed at.
 *
 * **A missing presence signal is silently skipped, not reported.** The signal
 * rides the room's own SSE stream, which only the room on screen has open, so
 * opening this sheet from the sidebar over some other room means there is
 * nothing to know — and the honest response to that is to say the next true
 * thing, not to draw an empty indicator or to open a second stream to decorate a
 * dialog.
 *
 * The timestamps come from the cockpit's one relative-time voice
 * ({@link formatRelativeTime}), so a member row and a session row age the same
 * way. It capitalises its own output — "Just now", "Tue, 3pm" — which is why
 * these lines read "last spoke Just now" rather than sentence case; a second
 * time vocabulary would be a worse trade than a capital letter.
 *
 * @param facts - What is known about this member in this room.
 */
export function memberSecondaryLine(facts: MemberLineFacts): string {
  if (facts.presence !== null) {
    return facts.presence.state === 'working_late'
      ? `still working, ${presenceElapsed(facts.presence.elapsedMs)}`
      : 'working now';
  }
  if (facts.lastSpokeAt !== null) return `last spoke ${formatRelativeTime(facts.lastSpokeAt)}`;
  return `joined ${formatRelativeTime(facts.joinedAt)}`;
}
