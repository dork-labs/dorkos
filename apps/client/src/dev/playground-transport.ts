import type { Transport } from '@dorkos/shared/transport';

/**
 * Proxy-based mock Transport for the dev playground.
 *
 * Every method returns a sensible empty-ish default. Unlike `createMockTransport`
 * from test-utils, this has no dependency on `vi.fn()` and works at runtime.
 */
export function createPlaygroundTransport(): Transport {
  return new Proxy({} as Transport, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      // Return a no-op async function that resolves with a plausible shape
      return async () => ({
        ok: true,
        messages: [],
        tasks: [],
        agents: [],
        conversations: [],
        success: true,
      });
    },
  });
}
