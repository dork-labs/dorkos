import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveStreamdownAnimation,
  useTextEffectConfig,
  DEFAULT_TEXT_EFFECT,
} from '../text-effects';
import type { TextEffectConfig } from '../text-effects';

describe('resolveStreamdownAnimation', () => {
  it('returns false for mode none', () => {
    expect(resolveStreamdownAnimation({ mode: 'none' })).toBe(false);
  });

  it('maps blur-in to blurIn animation', () => {
    const result = resolveStreamdownAnimation({ mode: 'blur-in' });
    expect(result).toEqual({
      animation: 'blurIn',
      duration: 150,
      easing: 'ease-out',
      sep: 'word',
    });
  });

  it('maps fade to fadeIn animation', () => {
    const result = resolveStreamdownAnimation({ mode: 'fade' });
    expect(result).toEqual({
      animation: 'fadeIn',
      duration: 150,
      easing: 'ease-out',
      sep: 'word',
    });
  });

  it('maps slide-up to slideUp animation', () => {
    const result = resolveStreamdownAnimation({ mode: 'slide-up' });
    expect(result).toEqual({
      animation: 'slideUp',
      duration: 150,
      easing: 'ease-out',
      sep: 'word',
    });
  });

  it('uses provided duration/easing/sep overrides', () => {
    const config: TextEffectConfig = {
      mode: 'blur-in',
      duration: 300,
      easing: 'linear',
      sep: 'char',
    };
    const result = resolveStreamdownAnimation(config);
    expect(result).toEqual({
      animation: 'blurIn',
      duration: 300,
      easing: 'linear',
      sep: 'char',
    });
  });
});

describe('useTextEffectConfig', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('returns mode none when prefers-reduced-motion matches', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const result = useTextEffectConfig(DEFAULT_TEXT_EFFECT);
    expect(result.mode).toBe('none');
  });

  it('returns preferred config when reduced motion is not active', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const result = useTextEffectConfig(DEFAULT_TEXT_EFFECT);
    expect(result.mode).toBe('blur-in');
  });
});
