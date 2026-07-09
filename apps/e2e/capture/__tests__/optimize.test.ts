import { describe, it, expect } from 'vitest';
import { assertAspectMatches } from '../optimize.js';

/**
 * Unit tests for the aspect-ratio guard that keeps human overrides from being
 * silently cropped or stretched to a mismatched frame.
 *
 * @module capture/__tests__/optimize
 */
describe('assertAspectMatches', () => {
  it('accepts an exact aspect match', () => {
    expect(() =>
      assertAspectMatches('cockpit', { width: 1280, height: 800 }, { width: 2560, height: 1600 })
    ).not.toThrow();
  });

  it('accepts a match within the 1% tolerance', () => {
    // 2565×1600 ≈ 1.603:1 vs 1.6:1 target — under 1% drift.
    expect(() =>
      assertAspectMatches('cockpit', { width: 2565, height: 1600 }, { width: 2560, height: 1600 })
    ).not.toThrow();
  });

  it('rejects a mismatched aspect with an actionable message', () => {
    expect(() =>
      assertAspectMatches('cockpit', { width: 1600, height: 1600 }, { width: 2560, height: 1600 })
    ).toThrowError(/wrong aspect ratio.*will not crop it/s);
  });

  it('rejects a portrait source for a landscape frame', () => {
    expect(() =>
      assertAspectMatches('topology', { width: 800, height: 1280 }, { width: 1280, height: 800 })
    ).toThrowError(/aspect ratio/);
  });
});
