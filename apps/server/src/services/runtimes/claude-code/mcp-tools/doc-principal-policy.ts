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
