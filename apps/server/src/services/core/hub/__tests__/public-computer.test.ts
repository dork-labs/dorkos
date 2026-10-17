/**
 * The rules a public-computer sign-in follows (`public-computer.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  asksForPublicComputer,
  PUBLIC_COMPUTER_LIFETIME_MS,
  PUBLIC_COMPUTER_MARKER,
  publicComputerSessionExpired,
} from '../public-computer.js';

describe('a public-computer sign-in', () => {
  it('is asked for only by the exact marker', () => {
    expect(asksForPublicComputer(`a=1; ${PUBLIC_COMPUTER_MARKER}=1`)).toBe(true);
    for (const header of [
      undefined,
      '',
      `${PUBLIC_COMPUTER_MARKER}=0`,
      'dorkos-public-computer=1',
      `x${PUBLIC_COMPUTER_MARKER}=1`,
    ]) {
      expect(asksForPublicComputer(header), String(header)).toBe(false);
    }
  });

  it('outlives no working day, and an ordinary session is not held to that', () => {
    const now = Date.parse('2026-11-03T20:00:00Z');
    const old = new Date(now - PUBLIC_COMPUTER_LIFETIME_MS - 1);
    const fresh = new Date(now - 60_000);
    expect(publicComputerSessionExpired({ publicComputer: true, createdAt: old }, now)).toBe(true);
    expect(publicComputerSessionExpired({ publicComputer: true, createdAt: fresh }, now)).toBe(
      false
    );
    expect(publicComputerSessionExpired({ publicComputer: false, createdAt: old }, now)).toBe(
      false
    );
  });
});
