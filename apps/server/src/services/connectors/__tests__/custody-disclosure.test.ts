import { describe, it, expect } from 'vitest';
import type { ConnectorCustody } from '@dorkos/shared/connector-provider';
import {
  MANAGED_CUSTODY_CANONICAL_SENTENCE,
  custodyDisclosure,
  disclosureForAccount,
} from '../custody-disclosure.js';

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
      const copy = custodyDisclosure('managed', { service: 'Gmail' });
      expect(copy).toContain(MANAGED_CUSTODY_CANONICAL_SENTENCE);
    });
  });

  describe('per-class copy', () => {
    it('managed names the service and discloses the vendor vault', () => {
      const copy = custodyDisclosure('managed', { service: 'Gmail' });
      expect(copy).toContain('Connecting Gmail');
      expect(copy).toContain('not on your computer');
      expect(copy).toContain('disconnect anytime');
    });

    it('self-host discloses the operator-controlled infrastructure', () => {
      const copy = custodyDisclosure('self-host', { service: 'Slack' });
      expect(copy).toContain('stored in your database, on infrastructure you control');
      expect(copy).toContain('leaves your systems');
    });

    it('external interpolates the server name and disclaims key custody', () => {
      const copy = custodyDisclosure('external', { service: 'Notion' });
      expect(copy).toContain('connects straight to Notion');
      expect(copy).toContain("DorkOS doesn't store or see its keys");
      expect(copy).toContain('manages its own sign-in');
    });

    it('every class returns a non-empty line', () => {
      for (const custody of ['managed', 'self-host', 'external'] as ConnectorCustody[]) {
        expect(custodyDisclosure(custody, { service: 'X' }).length).toBeGreaterThan(0);
      }
    });
  });

  describe('structural rule: no row renders without a disclosure line', () => {
    it('derives a disclosure line for an account, preferring its label as the service name', () => {
      const line = disclosureForAccount({
        custody: 'external',
        toolkit: 'notion',
        label: 'Notion Workspace',
      });
      expect(line).toContain('Notion Workspace');
    });

    it('falls back to the toolkit slug when an account has no label', () => {
      const line = disclosureForAccount({ custody: 'external', toolkit: 'notion', label: '' });
      expect(line).toContain('notion');
    });

    it('an unknown/absent custody class throws rather than rendering blank', () => {
      expect(() =>
        custodyDisclosure('vendor-cloud' as unknown as ConnectorCustody, { service: 'X' })
      ).toThrow(/no custody disclosure/);
    });
  });
});
