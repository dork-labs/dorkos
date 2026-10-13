/**
 * When this window last heard that every session list is wrong.
 *
 * Two things mark a cached session list invalidated, and they mean opposite
 * things for an agent click. A Claude account switch (`session_list_invalidated`)
 * changes which stores the server reads, so a list cached before it can name a
 * chat that belongs to the account no longer signed in: it must not be trusted.
 * A reconnect of the event stream marks every cache invalidated too, but only
 * because events may have been missed while it was down: the list is still the
 * right agent's chats, just possibly behind. That one can open the chat at once
 * and refresh behind it (DOR-2891).
 *
 * This records the moment of the last account switch, so a list can be told
 * apart by when it was fetched. Every time here is THIS window's clock: the
 * server's own timestamp is only ever compared with itself, as a version, so a
 * phone or a laptop whose clock disagrees with the server's cannot be talked
 * into trusting a list from the old account.
 *
 * The live event is not replayed to a stream that was down (a hidden tab
 * releases its stream), so the server also names its last switch in every
 * `connected` frame. From a drop until that frame arrives no cached list is
 * trusted: the stream reports itself connected (and a reconnect invalidates
 * every list) one round trip before the frame can say whether a switch was
 * missed. A fresh window is not held to that: per-folder lists are never
 * restored from storage, so every one it holds was fetched from the server as
 * it is now, and its first frame still marks any switch it names.
 *
 * @module entities/session/lib/session-list-reset
 */

/** This window's clock when it last learned of a switch. */
let lastResetAt = 0;
/** The server's name for its last switch, as last heard; undefined before any. */
let lastStamp: string | null | undefined;
/** Whether the stream has been down since the last `connected` frame. */
let awaitingStamp = false;
/** This window's clock when the stream last went down. */
let downAt = 0;

/** Record, on this window's clock, that every cached session list was declared wrong. */
function markReset(): void {
  lastResetAt = Date.now();
}

/**
 * The live account-switch event arrived.
 *
 * @param stamp - The server's name for this switch, when the event carries one,
 *   so the next `connected` frame naming the same switch does not count it again.
 */
export function markSessionListsReset(stamp?: string): void {
  markReset();
  if (stamp !== undefined) lastStamp = stamp;
}

/**
 * The event stream went down, or is opening again after a hidden tab released
 * it: events, the account-switch one included, may be missed from here until
 * the next `connected` frame says otherwise.
 */
export function markSessionListsStreamDown(): void {
  if (!awaitingStamp) downAt = Date.now();
  awaitingStamp = true;
}

/**
 * A `connected` frame arrived, naming the server's last switch.
 *
 * A name this window has not heard before means a switch happened that it did
 * not see live, so every list cached until now is suspect. The very first frame
 * a window hears counts too when it names a switch: a list cached before it
 * (restored from storage) cannot be shown to postdate that switch.
 *
 * @param stamp - The server's name for its last switch, or null when it has
 *   made none since it started.
 */
export function noteSessionListsResetStamp(stamp: string | null): void {
  if (stamp !== null && stamp !== lastStamp) markReset();
  lastStamp = stamp;
  awaitingStamp = false;
}

/**
 * Whether a list fetched at `dataUpdatedAt` may predate an account switch.
 *
 * Asked of every cached list, invalidated or not: a hidden tab's stream is
 * released and reopened without anything being invalidated, so the switch it
 * missed shows up here and nowhere else.
 *
 * @param dataUpdatedAt - When the cached list was written, on this window's
 *   clock (TanStack's `dataUpdatedAt`).
 */
export function predatesSessionListReset(dataUpdatedAt: number): boolean {
  // While the stream is down, a list fetched since the drop is the server as it
  // is now; only one from before the drop could hide a switch the stream missed.
  return (awaitingStamp && dataUpdatedAt <= downAt) || dataUpdatedAt <= lastResetAt;
}

/**
 * Forget everything, back to a fresh window.
 *
 * @internal Test-only.
 */
export function resetSessionListResetMarker(): void {
  lastResetAt = 0;
  lastStamp = undefined;
  awaitingStamp = false;
  downAt = 0;
}
