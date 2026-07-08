/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { hasRenderConsent, grantRenderConsent } from '../model/render-consent';

describe('MCP App render consent (per server)', () => {
  beforeEach(() => localStorage.clear());

  it('starts un-consented for a fresh server', () => {
    expect(hasRenderConsent('fixture-app')).toBe(false);
  });

  it('remembers consent per server after granting', () => {
    grantRenderConsent('fixture-app');
    expect(hasRenderConsent('fixture-app')).toBe(true);
    // Consent is server-scoped — a different server still asks.
    expect(hasRenderConsent('other-app')).toBe(false);
  });
});
