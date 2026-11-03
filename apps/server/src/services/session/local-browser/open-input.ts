/** What a browser open may ask for. */
import { LocalBrowserError } from './errors.js';

/**
 * Refuse a browser that can't be opened the way it was asked for.
 *
 * @param input - What was asked for.
 * @param hasEmbedded - Whether this is the desktop app, which has the built-in browser.
 * @param profileExists - Whether a named profile exists, once startup has wired that.
 */
export function assertOpenable(
  input: { mode: string; profileId?: string },
  hasEmbedded: boolean,
  profileExists?: (id: string) => boolean
): void {
  if (input.mode === 'embedded' && !hasEmbedded)
    throw new LocalBrowserError('unsupported', 'Use the desktop app for the DorkOS browser.');
  if (input.mode === 'embedded' && input.profileId)
    throw new LocalBrowserError('unsupported', 'Open a browser profile in a new window.');
  if (input.profileId && !profileExists?.(input.profileId))
    throw new LocalBrowserError('profile_not_found', 'That browser profile no longer exists.');
}
