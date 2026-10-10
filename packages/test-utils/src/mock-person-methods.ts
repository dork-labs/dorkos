/**
 * Mock Transport methods for the person's own setup: their profile and the
 * first run. Each resolves with what the real route answers, so a component
 * under test takes its success path unless a test deliberately makes one
 * reject.
 *
 * @module test-utils/mock-person-methods
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The operator's own profile (spec `identity-consistency` §W3.3, §W3.5). */
export function mockProfileMethods(): Pick<
  Transport,
  'updateProfile' | 'uploadProfileAvatar' | 'deleteProfileAvatar'
> {
  return {
    updateProfile: vi
      .fn()
      .mockImplementation((displayName: string) => Promise.resolve({ displayName })),
    uploadProfileAvatar: vi
      .fn()
      .mockResolvedValue({ imageUrl: '/api/profile/avatar/person-1?v=abc' }),
    deleteProfileAvatar: vi.fn().mockResolvedValue(undefined),
  };
}

/** The first run (spec `one-minute-onboarding` §4): the path, and DorkBot's welcome. */
export function mockOnboardingMethods(): Pick<
  Transport,
  'chooseFirstRunPath' | 'postOnboardingWelcome'
> {
  return {
    chooseFirstRunPath: vi.fn().mockResolvedValue({ path: 'none', runtime: 'claude-code' }),
    postOnboardingWelcome: vi
      .fn()
      .mockResolvedValue({ roomId: 'room-team', entryId: 'entry-welcome' }),
  };
}
