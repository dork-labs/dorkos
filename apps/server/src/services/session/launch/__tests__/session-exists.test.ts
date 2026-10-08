import { describe, it, expect, vi } from 'vitest';
import { SessionDiscoveryUnavailableError } from '../../resolution/session-lookup-error.js';
vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getNativeSessionCwd: vi.fn(() => null),
    resolveForSessionWithOwnership: vi.fn(),
  },
  RuntimeNotRegisteredError: class extends Error {},
}));
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { sessionExists } from '../session-exists.js';
describe('sessionExists', () => {
  it('preserves unavailable storage instead of treating an existing link as missing', async () => {
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockRejectedValue(
      new SessionDiscoveryUnavailableError('codex')
    );
    await expect(sessionExists('existing')).rejects.toMatchObject({
      code: 'SESSION_DISCOVERY_UNAVAILABLE',
    });
  });
});
