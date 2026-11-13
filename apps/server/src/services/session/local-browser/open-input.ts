/** What a browser open may ask for. */
import type { LocalBrowserCapabilities } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from './errors.js';

/**
 * Refuse a browser that can't be opened the way it was asked for.
 *
 * @param input - What was asked for.
 * @param hasEmbedded - Whether this is the desktop app, which has the built-in browser.
 * @param capabilities - What this computer can open.
 * @param profileExists - Whether a named profile exists, once startup has wired that.
 */
export function assertOpenable(
  input: { mode: string; profileId?: string },
  hasEmbedded: boolean,
  capabilities: LocalBrowserCapabilities,
  profileExists?: (id: string) => boolean
): void {
  if (input.mode !== 'embedded' && input.mode !== 'new-window')
    throw new LocalBrowserError(
      'unsupported',
      'Choose where the Agent browser opens: in DorkOS or in its own window.'
    );
  if (input.mode === 'embedded' && !hasEmbedded)
    throw new LocalBrowserError(
      'unsupported',
      'Opening the Agent browser in DorkOS needs the desktop app.'
    );
  if (input.mode === 'embedded' && input.profileId)
    throw new LocalBrowserError('unsupported', 'Open a browser profile in its own window.');
  if (input.profileId && !profileExists?.(input.profileId))
    throw new LocalBrowserError('profile_not_found', 'That browser profile no longer exists.');
  if (input.mode === 'new-window' && !capabilities.newWindow)
    throw new LocalBrowserError('unsupported', capabilities.unavailableReasons['new-window']!);
}
