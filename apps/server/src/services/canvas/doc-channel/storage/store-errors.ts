/** A mutation addressed a channel that no longer accepts writes. */
export class DocChannelClosedError extends Error {
  readonly code = 'DOC_CHANNEL_CLOSED';
  /** Build a safe channel closure refusal. */
  constructor(readonly documentId: string) {
    super('The document channel is closed or absent.');
    this.name = 'DocChannelClosedError';
  }
}

/** A revision compare-and-set did not match current state. */
export class DocChannelStateConflictError extends Error {
  readonly code = 'DOC_CHANNEL_STATE_CONFLICT';
  /** Build a safe optimistic concurrency refusal. */
  constructor() {
    super('The document state revision changed.');
    this.name = 'DocChannelStateConflictError';
  }
}
