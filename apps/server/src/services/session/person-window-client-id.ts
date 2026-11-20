/**
 * Recognize web-window queue owners. The prefix classifies rows; it does not authenticate callers.
 *
 * @param clientId - The client identity stored with a queued message
 */
export function isPersonWindowClientId(clientId: string): boolean {
  return clientId.startsWith('web-');
}
