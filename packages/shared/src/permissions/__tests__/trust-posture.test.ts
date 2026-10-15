import { describe, it, expect } from 'vitest';
import { trustPosture } from '../trust-posture.js';

describe('trustPosture', () => {
  it('is careful only for an install that chose Careful', () => {
    expect(trustPosture('careful')).toBe('careful');
  });

  it('is trusted for every other stored preset, chosen or not', () => {
    expect(trustPosture('balanced')).toBe('trusted');
    expect(trustPosture('full')).toBe('trusted');
    expect(trustPosture(null)).toBe('trusted');
    expect(trustPosture(undefined)).toBe('trusted');
  });
});
