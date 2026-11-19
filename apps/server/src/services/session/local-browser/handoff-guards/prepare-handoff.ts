import type { HandoverBrowser } from '../handover.js';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from '../errors.js';
import { outsideTurnRefusal, type OutsideTurnReason } from './outside-turn-reason.js';

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

/** A sign-in page must use https, or http on this computer only. */
export function assertSignInUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  return url;
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
