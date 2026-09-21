import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CommunityConsentError,
  requireCommunityLaunchConsent,
  requireTigrisTermsAcceptance,
} from '../consent.js';

function terminalStreams(answer: string, isTTY = true) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = isTTY;
  output.isTTY = isTTY;
  input.end(`${answer}\n`);
  return { input, output };
}

describe('Community launch consent', () => {
  it('accepts only the exact generated app name on a terminal', async () => {
    await expect(
      requireCommunityLaunchConsent(
        'dorkos-community-test',
        terminalStreams('dorkos-community-test')
      )
    ).resolves.toBeUndefined();
    await expect(
      requireCommunityLaunchConsent('dorkos-community-test', terminalStreams('yes'))
    ).rejects.toEqual(new CommunityConsentError('CONSENT_MISMATCH'));
  });

  it('rejects redirected input before reading it', async () => {
    await expect(
      requireCommunityLaunchConsent(
        'dorkos-community-test',
        terminalStreams('dorkos-community-test', false)
      )
    ).rejects.toEqual(new CommunityConsentError('INTERACTIVE_TERMINAL_REQUIRED'));
  });

  it('requires a separate exact Tigris terms acknowledgement', async () => {
    await expect(requireTigrisTermsAcceptance(terminalStreams('accept'))).resolves.toBeUndefined();
    await expect(requireTigrisTermsAcceptance(terminalStreams('yes'))).rejects.toEqual(
      new CommunityConsentError('CONSENT_MISMATCH')
    );
  });
});
