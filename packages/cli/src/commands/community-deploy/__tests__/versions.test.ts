import { describe, expect, it } from 'vitest';
import { ProviderCommandError } from '../provider-process.js';
import {
  classifyCommunityProviderPreflightFailure,
  CommunityCliVersionError,
  CommunityProviderPreflightError,
} from '../runtime/versions.js';

describe('Community provider preflight guidance', () => {
  it('maps a missing executable to its official installation path', () => {
    expect(() =>
      classifyCommunityProviderPreflightFailure('fly', new ProviderCommandError('SPAWN'))
    ).toThrowError(new CommunityProviderPreflightError('fly', 'CLI_NOT_FOUND'));
    expect(() =>
      classifyCommunityProviderPreflightFailure('neon', new ProviderCommandError('SPAWN'))
    ).toThrow('https://neon.com/docs/reference/neon-cli');
  });

  it('keeps ambiguous command exits unavailable instead of claiming authentication failed', () => {
    expect(() =>
      classifyCommunityProviderPreflightFailure('fly', new ProviderCommandError('EXIT'))
    ).toThrowError(new CommunityProviderPreflightError('fly', 'PROVIDER_UNAVAILABLE'));
    expect(() =>
      classifyCommunityProviderPreflightFailure('neon', new ProviderCommandError('EXIT'))
    ).toThrow('Check provider status, CLI compatibility, and sign-in with neonctl auth');
  });

  it('links old-version failures to the official update instructions', () => {
    expect(new CommunityCliVersionError('fly').message).toContain(
      'https://fly.io/docs/flyctl/install/'
    );
    expect(new CommunityCliVersionError('neonctl').message).toContain(
      'https://neon.com/docs/reference/neon-cli'
    );
  });
});
