/**
 * The lock identity a relayed message is sent under: `relay:<connection id>`.
 * It is how a queue row says the session relay sent it, which the dispatcher
 * reads when the row launches: a relayed row is held to the runtime's default
 * level even after a restart, when no in-memory plan carries its ceiling.
 *
 * Leaf module: the dispatcher imports it, so it imports nothing of ours.
 *
 * @module services/core/session-relay/relay-client-id
 */

/** The prefix of every relayed lock identity. */
export const RELAY_CLIENT_PREFIX = 'relay:';

/**
 * The lock identity for the messages one relay connection sends.
 *
 * @param id - A fresh id for the connection.
 */
export function relayClientId(id: string): string {
  return `${RELAY_CLIENT_PREFIX}${id}`;
}

/**
 * Whether a lock identity (a queue row's `enqueuedBy`) is the session relay's.
 *
 * @param clientId - The identity.
 */
export function isRelayClientId(clientId: string): boolean {
  return clientId.startsWith(RELAY_CLIENT_PREFIX);
}
