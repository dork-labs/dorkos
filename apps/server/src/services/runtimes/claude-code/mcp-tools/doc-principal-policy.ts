/** Existing Doc handlers require live runtime authority, independent of the connector allowlist. */
const DOCUMENT_PRINCIPAL_IDS = new Set([
  'ui.configure_doc_channel',
  'ui.approve_doc_route',
  'ui.revoke_doc_route',
  'ui.patch_canvas_state',
  'ui.send_canvas_event',
]);

/** Exact document tools; identity projection grants no route or operator permission. */
export function requiresDocPrincipal(capabilityId: string): boolean {
  return DOCUMENT_PRINCIPAL_IDS.has(capabilityId);
}

/**
 * Whether a capability takes the turn's verified principal when it can be had,
 * and runs without it when it cannot.
 *
 * Only `control_ui`: a session canvas document it opens records this agent as
 * its opener from that principal, which `configure_doc_channel` then requires.
 * Optional because the same tool also drives toasts, panels and the theme, and
 * a turn whose principal cannot be resolved must keep all of those; it opens
 * the document with no opener instead. The principal is never taken from the
 * tool's arguments.
 *
 * @param capabilityId - The capability being invoked.
 * @returns `true` when the principal should be resolved, failure tolerated.
 */
export function bindsOpenerWhenAvailable(capabilityId: string): boolean {
  return capabilityId === 'ui.control';
}
