interface RoomStalledNoticeProps {
  /**
   * True when the room's live stream has given up.
   *
   * A prop rather than the caller's `&&`, and that is the whole of why the
   * announcement works — see the announcer below.
   */
  stalled: boolean;
  /** Ask the room's stream to try now, rather than waiting out its backoff. */
  onRetry: () => void;
  /**
   * True when the server has answered that this reader may not read this room —
   * it is gone, or they are signed out, or they are no longer a member.
   *
   * A different sentence, because "reconnecting" is a promise nothing is going
   * to keep: the loop has stopped, deliberately, and telling somebody to wait
   * for a room that no longer exists is worse than the frozen-room bug this
   * notice was written for.
   */
  unavailable?: boolean;
}

/**
 * What the line says, in the one place both the announcement and the sentence
 * on screen can read it from.
 *
 * @param unavailable - Whether the room itself is gone rather than unreachable.
 */
function stalledSentence(unavailable: boolean): string {
  return unavailable
    ? 'This room is no longer available. It may have been deleted, or you may no longer have access to it.'
    : "New messages aren't coming through right now. You can still send — anything that doesn't get through will say so.";
}

/**
 * The line above the composer for a room that has stopped hearing.
 *
 * **A room that has stopped listening looks exactly like a quiet one**, which is
 * the whole reason this exists — nothing else in the product reports it, because
 * the global stream keeps reconnecting and re-badging the room in the sidebar
 * while the room on screen sits frozen.
 *
 * One line, no banner, and the composer beside it stays open. You can still read
 * and still post; what you post still goes through the same request it always
 * did, and if it does not, its own row says so (`RoomPendingRow`). Disabling the
 * composer here was the obvious move and the wrong one: it would take the room
 * away over a fault the reader can neither see nor fix, and the loop underneath
 * is now retrying continuously anyway — a stall is a statement about right now,
 * not a dead end.
 *
 * The button stays because waiting is the one thing a person in this state does
 * not want to do: the backoff is at its thirty-second cap by the time anybody
 * reads this line, and pressing it tries immediately.
 *
 * **It is mounted whether or not the room has stalled**, and that is what makes
 * the sentence reach somebody who cannot see it. A live region that ARRIVES with
 * its text already in it is the classic case assistive technology does not
 * announce — the region has to be being watched before the words land in it. So
 * the announcer is always here and empty, and the visible line is the part that
 * comes and goes. Same shape as `RoomPresenceLine`, which carries the identical
 * note for the identical reason.
 *
 * @param props - Whether the room has stalled, and how to ask for a retry.
 */
export function RoomStalledNotice({
  stalled,
  onRetry,
  unavailable = false,
}: RoomStalledNoticeProps) {
  return (
    <>
      {/* Always mounted, `sr-only`, and empty until there is something to say —
          so it reserves no space and the room still looks like a room. */}
      <span
        data-testid="room-stalled-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {stalled ? stalledSentence(unavailable) : ''}
      </span>
      {stalled && (
        // No `role="status"` here: the announcer above already says this, and
        // two live regions carrying one sentence is that sentence twice.
        <div
          data-testid="room-stalled"
          data-unavailable={unavailable ? 'true' : undefined}
          className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-2 text-xs"
        >
          <span>{stalledSentence(unavailable)}</span>
          {/* Offered in both states. One of the three ways to reach the
              unavailable one — a signed-out session — is something a person
              fixes in another tab and comes back from. It just does not promise
              anything. */}
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring hover:text-foreground rounded underline underline-offset-2"
          >
            {unavailable ? 'Try again' : 'Reconnect'}
          </button>
        </div>
      )}
    </>
  );
}
