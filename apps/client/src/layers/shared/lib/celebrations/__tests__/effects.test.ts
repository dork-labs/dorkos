import { describe, it, expect } from 'vitest';

import { RADIAL_GLOW_STYLE, MINI_SPRING_CONFIG, SHIMMER_STYLE } from '../effects';

describe('style constants', () => {
  it('RADIAL_GLOW_STYLE has radial gradient background', () => {
    expect(RADIAL_GLOW_STYLE.background).toContain('radial-gradient');
    expect(RADIAL_GLOW_STYLE.background).toContain('255,215,0');
  });

  it('MINI_SPRING_CONFIG has spring type with stiffness/damping', () => {
    expect(MINI_SPRING_CONFIG.type).toBe('spring');
    expect(MINI_SPRING_CONFIG.stiffness).toBe(400);
    expect(MINI_SPRING_CONFIG.damping).toBe(10);
  });

  it('SHIMMER_STYLE has linear gradient and 200% size', () => {
    expect(SHIMMER_STYLE.backgroundImage).toContain('linear-gradient');
    expect(SHIMMER_STYLE.backgroundSize).toBe('200% 100%');
  });
});
