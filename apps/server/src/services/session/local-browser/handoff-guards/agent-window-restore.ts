/**
 * Putting the agent's own Agent browser window back after a sign-in the person started from a
 * refused page (DOR-4693), and reading whether the selected tab is on a site DorkOS saw refuse.
 * The handover decides WHETHER to reopen; this does the reopening.
 *
 * @module services/session/local-browser/handoff-guards/agent-window-restore
 */
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import { LocalBrowserError } from '../errors.js';
import type { HandoverBrowser } from '../handover.js';

/** The agent's window a refusal's sign-in closed: its chat, profile, and the page DorkOS read. */
export interface AgentWindowRestore {
  sessionId: string;
  profileId: string | null;
  url: string;
}

/**
 * Reopen the agent's own window, unless the browser was opened again meanwhile: the person's
 * newer choice stands. Never throws; a failed reopen is logged and leaves the browser closed.
 *
 * @param browser - The browser the handover steers.
 * @param restore - What to reopen, as DorkOS recorded it when it closed the window.
 */
export function reopenAgentWindow(
  browser: Pick<HandoverBrowser, 'state' | 'open'>,
  restore: AgentWindowRestore
): void {
  void (async () => {
    if ((await browser.state()).status !== 'disconnected') return;
    await browser.open({
      mode: 'new-window',
      sessionId: restore.sessionId,
      ...(restore.profileId ? { profileId: restore.profileId } : {}),
      url: restore.url,
    });
  })().catch((error: unknown) =>
    logger.warn('[Browser] Could not reopen the agent’s window after a sign-in', {
      sessionId: restore.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

/**
 * What to reopen for the chat holding the browser: its selected tab as DorkOS read it, never an
 * address a page supplies. `undefined` when no chat holds it or no tab is selected.
 *
 * @param state - The browser's state, read by DorkOS before it closes the window.
 * @param profileId - The profile the window was on.
 */
export function agentWindowAt(
  state: LocalBrowserState,
  profileId: string | null
): AgentWindowRestore | undefined {
  const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
  return state.sessionId && tab
    ? { sessionId: state.sessionId, profileId, url: tab.url }
    : undefined;
}

/** The person's own sign-in or handoff holds the agent's window, so DorkOS won't close it. */
export function browserInUseRefusal(): LocalBrowserError {
  return new LocalBrowserError(
    'browser_in_use',
    'You already have a sign-in window open. Finish or close it first.'
  );
}

/**
 * Whether the selected tab's site is the one DorkOS's own last reading found refusing the browser.
 *
 * @param browser - The browser the handover steers.
 * @param refusedHost - The host of the last refused reading, or null for none.
 */
export async function selectedTabRefused(
  browser: Pick<HandoverBrowser, 'state'>,
  refusedHost: string | null
): Promise<boolean> {
  if (refusedHost === null) return false;
  const state = await browser.state();
  const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
  if (!tab) return false;
  try {
    return new URL(tab.url).host === refusedHost;
  } catch {
    return false;
  }
}
