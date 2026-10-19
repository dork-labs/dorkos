/**
 * The lock identity an extension's message is sent under: `extension:<extension id>`. It is how a
 * queue row says an extension sent it, which the dispatcher reads when the row launches: an
 * extension's row carries the outsider mark and is held to the runtime's default level even after a
 * restart, when no in-memory plan carries its ceiling (DOR-3036).
 *
 * Leaf module: the dispatcher imports it, so it imports nothing of ours.
 *
 * @module services/extensions/agent-send/extension-client-id
 */

/** The prefix of every extension lock identity. */
export const EXTENSION_CLIENT_PREFIX = 'extension:';

/**
 * The lock identity for the messages one extension sends.
 *
 * @param extensionId - The extension's id.
 */
export function extensionClientId(extensionId: string): string {
  return `${EXTENSION_CLIENT_PREFIX}${extensionId}`;
}

/**
 * Whether a lock identity (a queue row's `enqueuedBy`) is an extension's.
 *
 * @param clientId - The identity.
 */
export function isExtensionClientId(clientId: string): boolean {
  return clientId.startsWith(EXTENSION_CLIENT_PREFIX);
}
