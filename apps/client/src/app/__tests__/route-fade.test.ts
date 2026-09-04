import { describe, expect, it } from 'vitest';
import { shouldFadeRoute } from '../route-fade';

describe('shouldFadeRoute', () => {
  it('fades when the reader has not asked for less motion', () => {
    expect(shouldFadeRoute(false)).toBe(true);
  });

  it('is a hard off under reduced motion', () => {
    expect(shouldFadeRoute(true)).toBe(false);
  });
});
