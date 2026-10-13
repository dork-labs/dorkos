/**
 * When this server last declared every session list wrong.
 *
 * A Claude account switch changes which transcript stores the server reads, so
 * every list a window cached before it can name chats from the account that is
 * no longer signed in. The switch says so live with `session_list_invalidated`,
 * but the global stream does not replay: a window whose stream was down at that
 * moment (a hidden tab releases it) never hears it. The time is therefore also
 * stated in every `connected` frame, so a window that reconnects can tell
 * whether its lists predate a switch it missed (DOR-2891).
 *
 * Kept in memory only. A restart forgets it, and a window reconnecting to a
 * restarted server keeps the trust it had, which is the state before this
 * existed.
 *
 * @module services/session/catalog/session-list-reset
 */

let resetAt: string | null = null;

/** Record that every session list was just declared wrong, and return when. */
export function markSessionListsReset(): string {
  resetAt = new Date().toISOString();
  return resetAt;
}

/**
 * The `connected` frame's payload: when the stream opened, and when the
 * session lists were last declared wrong (omitted when never).
 */
export function connectedFramePayload(): { connectedAt: string; sessionListsResetAt?: string } {
  return {
    connectedAt: new Date().toISOString(),
    ...(resetAt !== null && { sessionListsResetAt: resetAt }),
  };
}

/**
 * Forget the last reset.
 *
 * @internal Test-only.
 */
export function resetSessionListResetForTests(): void {
  resetAt = null;
}
