import type { HandoverBrowser } from './handover-browser.js';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from '../errors.js';
import { outsideTurnRefusal, type OutsideTurnReason } from './outside-turn-reason.js';
import { assertSignInUrl } from './page-address.js';
import { selectedTabRefused } from './agent-window-restore.js';

/** Whether DorkOS's own last reading found the selected tab's site refusing the browser. */
export function refusedHere(browser: HandoverBrowser): Promise<boolean> {
  return selectedTabRefused(browser, browser.lastRefusalHost?.() ?? null);
}

/** A page-read exception must still name the same refusal after an admission await. */
export function requireRefusalIdentity(
  browser: HandoverBrowser,
  marked: OutsideTurnReason | null,
  expected?: string | null
): void {
  if (
    marked === 'read_outside_text' &&
    expected !== undefined &&
    (expected === null || expected !== browser.refusalIdentity?.())
  )
    throw outsideTurnRefusal(marked);
}

/** Pause only the connection, selected page and profile admitted before the handoff. */
export function prepareHandoffPage(
  browser: HandoverBrowser,
  state: LocalBrowserState,
  sessionId: string,
  expectedRefusal?: string | null
) {
  requireRefusalIdentity(browser, 'read_outside_text', expectedRefusal);
  const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
  if (state.status !== 'connected' || !tab)
    throw new LocalBrowserError('no_tab', 'Choose the tab your agent should use.');
  if (state.sessionId !== null && state.sessionId !== sessionId)
    throw new LocalBrowserError('shared_elsewhere', 'The browser is shared with another chat.');
  const site = new URL(tab.url).host;
  if (!site) throw new LocalBrowserError('no_site', 'Open the website first, then ask again.');
  if (state.mode === 'new-window') assertSignInUrl(tab.url);
  // Read before pausing clears proof; nothing supplied by the agent marks a refusal.
  const refused = browser.lastRefusalHost?.() === site;
  const profileId = browser.currentProfileId();
  return { tab, site, refused, profileId };
}

/** Recheck the returned pause synchronously, without introducing a new await boundary. */
export function requireHandoffPage(
  browser: HandoverBrowser,
  state: LocalBrowserState,
  handed: LocalBrowserState,
  profileId: string | null
): void {
  const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId)!;
  const handedTab = handed.tabs.find((candidate) => candidate.id === handed.selectedTabId);
  if (
    handed.connectionId !== state.connectionId ||
    handed.selectedTabId !== tab.id ||
    handed.sessionId !== state.sessionId ||
    handedTab?.url !== tab.url ||
    browser.currentProfileId() !== profileId
  )
    throw new LocalBrowserError('site_changed', 'The page changed. Read it again before acting.');
}
