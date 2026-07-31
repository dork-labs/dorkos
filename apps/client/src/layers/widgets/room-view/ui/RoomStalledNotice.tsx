interface RoomStalledNoticeProps {
  /** Ask the room's stream to try now, rather than waiting out its backoff. */
  onRetry: () => void;
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
 * @param props - How to ask for a retry.
 */
export function RoomStalledNotice({ onRetry }: RoomStalledNoticeProps) {
  return (
    <div
      role="status"
      data-testid="room-stalled"
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-4 py-2 text-xs"
    >
      <span>
        New messages aren&apos;t coming through right now. You can still send — anything that
        doesn&apos;t get through will say so.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring hover:text-foreground rounded underline underline-offset-2"
      >
        Reconnect
      </button>
    </div>
  );
}
