import type { BrowserBinding } from '../contracts.js';

/** Compare every lifetime/control field; actor authority is separately revalidated by the server port. */
export function sameBinding(a: BrowserBinding | null, b: BrowserBinding): boolean {
  return (
    a !== null &&
    a.browserId === b.browserId &&
    a.browserGeneration === b.browserGeneration &&
    a.tabId === b.tabId &&
    a.navigationGeneration === b.navigationGeneration &&
    a.viewportVersion === b.viewportVersion &&
    a.epoch === b.epoch &&
    a.inputGeneration === b.inputGeneration
  );
}
