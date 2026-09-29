import { describe, it, expect } from 'vitest';
import type { ConnectorCustody } from '@dorkos/shared/connector-provider';
import { MANAGED_CUSTODY_CANONICAL_SENTENCE, custodyDisclosure } from '../custody-disclosure.js';

describe('custody-disclosure', () => {
  describe('copy-drift guard (the ADR sentence must never silently change)', () => {
    it('pins the canonical managed sentence byte-verbatim from ADR 260718-045630', () => {
      // If this string is ever edited, the change is deliberate and must be
      // reflected in the ADR §Custody disclosure — this assertion is the tripwire.
      expect(MANAGED_CUSTODY_CANONICAL_SENTENCE).toBe(
        "Composio stores your connected accounts' login access in its own secure vault, not on your computer."
      );
    });

    it('managed disclosure contains the canonical ADR sentence verbatim', () => {
      const copy = custodyDisclosure('managed');
      expect(copy).toContain(MANAGED_CUSTODY_CANONICAL_SENTENCE);
    });
  });

  describe('per-class copy', () => {
    it('managed discloses custody and explicit agent choice without an auth-method promise', () => {
      const copy = custodyDisclosure('managed');
      expect(copy).toContain('Choose which agents can use this account.');
      expect(copy).not.toContain('password');
      expect(copy).not.toContain('Connecting');
      expect(copy).toContain('not on your computer');
      expect(copy).toContain('disconnect anytime');
    });

    it('self-host says where sign-ins live, and never that nothing leaves', () => {
      const copy = custodyDisclosure('self-host');
      expect(copy).toBe(
        "You're connecting through your own Nango server. Its sign-ins are stored in your own " +
          'database, on computers you control, not with DorkOS.'
      );
      // Actions still go out to the app itself, so the old promise was false.
      expect(copy).not.toContain('leaves your systems');
    });

    it('external distinguishes configured server access from tool login custody, naming no raw type', () => {
      expect(custodyDisclosure('external')).toBe(
        "This app's tools connect straight to its own server. DorkOS uses the connection details " +
          'you set up to check that server before adding it. Any sign-in its tools need stays with ' +
          'that server.'
      );
    });

    it('every class returns a non-empty line', () => {
      for (const custody of ['managed', 'self-host', 'external'] as ConnectorCustody[]) {
        expect(custodyDisclosure(custody).length).toBeGreaterThan(0);
      }
    });
  });

  describe('structural rule: no row renders without a disclosure line', () => {
    it('an unknown/absent custody class throws rather than rendering blank', () => {
      expect(() => custodyDisclosure('vendor-cloud' as unknown as ConnectorCustody)).toThrow(
        /no custody disclosure/
      );
    });
  });
});
