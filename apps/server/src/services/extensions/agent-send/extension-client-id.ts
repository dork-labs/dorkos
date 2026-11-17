/**
 * The lock identity an extension's message is sent under: `extension:<extension id>`. It is how a
 * queue row says an extension sent it, which the dispatcher reads when the row launches: an
 * extension's row carries the outsider mark, even after a restart when no in-memory plan carries
 * it (DOR-4594). It keeps its level (DOR-3440); the mark holds sends, deletes and raises.
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
 * Whether a lock identity is an extension's: a message a mini app sent (`ctx.agent.send`) or a chat
 * it started.
 *
 * @param clientId - The lock identity a queue row or a dispatch carries.
 */
export function isExtensionClientId(clientId: string): boolean {
  return clientId.startsWith(EXTENSION_CLIENT_PREFIX);
}
