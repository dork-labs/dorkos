/** Trusted profile and presentation admission before replacing an existing browser. */
import type { LocalBrowserCapabilities, LocalBrowserOpen } from '@dorkos/shared/local-browser';
import { LocalBrowserError, assertLocalBrowserUrl } from '../errors.js';
import { assertOpenable } from '../open-input.js';
import type { BrowserProfileAccessGate } from '../profile-access.js';

/** Resolve the profile before any existing browser is closed. */
export async function prepareBrowserOpen(
  input: LocalBrowserOpen,
  authorization: Pick<BrowserProfileAccessGate, 'select' | 'exists'>,
  host: {
    embedded: boolean;
    capabilities: LocalBrowserCapabilities;
    signInHoldsProfile(id: string | null): boolean;
  }
) {
  const profile = await authorization.select?.(input);
  if (input.sessionId && !profile)
    throw new LocalBrowserError(
      'profile_not_allowed',
      'This agent can’t use this browser profile.'
    );
  input = {
    ...input,
    ...(input.sessionId ? { mode: 'new-window' } : {}),
    ...(profile ? { profileId: profile.id === 'default' ? undefined : profile.id } : {}),
  };
  assertOpenable(input, host.embedded, host.capabilities, authorization.exists);
  if (input.url) assertLocalBrowserUrl(input.url, 'person');
  if (host.signInHoldsProfile(input.profileId ?? null))
    throw new LocalBrowserError('signing_in', 'Close the sign-in window first.');
  return { input, profile };
}
