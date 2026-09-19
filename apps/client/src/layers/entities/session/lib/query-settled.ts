/**
 * Whether a TanStack query has stopped having anything more to say.
 *
 * ## The trap this exists for (DOR-2103)
 *
 * "Is an answer still coming?" reads like `isPending`, and it is not.
 * `isPending` means "there is no data", which stays TRUE forever in two states
 * where nothing is on its way:
 *
 * - **The query failed.** `status` moves to `'error'`, so `isPending` does go
 *   false there — that one is fine, and it is the reason this cannot simply be
 *   `isSuccess`.
 * - **The query is DISABLED.** `enabled: false` leaves `status: 'pending'` with
 *   `fetchStatus: 'idle'` for the lifetime of the component. Nobody asked, so
 *   nobody is waiting, but `isPending` says otherwise.
 *
 * A surface that draws a spinner off `isPending` alone therefore spins forever
 * on a disabled query. That is exactly how the trust dial came to pulse with no
 * session selected and after a failed read: the "still loading" state had no
 * terminal branch, so a control that could not be answered looked like one that
 * was about to be.
 *
 * @module entities/session/lib/query-settled
 */

/** The two fields {@link isQuerySettled} reads off a `useQuery` result. */
export interface QuerySettledState {
  /** TanStack's `isPending` — "there is no data yet", including when disabled. */
  isPending: boolean;
  /** TanStack's `fetchStatus` — `'idle'` when nothing is in flight. */
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

/**
 * True when this query will not produce an answer without something else
 * changing: it succeeded, it failed, or it was never asked.
 *
 * The honest input to "should I still show a loading state?". A caller that
 * wants "did it work" should ask `isSuccess` instead — settled says only that
 * waiting longer is pointless.
 *
 * @param query - A `useQuery` result, or the two fields off one.
 */
export function isQuerySettled(query: QuerySettledState): boolean {
  return !query.isPending || query.fetchStatus === 'idle';
}
