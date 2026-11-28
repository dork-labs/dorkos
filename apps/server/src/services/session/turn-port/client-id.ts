/**
 * The lock identity a run the turn port starts runs under: `turn-port:<runId>`
 * (a mini app's keeps the extension prefix instead). On its own so the
 * dispatcher can tell such a turn from a person's own send without importing
 * the computer face, which imports the dispatcher.
 *
 * @module services/session/turn-port/client-id
 */

/** The prefix of a turn-port run's lock identity. */
export const TURN_PORT_CLIENT_PREFIX = 'turn-port:';
