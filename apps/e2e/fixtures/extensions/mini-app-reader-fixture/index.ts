// mini-app-reader-fixture: the browser-test stand-in for a mini app that
// reads a connected app (apps/e2e/tests/connections/mini-app-access.ts,
// DOR-3547). Its page half only marks the window it runs in, so the test can
// prove the decide page is one window it never reaches.

/**
 * Mark the window: the app page has this, the decide page must not.
 *
 * @param _api - The host API handed to every extension.
 */
export function activate(_api: unknown): void {
  (globalThis as { __miniAppReaderFixture?: string }).__miniAppReaderFixture = 'loaded';
}
