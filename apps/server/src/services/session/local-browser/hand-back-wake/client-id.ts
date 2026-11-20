/**
 * The client id the hand-back wake is sent under, on its own so the dispatcher can tell the wake
 * from a person's own send without importing the wake, which imports the dispatcher.
 *
 * @module services/session/local-browser/hand-back-wake/client-id
 */

/** The client id the wake is sent under, so it never takes a person's tab's write lock. */
export const HAND_BACK_CLIENT_ID = 'local-browser-hand-back';
