import { describe, expect, it } from 'vitest';
import { relayStartsEnabled } from '../relay-state.js';

describe('relayStartsEnabled', () => {
  it('follows the saved setting both ways when no override is set, as on a CLI or desktop install', () => {
    expect(relayStartsEnabled(undefined, true)).toBe(true);
    expect(relayStartsEnabled(undefined, false)).toBe(false);
  });

  it('lets a set DORKOS_RELAY_ENABLED win over the setting in both directions', () => {
    expect(relayStartsEnabled(false, true)).toBe(false);
    expect(relayStartsEnabled(true, false)).toBe(true);
  });
});
