/** An opaque id cannot choose between two independently owned native sessions. */
export class AmbiguousSessionError extends Error {
  readonly code = 'SESSION_ID_AMBIGUOUS';
  constructor() {
    super('This session ID matches multiple conversations.');
    this.name = 'AmbiguousSessionError';
  }
}

/** Native storage failed; an absent session and an unreadable store are different outcomes. */
export class SessionDiscoveryUnavailableError extends Error {
  readonly code = 'SESSION_DISCOVERY_UNAVAILABLE';
  constructor(readonly runtime: string) {
    super('Session history is temporarily unavailable. Try again.');
    this.name = 'SessionDiscoveryUnavailableError';
  }
}
