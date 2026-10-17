/** Internal distinct Relay source/preparation; Room capsules never stand in for these. */
export interface OriginalFrozenRelayDocumentSource {
  readonly kind: 'original-frozen-relay-document-source';
}
export interface PreparedRelayDocumentResponder {
  readonly kind: 'prepared-relay-document-responder';
}
