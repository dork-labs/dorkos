/**
 * Shared test double for the auth client — a fully-stubbed {@link AuthClient} with
 * `vi.fn()` methods returning Better Auth-style `{ data, error }` envelopes. Not a
 * test file (no `.test.` suffix), so vitest never collects it.
 *
 * @module features/auth/__tests__/fake-auth-client
 */
import { vi } from 'vitest';
import type { AuthClient } from '../model/auth-client';

/** Build a fake {@link AuthClient}; override any leaf method per test. */
export function createFakeAuthClient(overrides?: {
  signInEmail?: AuthClient['signIn']['email'];
  signUpEmail?: AuthClient['signUp']['email'];
  getSession?: AuthClient['getSession'];
  apiKeyCreate?: AuthClient['apiKey']['create'];
  apiKeyList?: AuthClient['apiKey']['list'];
  apiKeyDelete?: AuthClient['apiKey']['delete'];
  signOut?: AuthClient['signOut'];
}): AuthClient {
  return {
    signIn: {
      email: overrides?.signInEmail ?? vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    signUp: {
      email:
        overrides?.signUpEmail ??
        vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
    },
    signOut:
      overrides?.signOut ?? vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    getSession: overrides?.getSession ?? vi.fn().mockResolvedValue({ data: null, error: null }),
    apiKey: {
      create: overrides?.apiKeyCreate ?? vi.fn().mockResolvedValue({ data: null, error: null }),
      list: overrides?.apiKeyList ?? vi.fn().mockResolvedValue({ data: [], error: null }),
      delete:
        overrides?.apiKeyDelete ??
        vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    },
  };
}
