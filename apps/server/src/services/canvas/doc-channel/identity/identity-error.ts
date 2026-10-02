/** Admission refuses incomplete moves instead of treating an alias as authority. */
export class DocChannelIdentityBlockedError extends Error {
  readonly code = 'DOC_CHANNEL_IDENTITY_BLOCKED';
  /** Build a safe, payload-free ownership refusal. */
  constructor() {
    super('The document ownership move needs recovery.');
  }
}
