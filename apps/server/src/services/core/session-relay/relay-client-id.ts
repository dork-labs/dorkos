/**
 * The lock identity a relayed message is sent under: `relay:<connection id>`.
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
