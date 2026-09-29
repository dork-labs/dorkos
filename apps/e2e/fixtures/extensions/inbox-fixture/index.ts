// inbox-fixture: the browser-test stand-in for an extension that asks a
// person things in the Activity inbox (apps/e2e/tests/extensions/
// inbox-decisions.spec.ts, DOR-2523). Its page half draws nothing; the
// server half (server.ts) does the asking.

/**
 * Nothing to register in the page.
 *
 * @param _api - The host API handed to every extension.
 */
export function activate(_api: unknown): void {}
