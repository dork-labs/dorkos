/** Closed private registry failures; database and native detail never escapes. */
export class BrowserRegistryError extends Error {
  /** Fixed reason suitable for the existing shared browser error projection. */
  readonly reason:
    'inaccessible' | 'profileInUse' | 'profileUncertain' | 'staleBinding' | 'stopped';

  /** Preserve the closed reason without echoing caller or native data. */
  constructor(reason: BrowserRegistryError['reason']) {
    super(reason);
    this.name = 'BrowserRegistryError';
    this.reason = reason;
  }
}
