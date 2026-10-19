import type { CommunityWireEmailLinkPeek } from '@dorkos/shared/community-wire';
import { hostRequest } from '../api.js';
import { readStorage, writeStorage } from '../remembered-community.js';

declare global {
  interface Window {
    __readDorkosEmailLinkFragment?: () => string | null;
    __clearDorkosEmailLinkFragment?: () => void;
  }
}

/**
 * Read the token the page's inline bootstrap took from a mailed link's `#` fragment, if any. The
 * bootstrap has already erased it from the address bar, so it lives only in page memory.
 */
export function readEmailLinkFragment(): string | null {
  return window.__readDorkosEmailLinkFragment?.() ?? null;
}

/** Erase the captured token from page memory once the page has used it or given up on it. */
export function clearEmailLinkFragment(): void {
  window.__clearDorkosEmailLinkFragment?.();
}

/** Look at a mailed link before using it; nothing is used up. */
export function peekEmailLink(token: string): Promise<CommunityWireEmailLinkPeek> {
  return hostRequest<CommunityWireEmailLinkPeek>('/api/v1/email-links/peek', 'POST', { token });
}

/**
 * One line per thing a link ends, by the key the server sends. The server's list is open: a key
 * this page does not know yet still shows, as a plain fallback, rather than vanishing.
 */
const CLEAR_LINES: Record<string, string> = {
  sessions: 'Sign-ins on every device',
  connections: 'DorkOS connections',
  agent_credentials: 'Agent keys',
  pairings: 'Pairings in progress',
  invites: 'Invitation links you made',
  host_api_keys: 'Server API keys you made',
  password: 'The old password',
  sign_in_links: 'Google, GitHub and single sign-on sign-ins',
};

/** The line a page shows for one key of `clears`. */
export function clearLine(key: string): string {
  return CLEAR_LINES[key] ?? 'Other ways in';
}

const BANNER_KEY = 'communityConfirmEmailBannerHiddenUntil';
const HIDE_FOR_MS = 30 * 24 * 60 * 60_000;

/** Whether this browser hid the confirm-email banner for this account, and not long ago. */
export function confirmBannerHidden(
  accountId: string,
  now = Date.now(),
  storage: () => Storage = () => localStorage
): boolean {
  const until = Number(readStorage(storage, `${BANNER_KEY}:${accountId}`));
  return Number.isFinite(until) && until > now;
}

/** Hide the confirm-email banner for this account in this browser, for 30 days. */
export function hideConfirmBanner(
  accountId: string,
  now = Date.now(),
  storage: () => Storage = () => localStorage
): void {
  writeStorage(storage, `${BANNER_KEY}:${accountId}`, String(now + HIDE_FOR_MS));
}
