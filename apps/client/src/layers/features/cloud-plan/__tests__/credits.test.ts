/**
 * The panel's two helpers around the shared formatter. Fixtures use the ISO
 * test currency `XTS` and a placeholder scale: the real unit is the service's
 * to serve, and it is never written down in this repository.
 */
import { describe, it, expect } from 'vitest';
import { isReadableDenomination, withCreditUnit } from '../lib/credits';

const PLACEHOLDER = { currency: 'XTS', microPerCredit: '250' };

describe('reading a served unit', () => {
  it('accepts a denomination the formatter can render with', () => {
    expect(isReadableDenomination(PLACEHOLDER)).toBe(true);
  });

  it('refuses a missing or malformed one, so the panel never guesses a scale', () => {
    expect(isReadableDenomination(undefined)).toBe(false);
    expect(isReadableDenomination(null)).toBe(false);
    expect(isReadableDenomination({ currency: 'XTS', microPerCredit: '0' })).toBe(false);
    expect(isReadableDenomination({ currency: 'XTS', microPerCredit: '2.5' })).toBe(false);
    expect(isReadableDenomination({ currency: 'money', microPerCredit: '250' })).toBe(false);
  });
});

describe('labelling a credit figure', () => {
  it('uses the singular for one credit and for less than one', () => {
    expect(withCreditUnit('1')).toBe('1 credit');
    expect(withCreditUnit('-1')).toBe('-1 credit');
    expect(withCreditUnit('<1')).toBe('<1 credit');
    expect(withCreditUnit('-<1')).toBe('-<1 credit');
  });

  it('uses the plural otherwise, including zero', () => {
    expect(withCreditUnit('0')).toBe('0 credits');
    expect(withCreditUnit('2,449')).toBe('2,449 credits');
  });

  it('passes a missing figure through as missing', () => {
    expect(withCreditUnit(null)).toBeNull();
  });
});
