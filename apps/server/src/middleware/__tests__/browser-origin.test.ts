/**
 * `resolveBrowserOriginFacts` must read the same origin facts off a request
 * whichever chain built it (DOR-2794). The policy it feeds is tested as a pure
 * predicate in `lib/__tests__/trusted-origins-browser.test.ts`, and through a
 * real Express app in `mcp-origin.test.ts`; this pins the reader between them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import { REQUEST_FACTS_ADAPTERS } from '../../http/__tests__/request-facts-adapters.js';
import { resolveBrowserOriginFacts } from '../browser-origin.js';

describe.each(REQUEST_FACTS_ADAPTERS)(
  'resolveBrowserOriginFacts, through the $name adapter',
  (adapter) => {
    it('reads the raw Origin and Host, and allows a loopback host', async () => {
      const facts = resolveBrowserOriginFacts(
        await adapter.facts({
          headers: { Origin: 'http://localhost:4242', Host: 'localhost:4242' },
        }),
        { hostCheckInert: false }
      );
      expect(facts).toMatchObject({
        origin: 'http://localhost:4242',
        hostHeader: 'localhost:4242',
        hostAllowed: true,
        connectionEncrypted: false,
        hostCheckInert: false,
      });
    });

    it('refuses a rebound host, and never trusts X-Forwarded-Host for it', async () => {
      const facts = resolveBrowserOriginFacts(
        await adapter.facts({
          headers: { Host: 'evil.example', 'X-Forwarded-Host': 'localhost' },
        }),
        { hostCheckInert: false }
      );
      expect(facts.hostHeader).toBe('evil.example');
      expect(facts.hostAllowed).toBe(false);
    });

    it('takes the scheme from X-Forwarded-Proto and TLS from the socket', async () => {
      const facts = resolveBrowserOriginFacts(
        await adapter.facts({
          headers: { Host: 'localhost', 'X-Forwarded-Proto': 'https' },
          encrypted: true,
        }),
        { hostCheckInert: true }
      );
      expect(facts.forwardedProto).toBe('https');
      expect(facts.connectionEncrypted).toBe(true);
      expect(facts.hostCheckInert).toBe(true);
    });
  }
);
