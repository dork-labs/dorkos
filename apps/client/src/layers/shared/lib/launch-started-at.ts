/**
 * When this app load began, sampled once at module evaluation — which happens
 * during initial bundle load, before any request goes out.
 *
 * **It exists because a cached answer and a confirmed one are indistinguishable
 * otherwise.** The boot cache (`query-persister.ts`) restores `/api/config`,
 * the room list, the agent roster and the session list from `localStorage`,
 * up to 24 hours old, so the first frame can be a finished panel instead of a
 * second of bones. A restored entry carries the `dataUpdatedAt` from when it was
 * ORIGINALLY fetched — always older than this — while an answer produced this
 * session is always newer. So `dataUpdatedAt > LAUNCH_STARTED_AT` tells "the
 * server said so just now" apart from "the browser remembered this from
 * yesterday", and it does so without depending on when the asking component
 * happens to mount (which is what `isFetchedAfterMount` would depend on).
 *
 * A query that has never resolved reports `dataUpdatedAt: 0`, safely before it.
 *
 * @module shared/lib/launch-started-at
 */
export const LAUNCH_STARTED_AT = Date.now();
