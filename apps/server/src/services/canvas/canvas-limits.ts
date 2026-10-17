/** Fixed shared canvas capacity without service initialization. */
/**
 * How many unpinned documents one canvas holds before the least recently active
 * is dropped to make room.
 *
 * The same number for both scopes, because it is the same surface and a room
 * whose strip behaved differently from a session's would be two rules to learn.
 * Pinned documents are neither counted nor evicted.
 */
export const MAX_CANVAS_DOCUMENTS = 12;
