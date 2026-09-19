/**
 * Whether a TanStack query has stopped having anything more to say.
 *
 * ## The trap this exists for (DOR-2103)
 *
 * "Is an answer still coming?" reads like `isPending`, and it is not.
 * `isPending` means "there is no data", which stays TRUE forever in three
 * states where nothing is on its way:
 *
 * - **The query failed.** `status` moves to `'error'`, so `isPending` does go
 *   false there — that one is fine, and it is the reason this cannot simply be
 *   `isSuccess`.
 * - **The query is DISABLED.** `enabled: false` leaves `status: 'pending'` with
 *   `fetchStatus: 'idle'` for the lifetime of the component. Nobody asked, so
 *   nobody is waiting, but `isPending` says otherwise.
 * - **The query is PAUSED.** `fetchStatus: 'paused'`, which TanStack's default
 *   `networkMode: 'online'` enters whenever `navigator.onLine` is false.
 *
 * A surface that draws a spinner off `isPending` alone therefore spins forever
 * on a disabled query. That is exactly how the trust dial came to pulse with no
 * session selected and after a failed read: the "still loading" state had no
 * terminal branch, so a control that could not be answered looked like one that
 * was about to be.
 *
 * ## `paused` counts as SETTLED, and that is a decision
 *
 * A paused query resumes only when the BROWSER changes its mind about the
 * network — and this server is not on the internet. Dropped wifi is not a
 * reason to stop asking localhost, which is the ruling `entities/config`'s
 * `useConfig` already made for itself in so many words. So a paused query is
 * not "about to answer": it is waiting on a signal that has nothing to do with
 * whether the answer is reachable, and on a desktop install it may wait
 * forever while the server three inches away is fine.
 *
 * The right fix for a query you OWN is `networkMode: 'always'`, so it never
 * pauses at all; the trust dial's own stored-settings read does exactly that.
 * This branch is for the queries it merely reads — `useSessionDetail`, the
 * session list and `useRuntimeCapabilities` all still take TanStack's default
 * — so that one of them pausing degrades the dial to its best available answer
 * instead of stranding it (DOR-2103 round 3).
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
 * changing: it succeeded, it failed, it was never asked, or it is paused.
 *
 * The honest input to "should I still show a loading state?". A caller that
 * wants "did it work" should ask `isSuccess` instead — settled says only that
 * waiting longer, on its own, is pointless.
 *
 * **It cannot tell you WHY a query was never asked, and the difference
 * matters.** "Disabled because nobody will ever ask" (no session is selected)
 * and "disabled until a prerequisite lands" (the working directory is still
 * resolving) are the same `fetchStatus: 'idle'` here, and reading the second
 * as settled is how the dial came to paint a confident `'default'` during boot
 * and then flip when the directory arrived — the reported defect, compressed
 * into the pre-directory round trip (DOR-2103 round 3). Only the caller knows
 * which prerequisite it is waiting on, so the caller checks for it BEFORE
 * asking this.
 *
 * @param query - A `useQuery` result, or the two fields off one.
 */
export function isQuerySettled(query: QuerySettledState): boolean {
  return !query.isPending || query.fetchStatus === 'idle' || query.fetchStatus === 'paused';
}
